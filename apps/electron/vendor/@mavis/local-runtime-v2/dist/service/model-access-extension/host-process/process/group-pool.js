import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { observeModelAccessWork } from '../../core/settlement.js';
import { launchModelAccessHost } from './launcher.js';
import { slotPeer } from './slot-peer.js';
/**
 * Shared processes for one trust group (`official`, `user`, `dev`).
 *
 * The supervisor keeps its per-installation lifecycle (candidate -> commit -> retiring). With a
 * pool, each of those "hosts" is a slot of the group's process rather than a process of its own:
 * activation loads the extension into the group process, retirement unloads it once its leases
 * drain, and the process exits when its last slot is gone. An update loads the new version into
 * the same process under a new slot; running calls keep the old slot until they finish.
 *
 * One extension crashing the process takes its group down (every slot sees an unexpected exit
 * and recovers through the supervisor's backoff); other groups are separate processes. When the
 * process names the slot that crashed it, every other slot's exit says it was a bystander, so
 * only the crashing extension uses up its restarts.
 */
export class ModelAccessHostGroupPool {
    groups = new Map();
    /** Loads one extension into its group's process; starts the process when needed. */
    async launch(options) {
        const group = options.group ?? 'official';
        // A process keeps the network environment (proxy, CA) it started with: a moved proxy sends
        // new slots to a new process while the old one drains.
        const key = `${group}:${environmentKey(options)}`;
        for (;;) {
            let process = this.groups.get(key);
            if (!process || process.dead) {
                process = new GroupProcess(group, options, () => {
                    if (this.groups.get(key) === process)
                        this.groups.delete(key);
                });
                this.groups.set(key, process);
            }
            try {
                return await process.load(options);
            }
            catch (error) {
                // The process died between selection and load: start a fresh one for this group.
                if (process.dead && !(error instanceof SlotLoadError))
                    continue;
                throw error instanceof SlotLoadError ? error.cause : error;
            }
        }
    }
    /** Live group processes (diagnostics/tests). */
    processes() {
        return [...this.groups.values()]
            .filter((process) => !process.dead)
            .map((process) => ({ group: process.group, pid: process.pid, slots: process.slotCount }));
    }
}
function environmentKey(options) {
    const env = options.environment ?? {};
    const entries = Object.entries(env)
        .filter(([, value]) => value !== undefined)
        .sort(([a], [b]) => a.localeCompare(b, 'en'));
    return createHash('sha256')
        .update(JSON.stringify([options.execPath, options.nodeArgs, options.entryPath, entries]))
        .digest('hex')
        .slice(0, 16);
}
class SlotLoadError extends Error {
    cause;
    constructor(cause) {
        super(cause instanceof Error ? cause.message : 'host_activation_failed');
        this.cause = cause;
    }
}
class GroupProcess {
    group;
    options;
    forget;
    started;
    slots = new Set();
    pendingLoads = 0;
    stopping;
    dead = false;
    constructor(group, options, forget) {
        this.group = group;
        this.options = options;
        this.forget = forget;
    }
    get pid() {
        return this.handle?.child.pid;
    }
    get slotCount() {
        return this.slots.size;
    }
    handle;
    async load(options) {
        this.pendingLoads += 1;
        try {
            const process = await this.start();
            const slot = randomUUID();
            const timeoutMs = options.startupTimeoutMs ?? 10_000;
            try {
                await process.peer.request('init', { moduleUrl: options.moduleUrl, manifest: options.manifest }, { timeoutMs, slot });
            }
            catch (error) {
                if (process.peer.closed) {
                    this.markDead();
                    throw error;
                }
                throw new SlotLoadError(error);
            }
            this.slots.add(slot);
            return this.slotHandle(process, slot);
        }
        finally {
            this.pendingLoads -= 1;
            // Only a failed load can leave the process empty; a loaded slot keeps it alive.
            observeModelAccessWork(this.stopIfEmpty() ?? Promise.resolve());
        }
    }
    start() {
        this.started ??= (async () => {
            // The group process loads no extension at launch; each slot is loaded with `init`.
            // The shared process is not tied to one package: run it in the data root.
            const cwd = this.options.dataDir ? path.dirname(this.options.dataDir) : this.options.cwd;
            const handle = await launchModelAccessHost({
                ...this.options,
                ...(cwd ? { cwd } : {}),
                groupProcess: true,
            });
            this.handle = handle;
            observeModelAccessWork((async () => {
                await handle.exit;
                this.markDead();
            })());
            return handle;
        })();
        return this.startedOrDead(this.started);
    }
    async startedOrDead(started) {
        try {
            return await started;
        }
        catch (error) {
            this.markDead();
            throw error;
        }
    }
    markDead() {
        if (this.dead)
            return;
        this.dead = true;
        this.forget();
    }
    slotHandle(process, slot) {
        const peer = slotPeer(process.peer, slot);
        let released;
        const unloaded = new Promise((resolve) => {
            observeModelAccessWork((async () => {
                const exit = await process.exit;
                const crashed = process.peer.crashedSlot;
                resolve(crashed !== undefined && crashed !== slot ? { ...exit, bystander: true } : exit);
            })());
            this.onUnload.set(slot, resolve);
        });
        const slotPeerView = {
            ...peer,
            get epoch() {
                return process.peer.epoch;
            },
            get closed() {
                return process.peer.closed || released !== undefined;
            },
            request: (method, params, options = {}) => {
                // Drain and shutdown address the slot, never the shared process.
                if (method === 'shutdown')
                    return Promise.resolve(null);
                return peer.request(method, params, options);
            },
            subscribeFlow: (flowRef, listener) => peer.subscribeFlow(flowRef, listener),
        };
        return {
            // Generation identity per slot: an update in the same process is still a new host epoch.
            // The wire epoch (peer.epoch) stays the process's.
            epoch: `${process.epoch}:${slot}`,
            child: process.child,
            peer: slotPeerView,
            exit: unloaded,
            stop: () => {
                // A failed stop is not kept: the next stop tries again.
                released ??= (async () => {
                    try {
                        return await this.unload(process, slot);
                    }
                    catch (error) {
                        released = undefined;
                        throw error;
                    }
                })();
                return released;
            },
        };
    }
    onUnload = new Map();
    async unload(process, slot) {
        if (!process.peer.closed) {
            try {
                await process.peer.request('unload', {}, { slot, timeoutMs: 5_000 });
            }
            catch {
                /* A slot that cannot unload is reclaimed with its process. */
            }
        }
        this.slots.delete(slot);
        const exit = { code: 0, signal: null };
        this.onUnload.get(slot)?.(exit);
        this.onUnload.delete(slot);
        await this.stopIfEmpty();
        return exit;
    }
    stopIfEmpty() {
        if (this.slots.size > 0 || this.pendingLoads > 0 || !this.handle)
            return undefined;
        this.markDead();
        const handle = this.handle;
        this.stopping ??= (async () => {
            try {
                return await handle.stop();
            }
            catch (error) {
                this.stopping = undefined;
                throw error;
            }
        })();
        return this.stopping;
    }
}
//# sourceMappingURL=group-pool.js.map