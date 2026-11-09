import { randomUUID } from 'node:crypto';
import { observeModelAccessWork } from '../../core/settlement.js';
import { launchModelAccessHost, ModelAccessHostStartupError } from './launcher.js';
export class ModelAccessHostSupervisor {
    options;
    current = new Map();
    hosts = new Set();
    candidates = new Map();
    activationQueues = new Map();
    revisions = new Map();
    deactivations = new Map();
    maxHosts;
    closed = false;
    closing;
    constructor(options = {}) {
        this.options = options;
        this.maxHosts = options.maxHosts ?? 16;
        if (!Number.isSafeInteger(this.maxHosts) || this.maxHosts < 1)
            throw new Error('host_limit_invalid');
        for (const timeout of [
            options.retireTimeoutMs,
            options.drainTimeoutMs,
            options.shutdownDrainTimeoutMs,
        ]) {
            if (timeout !== undefined &&
                (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 2_147_483_647))
                throw new Error('host_timeout_invalid');
        }
    }
    async stage(input) {
        this.assertOpen();
        const id = input.installationId;
        if (this.deactivations.has(id))
            throw new Error('host_deactivating');
        if (this.candidates.has(id))
            throw new Error('host_candidate_limit');
        const retiring = this.idleRetiring(id);
        const pending = [...this.candidates.keys()].filter((key) => ![...this.hosts].some((host) => host.input.installationId === key && host.role === 'candidate')).length;
        if (this.hosts.size + pending - (retiring ? 1 : 0) >= this.maxHosts)
            throw new Error('host_global_limit');
        const revision = this.revisions.get(id);
        const ready = (async () => {
            if (retiring)
                await this.stop(retiring);
            this.assertOpen();
            if (revision !== this.revisions.get(id))
                throw new Error('host_candidate_cancelled');
            const handle = this.options.groupPool
                ? await this.launchSlot(input)
                : await launchModelAccessHost({ ...input, epoch: randomUUID() });
            const active = {
                input,
                handle,
                holds: 0,
                role: 'candidate',
                expectedExit: false,
                controller: new AbortController(),
            };
            this.hosts.add(active);
            observeModelAccessWork((async () => this.onHostExit(active, await handle.exit))());
            return active;
        })();
        const slot = { ready, cancelled: false };
        this.candidates.set(id, slot);
        let active;
        let lease;
        try {
            active = await ready;
            lease = await this.admitCandidate(active, slot);
        }
        catch (error) {
            if (this.candidates.get(id) === slot)
                this.candidates.delete(id);
            throw error;
        }
        let committed = false;
        let discarded = false;
        return {
            lease,
            assertCurrent: () => {
                this.assertOpen();
                if (committed || discarded || slot.cancelled || this.candidates.get(id) !== slot)
                    throw new Error('host_candidate_stale');
                lease.assertCurrent();
                if (this.hasRetiring(id))
                    throw new Error('host_retiring_limit');
            },
            commit: () => {
                if (committed || discarded || slot.cancelled || this.closed)
                    return;
                const previous = this.current.get(id);
                committed = true;
                this.candidates.delete(id);
                active.role = 'current';
                this.current.set(id, active);
                if (previous)
                    this.retire(previous);
                const exit = active.exit;
                if (exit)
                    queueMicrotask(() => this.onHostExit(active, exit));
            },
            discard: async () => {
                if (committed)
                    throw new Error('host_candidate_committed');
                discarded = true;
                slot.cancelled = true;
                await this.stop(active, true);
                if (this.candidates.get(id) === slot)
                    this.candidates.delete(id);
                await lease.release();
            },
        };
    }
    async activate(input) {
        this.assertOpen();
        const id = input.installationId;
        const revision = this.revisions.get(id);
        const previous = this.activationQueues.get(id) ?? Promise.resolve();
        const operation = (async () => {
            try {
                await previous;
            }
            catch {
                /* Failed activation does not block the next one. */
            }
            if (revision !== this.revisions.get(id))
                throw new Error('host_candidate_cancelled');
            const candidate = await this.stage(input);
            try {
                candidate.assertCurrent();
                candidate.commit();
                return candidate.lease;
            }
            catch (error) {
                await candidate.discard();
                throw error;
            }
        })();
        this.activationQueues.set(id, operation);
        try {
            return await operation;
        }
        finally {
            if (this.activationQueues.get(id) === operation)
                this.activationQueues.delete(id);
        }
    }
    acquire(installationId) {
        this.assertOpen();
        const active = this.current.get(installationId);
        if (!active)
            throw new Error('host_unavailable');
        return this.retain(active);
    }
    /**
     * Stop serving new work without cutting running calls: the current host retires and exits once
     * its leases drain (or the retire timeout passes). A pending candidate is cancelled.
     */
    retireCurrent(installationId) {
        this.revisions.set(installationId, (this.revisions.get(installationId) ?? 0) + 1);
        const candidate = this.candidates.get(installationId);
        if (candidate) {
            candidate.cancelled = true;
            observeModelAccessWork(this.stopCandidate(candidate));
        }
        const active = this.current.get(installationId);
        this.current.delete(installationId);
        if (active)
            this.retire(active);
    }
    deactivate(installationId) {
        const existing = this.deactivations.get(installationId);
        if (existing)
            return existing;
        this.revisions.set(installationId, (this.revisions.get(installationId) ?? 0) + 1);
        const candidate = this.candidates.get(installationId);
        if (candidate)
            candidate.cancelled = true;
        this.current.delete(installationId);
        const operation = (async () => {
            const stopping = [...this.hosts]
                .filter((host) => host.input.installationId === installationId)
                .map((host) => this.stop(host, true));
            if (candidate)
                stopping.push(this.stopCandidate(candidate));
            const results = await Promise.allSettled(stopping);
            const failures = results.filter((result) => result.status === 'rejected');
            if (failures.length)
                throw new AggregateError(failures.map((result) => result.reason), 'host_exit_unconfirmed');
            if (this.candidates.get(installationId) === candidate)
                this.candidates.delete(installationId);
        })();
        this.deactivations.set(installationId, operation);
        observeModelAccessWork((async () => {
            try {
                await operation;
            }
            finally {
                if (this.deactivations.get(installationId) === operation)
                    this.deactivations.delete(installationId);
            }
        })());
        return operation;
    }
    close() {
        if (this.closing)
            return this.closing;
        this.closed = true;
        const ids = new Set([...this.hosts].map((host) => host.input.installationId));
        for (const id of this.candidates.keys())
            ids.add(id);
        this.closing = (async () => {
            const results = await Promise.allSettled([...ids].map((id) => this.deactivate(id)));
            const failures = results.filter((result) => result.status === 'rejected');
            if (failures.length)
                throw new AggregateError(failures.map((result) => result.reason), 'host_exit_unconfirmed');
        })();
        observeModelAccessWork((async () => {
            try {
                await this.closing;
            }
            catch {
                this.closing = undefined;
            }
        })());
        return this.closing;
    }
    retain(active) {
        if (active.controller.signal.aborted || active.handle.peer.closed)
            throw new Error('host_unavailable');
        active.holds += 1;
        let released = false;
        const assertCurrent = () => {
            if (released || active.controller.signal.aborted || active.handle.peer.closed)
                throw new Error('host_unavailable');
        };
        return {
            installationId: active.input.installationId,
            packageGeneration: active.input.packageGeneration,
            epoch: active.handle.epoch,
            peer: active.handle.peer,
            signal: active.controller.signal,
            assertCurrent,
            retain: () => {
                assertCurrent();
                return this.retain(active);
            },
            release: async () => {
                if (released)
                    return;
                released = true;
                active.holds -= 1;
                if (active.role === 'retiring' && active.holds === 0)
                    await this.stop(active);
            },
        };
    }
    async admitCandidate(active, slot) {
        try {
            if (this.closed || slot.cancelled)
                throw new Error('host_candidate_cancelled');
            return this.retain(active);
        }
        catch (error) {
            await this.stop(active, true);
            throw error;
        }
    }
    async stopCandidate(candidate) {
        let active;
        try {
            active = await candidate.ready;
        }
        catch (error) {
            if (error instanceof ModelAccessHostStartupError)
                return;
            throw error;
        }
        await this.stop(active, true);
    }
    hasRetiring(id) {
        return [...this.hosts].some((host) => host.input.installationId === id && host.role === 'retiring');
    }
    idleRetiring(id) {
        const retiring = [...this.hosts].find((host) => host.input.installationId === id && host.role === 'retiring');
        if (retiring && retiring.holds > 0)
            throw new Error('host_retiring_limit');
        return retiring;
    }
    retire(active) {
        active.role = 'retiring';
        active.retireTimer = setTimeout(() => {
            observeModelAccessWork(this.stop(active, true));
        }, this.options.retireTimeoutMs ?? 10 * 60_000);
        active.retireTimer.unref?.();
        if (active.holds === 0)
            observeModelAccessWork(this.stop(active));
    }
    stop(active, force = false) {
        active.expectedExit = true;
        active.controller.abort();
        if (active.retireTimer)
            clearTimeout(active.retireTimer);
        const terminate = async (timeoutMs) => {
            await this.drain(active, timeoutMs);
            await active.handle.stop();
            this.hosts.delete(active);
        };
        if (force) {
            active.forcedStop ??= (async () => {
                try {
                    await terminate(this.options.shutdownDrainTimeoutMs ?? 1_000);
                }
                catch (error) {
                    active.forcedStop = undefined;
                    throw error;
                }
            })();
            return active.forcedStop;
        }
        active.stop ??= (async () => {
            try {
                await terminate(this.options.drainTimeoutMs ?? 30_000);
            }
            catch (error) {
                active.stop = undefined;
                throw error;
            }
        })();
        return active.stop;
    }
    async drain(active, timeoutMs) {
        if (active.handle.peer.closed)
            return;
        let timer;
        try {
            await Promise.race([
                active.handle.peer.request('drain', {}, { timeoutMs }),
                new Promise((resolve) => {
                    timer = setTimeout(resolve, timeoutMs);
                }),
            ]);
        }
        catch {
            /* A failed drain does not waive exit confirmation. */
        }
        finally {
            if (timer)
                clearTimeout(timer);
        }
    }
    onHostExit(active, exit) {
        active.exit = exit;
        active.controller.abort();
        if (this.current.get(active.input.installationId) === active)
            this.current.delete(active.input.installationId);
        if (!active.expectedExit && !active.exitNotified && active.role === 'current') {
            active.exitNotified = true;
            try {
                observeModelAccessWork(Promise.resolve(this.options.onUnexpectedExit?.({
                    installationId: active.input.installationId,
                    packageGeneration: active.input.packageGeneration,
                    epoch: active.handle.epoch,
                    role: active.role,
                    exit,
                })));
            }
            catch {
                /* Observers cannot prevent host invalidation. */
            }
        }
        if (active.role !== 'candidate' && !active.expectedExit)
            observeModelAccessWork(this.stop(active, true));
    }
    async launchSlot(input) {
        try {
            return await this.options.groupPool.launch(input);
        }
        catch (error) {
            throw error instanceof ModelAccessHostStartupError
                ? error
                : new ModelAccessHostStartupError(error);
        }
    }
    assertOpen() {
        if (this.closed)
            throw new Error('host_supervisor_closed');
    }
}
//# sourceMappingURL=supervisor.js.map