import { watch } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { deferred, settleInBackground, waitUntilSettledOrDeadline, } from '../../plugin-system-helpers.js';
const DEFAULT_DEBOUNCE_MS = 150;
const EVENT_DELIVERY_GRACE_MS = 20;
const DEFAULT_ADMISSION_WAIT_TIMEOUT_MS = 20_000;
/**
 * Coalesces external changes below `<dataDir>/plugins` into one runtime rebuild.
 * @internal Exported for focused watcher tests; owners use `createLocalPluginDirectoryWatcher`.
 */
export class LocalPluginDirectoryWatcher {
    root;
    onChange;
    debounceMs;
    admissionWaitTimeoutMs;
    watcher;
    timer;
    idle;
    requestedGeneration = 0;
    running = false;
    closed = false;
    constructor(root, onChange, debounceMs = DEFAULT_DEBOUNCE_MS, admissionWaitTimeoutMs = DEFAULT_ADMISSION_WAIT_TIMEOUT_MS) {
        this.root = root;
        this.onChange = onChange;
        this.debounceMs = debounceMs;
        this.admissionWaitTimeoutMs = admissionWaitTimeoutMs;
    }
    async start() {
        if (this.watcher || this.closed)
            return;
        try {
            await mkdir(this.root, { recursive: true });
            if (this.closed)
                return;
            this.watcher = this.createWatcher(this.root, () => this.markChanged());
        }
        catch {
            // Native watching is an optimization. Explicit Marketplace refresh and
            // mutation APIs remain available when the platform cannot create it.
            return;
        }
        // A watcher error must not surface as an uncaught EventEmitter error and
        // terminate the Desktop process. Keep the last published snapshot; the
        // explicit Marketplace refresh remains the recovery path.
        this.watcher.on('error', () => {
            this.watcher?.close();
            this.watcher = undefined;
            if (this.timer)
                clearTimeout(this.timer);
            this.timer = undefined;
            if (!this.running)
                this.settleIdle();
        });
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
        this.watcher?.close();
        this.watcher = undefined;
        if (this.timer)
            clearTimeout(this.timer);
        this.timer = undefined;
        if (!this.running)
            this.settleIdle();
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
/** Watches `<dataDir>/plugins` unless the owner supplies its own watcher (test seam). */
export function createLocalPluginDirectoryWatcher(owner, onChange) {
    return owner.localDirectoryWatcherFactory
        ? owner.localDirectoryWatcherFactory(onChange)
        : new LocalPluginDirectoryWatcher(path.join(owner.dataDir, 'plugins'), onChange);
}
//# sourceMappingURL=local-directory-watcher.js.map