import { watch } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { settleInBackground } from '../../../../infra/async/settle.js';
import { isPathInside } from './workspace-path.js';
const DEBOUNCE_MS = 200;
const MAX_WAIT_MS = 1_000;
const HEARTBEAT_MS = 30_000;
/** Shared, non-recursive directory watches; the stream owns only its subscriptions. */
export class WorkspaceFileWatcher {
    directories = new Map();
    streams = new Set();
    open(targets) {
        return {
            [Symbol.asyncIterator]: () => {
                let closed = false;
                let ready = false;
                let initializing = true;
                let heartbeatPending = false;
                let wake;
                const changed = new Set();
                const unavailable = new Set();
                const releases = new Map();
                const timers = new Map();
                const binding = new Set();
                const rebind = new Set();
                const signal = () => {
                    wake?.();
                    wake = undefined;
                };
                const waitForFrame = () => new Promise((resolveNext) => {
                    wake = resolveNext;
                });
                const clearTimer = (index) => {
                    const timer = timers.get(index);
                    if (timer) {
                        clearTimeout(timer.delay);
                        clearTimeout(timer.max);
                        timers.delete(index);
                    }
                };
                const invalidate = (index) => {
                    if (closed)
                        return;
                    const flush = () => {
                        clearTimer(index);
                        changed.add(index);
                        signal();
                        settleInBackground(bind(index));
                    };
                    const current = timers.get(index);
                    if (current)
                        clearTimeout(current.delay);
                    timers.set(index, {
                        delay: setTimeout(flush, DEBOUNCE_MS),
                        max: current?.max ?? setTimeout(flush, MAX_WAIT_MS),
                    });
                };
                const bindOnce = async (index) => {
                    const nextReleases = [];
                    try {
                        const target = targets[index];
                        if (!target)
                            return;
                        const locations = await watchLocations(target);
                        if (closed)
                            return;
                        for (const location of locations) {
                            nextReleases.push(this.retain(location.directory, location.name, () => invalidate(index)));
                        }
                        releases.get(index)?.();
                        releases.set(index, () => nextReleases.forEach((release) => release()));
                        unavailable.delete(index);
                    }
                    catch {
                        nextReleases.forEach((release) => release());
                        releases.get(index)?.();
                        releases.delete(index);
                        if (!closed) {
                            unavailable.add(index);
                            signal();
                        }
                    }
                };
                const bind = async (index) => {
                    if (closed)
                        return;
                    if (binding.has(index)) {
                        rebind.add(index);
                        return;
                    }
                    binding.add(index);
                    try {
                        do {
                            rebind.delete(index);
                            await bindOnce(index);
                        } while (!closed && rebind.has(index));
                    }
                    finally {
                        binding.delete(index);
                    }
                };
                const recover = async (index) => {
                    await bind(index);
                    if (!closed && releases.has(index))
                        invalidate(index);
                };
                const heartbeat = setInterval(() => {
                    heartbeatPending = true;
                    // Retry unavailable subscriptions without polling file contents.
                    for (let index = 0; index < targets.length; index += 1) {
                        if (!releases.has(index))
                            settleInBackground(recover(index));
                    }
                    signal();
                }, HEARTBEAT_MS);
                heartbeat.unref?.();
                const close = () => {
                    if (closed)
                        return;
                    closed = true;
                    clearInterval(heartbeat);
                    for (const index of timers.keys())
                        clearTimer(index);
                    releases.forEach((release) => release());
                    releases.clear();
                    this.streams.delete(close);
                    signal();
                };
                this.streams.add(close);
                const initialize = async () => {
                    await Promise.all(targets.map((_, index) => bind(index)));
                    initializing = false;
                    ready = true;
                    signal();
                };
                settleInBackground(initialize());
                return {
                    next: async () => {
                        while (!closed) {
                            if (initializing) {
                                await waitForFrame();
                                continue;
                            }
                            if (ready) {
                                ready = false;
                                return {
                                    done: false,
                                    value: { kind: 'ready', indexes: [...releases.keys()].sort((a, b) => a - b) },
                                };
                            }
                            if (unavailable.size) {
                                const indexes = [...unavailable].sort((a, b) => a - b);
                                unavailable.clear();
                                return { done: false, value: { kind: 'unavailable', indexes } };
                            }
                            if (changed.size) {
                                const indexes = [...changed].sort((a, b) => a - b);
                                changed.clear();
                                return { done: false, value: { kind: 'changed', indexes } };
                            }
                            if (heartbeatPending) {
                                heartbeatPending = false;
                                return { done: false, value: { kind: 'heartbeat' } };
                            }
                            await waitForFrame();
                        }
                        return { done: true, value: undefined };
                    },
                    return: async () => {
                        close();
                        return { done: true, value: undefined };
                    },
                };
            },
        };
    }
    retain(directory, name, changed) {
        let entry = this.directories.get(directory);
        if (!entry) {
            const listeners = new Set();
            const watcher = watch(directory, { persistent: false }, (_event, filename) => {
                const actual = filename?.toString();
                for (const listener of listeners) {
                    if (!actual || sameName(actual, listener.name) || sameName(actual, basename(directory)))
                        listener.changed();
                }
            });
            entry = { watcher, listeners };
            this.directories.set(directory, entry);
            watcher.on('error', () => {
                if (this.directories.get(directory) === entry)
                    this.directories.delete(directory);
                watcher.close();
                for (const listener of listeners)
                    listener.changed();
            });
        }
        const listener = { name, changed };
        entry.listeners.add(listener);
        const retained = entry;
        return () => {
            retained.listeners.delete(listener);
            if (retained.listeners.size === 0) {
                retained.watcher.close();
                if (this.directories.get(directory) === retained)
                    this.directories.delete(directory);
            }
        };
    }
    close() {
        for (const close of this.streams)
            close();
    }
}
function sameName(left, right) {
    return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}
/** Same containment boundary as reads, including missing leaves and in-root links. */
async function watchLocations(target) {
    const { root, lexical } = await resolveWatchTarget(target);
    const { parent, directory } = await existingWatchDirectory(dirname(lexical));
    if (!isPathInside(root, directory) || !(await stat(directory)).isDirectory())
        throw new Error('Invalid target');
    const name = relative(parent, lexical).split(sep)[0] ?? '';
    const locations = [{ directory, name }];
    try {
        const realTarget = await realpath(lexical);
        if (!isPathInside(root, realTarget))
            throw new Error('Invalid target');
        if (dirname(realTarget) !== directory || basename(realTarget) !== name)
            locations.push({ directory: dirname(realTarget), name: basename(realTarget) });
    }
    catch (error) {
        if (error.code !== 'ENOENT')
            throw error;
    }
    return locations;
}
async function existingWatchDirectory(start) {
    let parent = start;
    for (;;) {
        try {
            return { parent, directory: await realpath(parent) };
        }
        catch (error) {
            if (error.code !== 'ENOENT' || parent === dirname(parent))
                throw error;
            parent = dirname(parent);
        }
    }
}
async function resolveWatchTarget(target) {
    if (!target.workspace.trim() || !target.path || /\0/u.test(target.path))
        throw new Error('Invalid target');
    const lexicalRoot = resolve(target.workspace);
    const root = await realpath(lexicalRoot);
    const lexical = isAbsolute(target.path)
        ? resolve(target.path)
        : resolve(lexicalRoot, target.path);
    if (!isPathInside(lexicalRoot, lexical) && !isPathInside(root, lexical))
        throw new Error('Invalid target');
    return { root, lexical };
}
//# sourceMappingURL=file-watch.js.map