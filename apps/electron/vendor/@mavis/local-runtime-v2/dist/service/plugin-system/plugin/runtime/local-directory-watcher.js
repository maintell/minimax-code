import { watch } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { deferred, settleInBackground, waitUntilSettledOrDeadline, } from '../../plugin-system-helpers.js';
const DEFAULT_DEBOUNCE_MS = 150;
const EVENT_DELIVERY_GRACE_MS = 20;
const DEFAULT_ADMISSION_WAIT_TIMEOUT_MS = 20_000;
/**
 * Coalesces external changes below `<dataDir>/plugins` and every linked root
 * into one runtime rebuild.
 * @internal Exported for focused watcher tests; owners use `createLocalPluginDirectoryWatcher`.
 */
export class LocalPluginDirectoryWatcher {
    roots;
    onChange;
    debounceMs;
    admissionWaitTimeoutMs;
    watchers = new Map();
    timer;
    idle;
    requestedGeneration = 0;
    running = false;
    started = false;
    closed = false;
    constructor(roots, onChange, debounceMs = DEFAULT_DEBOUNCE_MS, admissionWaitTimeoutMs = DEFAULT_ADMISSION_WAIT_TIMEOUT_MS) {
        this.roots = roots;
        this.onChange = onChange;
        this.debounceMs = debounceMs;
        this.admissionWaitTimeoutMs = admissionWaitTimeoutMs;
    }
    async start() {
        if (this.started || this.closed)
            return;
        this.started = true;
        try {
            await mkdir(this.roots.owned, { recursive: true });
        }
        catch {
            // Native watching is an optimization. Explicit Marketplace refresh and
            // mutation APIs remain available when the platform cannot create it.
        }
        await this.refreshRoots();
    }
    async refreshRoots() {
        if (!this.started || this.closed)
            return;
        let linked = [];
        try {
            linked = (await this.roots.linked?.()) ?? [];
        }
        catch {
            // An unreadable link registry leaves only the owned root watched.
        }
        if (this.closed)
            return;
        const desired = new Set([this.roots.owned, ...linked]);
        for (const [root, watcher] of this.watchers) {
            if (desired.has(root))
                continue;
            watcher.close();
            this.watchers.delete(root);
        }
        for (const root of desired) {
            if (!this.watchers.has(root))
                this.watchRoot(root);
        }
    }
    createWatcher(root, onChange) {
        return watch(root, { persistent: false, recursive: true }, onChange);
    }
    async whenIdle() {
        // A filesystem write can resolve before its native watch event is
        // delivered. Give the OS a short delivery window before observing `idle`
        // so a turn admitted immediately after Plugin Creator finishes sees the
        // resulting publication. The debounce wait is paid only after a change.
        await new Promise((resolve) => setTimeout(resolve, EVENT_DELIVERY_GRACE_MS));
        const idle = this.idle?.promise;
        if (idle)
            await waitUntilSettledOrDeadline(idle, this.admissionWaitTimeoutMs);
    }
    close() {
        if (this.closed)
            return;
        this.closed = true;
        for (const watcher of this.watchers.values())
            watcher.close();
        this.watchers.clear();
        if (this.timer)
            clearTimeout(this.timer);
        this.timer = undefined;
        if (!this.running)
            this.settleIdle();
    }
    watchRoot(root) {
        let watcher;
        try {
            watcher = this.createWatcher(root, () => this.markChanged());
        }
        catch {
            // A missing linked root is listed as unavailable; a later refresh retries.
            return;
        }
        this.watchers.set(root, watcher);
        // A watcher error must not surface as an uncaught EventEmitter error and
        // terminate the Desktop process. Keep the last published snapshot and the
        // other roots; the explicit Marketplace refresh remains the recovery path.
        watcher.on('error', () => {
            watcher.close();
            if (this.watchers.get(root) === watcher)
                this.watchers.delete(root);
            if (this.watchers.size === 0) {
                if (this.timer)
                    clearTimeout(this.timer);
                this.timer = undefined;
                if (!this.running)
                    this.settleIdle();
            }
        });
    }
    markChanged() {
        if (this.closed)
            return;
        this.requestedGeneration += 1;
        this.idle ??= deferred();
        this.schedule();
    }
    schedule() {
        if (this.closed)
            return;
        if (this.timer)
            clearTimeout(this.timer);
        this.timer = setTimeout(() => {
            this.timer = undefined;
            // The callback owns its fail-open boundary; the watcher must stay alive
            // after a malformed, partially-written custom Plugin is observed.
            settleInBackground(this.flushSafely());
        }, this.debounceMs);
    }
    async flushSafely() {
        try {
            await this.flush();
        }
        catch {
            // The next filesystem event retries after an incomplete external write.
        }
    }
    async flush() {
        if (this.closed || this.running)
            return;
        this.running = true;
        const generation = this.requestedGeneration;
        try {
            await this.onChange();
        }
        finally {
            this.running = false;
            if (!this.closed && generation !== this.requestedGeneration) {
                this.schedule();
            }
            else {
                this.settleIdle();
            }
        }
    }
    settleIdle() {
        this.idle?.resolve();
        this.idle = undefined;
    }
}
/**
 * Watches `<dataDir>/plugins` and every linked root unless the owner supplies
 * its own watcher (test seam).
 */
export function createLocalPluginDirectoryWatcher(owner, onChange, linked) {
    return owner.localDirectoryWatcherFactory
        ? owner.localDirectoryWatcherFactory(onChange)
        : new LocalPluginDirectoryWatcher({ owned: path.join(owner.dataDir, 'plugins'), ...(linked ? { linked } : {}) }, onChange);
}
//# sourceMappingURL=local-directory-watcher.js.map