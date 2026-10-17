import { PluginSystemError } from '../../errors.js';
const DEFAULT_AUTH_BARRIER_TIMEOUT_MS = 5_000;
export function resolveOfficialPluginAuthState(auth) {
    if (auth?.authState === 'pending')
        return 'pending';
    if (auth?.authState === 'logged_out')
        return 'logged_out';
    if (auth?.accessToken?.trim() && auth.realUserID?.trim())
        return 'ready';
    // CLI/TUI snapshots predate Electron's propagation state. Preserve their
    // original logged-out behavior instead of treating a missing optional field
    // as an in-flight Renderer -> Main -> Utility rotation.
    return auth?.authState === 'authenticated' ? 'pending' : 'logged_out';
}
/**
 * Bridges asynchronous Renderer -> Main -> Utility auth propagation for
 * user-triggered official Plugin mutations without delaying global login.
 */
export class OfficialPluginAuthBarrier {
    options;
    waiters = new Set();
    disposed = false;
    constructor(options) {
        this.options = options;
    }
    async waitUntilReady() {
        const startedAt = Date.now();
        if (this.disposed)
            return this.finish(startedAt, 'disposed', 'disposed');
        const initialOutcome = this.currentAuthOutcome();
        if (initialOutcome) {
            return this.finishAuthOutcome(startedAt, initialOutcome, 'immediate');
        }
        const deadline = startedAt + (this.options.timeoutMs ?? DEFAULT_AUTH_BARRIER_TIMEOUT_MS);
        while (!this.disposed) {
            const remainingMs = deadline - Date.now();
            if (remainingMs <= 0)
                return this.finish(startedAt, 'timeout', 'timeout');
            const wakeReason = await this.waitForChange(remainingMs);
            if (wakeReason === 'disposed')
                return this.finish(startedAt, 'disposed', 'disposed');
            if (wakeReason === 'timeout')
                return this.finish(startedAt, 'timeout', 'timeout');
            const outcome = this.currentAuthOutcome();
            if (outcome) {
                return this.finishAuthOutcome(startedAt, outcome, 'waited');
            }
        }
        return this.finish(startedAt, 'disposed', 'disposed');
    }
    authContextChanged() {
        this.wakeAll('changed');
    }
    dispose() {
        if (this.disposed)
            return;
        this.disposed = true;
        this.wakeAll('disposed');
    }
    waitForChange(timeoutMs) {
        return new Promise((resolve) => {
            let settled = false;
            const finish = (reason) => {
                if (settled)
                    return;
                settled = true;
                clearTimeout(timer);
                this.waiters.delete(finish);
                resolve(reason);
            };
            const timer = setTimeout(() => finish('timeout'), timeoutMs);
            timer.unref?.();
            this.waiters.add(finish);
            // Close the subscribe/check race: auth may become ready immediately
            // before this waiter is registered, without another change event.
            if (this.disposed)
                finish('disposed');
            else if (this.options.isReady() || this.options.isLoggedOut?.())
                finish('changed');
        });
    }
    wakeAll(reason) {
        for (const waiter of [...this.waiters])
            waiter(reason);
    }
    currentAuthOutcome() {
        if (this.options.isReady())
            return 'ready';
        return this.options.isLoggedOut?.() ? 'logged_out' : undefined;
    }
    finishAuthOutcome(startedAt, outcome, readyResult) {
        return this.finish(startedAt, outcome === 'ready' ? readyResult : 'logged_out', outcome);
    }
    finish(startedAt, result, outcome) {
        const tags = { result };
        this.options.metrics?.incr('plugin_official_auth_barrier_total', tags);
        this.options.metrics?.latency('plugin_official_auth_barrier_wait_duration_ms', Date.now() - startedAt, tags);
        return outcome;
    }
}
async function prepareOfficialFull(input) {
    if (!input.reconciler)
        return undefined;
    if (input.reconciler.prepareReconcile) {
        return input.reconciler.prepareReconcile(input.scope, input.shouldCommit, input.signal);
    }
    await input.reconciler.reconcile(input.scope, input.shouldCommit);
    return undefined;
}
export async function prepareOfficialFullState(input) {
    if (!input.scope || !input.reconciler)
        return undefined;
    const startedAt = Date.now();
    try {
        const prepared = await prepareOfficialFull({
            reconciler: input.reconciler,
            scope: input.scope,
            shouldCommit: input.isCurrentScope,
            signal: input.signal,
        });
        if (input.isCurrentScope()) {
            input.record('success', startedAt);
            return prepared;
        }
        await prepared?.abort();
        input.record('superseded', startedAt);
        return undefined;
    }
    catch (error) {
        input.record('error', startedAt);
        if (input.trigger !== 'startup')
            throw error;
        input.scheduleRecovery();
        return undefined;
    }
}
export function handleIncompleteOfficialSync(input) {
    if (input.trigger === 'startup') {
        input.scheduleRecovery();
        return;
    }
    throw new PluginSystemError('OFFICIAL_SYNC_INCOMPLETE', `official Plugin sync could not prepare ${input.failedPackageCount} package(s)`);
}
export async function decidePreparedOfficialSync(input) {
    if (input.unavailable) {
        await input.prepared?.abort();
        return 'complete';
    }
    if (input.prepared && input.revisionChanged) {
        await input.prepared.abort();
        return 'retry';
    }
    if (!input.forcePublication &&
        input.cachedRestoreCurrent &&
        (!input.prepared || !input.prepared.changed)) {
        await input.prepared?.abort();
        return 'complete';
    }
    return 'proceed';
}
export async function waitForOfficialPublication(input) {
    try {
        await input.completion;
        return 'complete';
    }
    catch (error) {
        if (isSuperseded(error) && input.requestedScopeKey === input.currentScopeKey())
            return 'retry';
        throw error;
    }
}
function isSuperseded(error) {
    return (typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'PUBLICATION_SUPERSEDED');
}
export async function prepareOfficialMutation(input) {
    if (!input.reconciler?.reconcileMutation) {
        throw new PluginSystemError('AUTH_REQUIRED', 'official Plugin mutation requires identity');
    }
    if (input.reconciler.prepareMutation) {
        return input.reconciler.prepareMutation(input.scope, input.mutation, input.shouldCommit, input.signal);
    }
    await input.reconciler.reconcileMutation(input.scope, input.mutation, input.shouldCommit);
    return undefined;
}
const DEFAULT_RECOVERY_DELAYS_MS = [30_000, 60_000, 120_000, 240_000, 300_000];
/** Owns bounded, scope-aware retry scheduling for authoritative full-state recovery. */
export class OfficialPluginRecovery {
    options;
    scopeKey = '';
    failureCount = 0;
    timer;
    activeScopes = new Set();
    rerunScopes = new Set();
    tasks = new Map();
    disposed = false;
    constructor(options) {
        this.options = options;
    }
    request(scopeKey) {
        if (!this.canRun(scopeKey))
            return;
        this.cancelDelay();
        if (this.activeScopes.has(scopeKey)) {
            this.rerunScopes.add(scopeKey);
            return;
        }
        this.start(scopeKey);
    }
    schedule(scopeKey) {
        if (!this.canRun(scopeKey))
            return;
        this.ensureScope(scopeKey);
        if (this.timer)
            return;
        const delays = this.delays();
        const delayMs = delays[Math.min(this.failureCount, delays.length - 1)] ?? 300_000;
        this.failureCount += 1;
        this.timer = setTimeout(() => {
            this.timer = undefined;
            this.start(scopeKey);
        }, delayMs);
        this.timer.unref?.();
    }
    succeeded(scopeKey) {
        if (!this.options.isCurrentScope(scopeKey))
            return;
        this.cancelDelay();
        this.scopeKey = scopeKey;
        this.failureCount = 0;
    }
    scopeChanged() {
        this.cancelDelay();
        this.rerunScopes.clear();
        this.scopeKey = '';
        this.failureCount = 0;
    }
    cancelDelay() {
        if (!this.timer)
            return;
        clearTimeout(this.timer);
        this.timer = undefined;
    }
    async dispose() {
        this.disposed = true;
        this.cancelDelay();
        this.rerunScopes.clear();
        await Promise.allSettled([...this.tasks.values()]);
    }
    start(scopeKey) {
        if (!this.canRun(scopeKey) || this.activeScopes.has(scopeKey))
            return;
        this.ensureScope(scopeKey);
        this.activeScopes.add(scopeKey);
        this.tasks.set(scopeKey, this.runAttempt(scopeKey));
    }
    async runAttempt(scopeKey) {
        try {
            await this.options.synchronize(scopeKey);
            this.succeeded(scopeKey);
        }
        catch {
            this.schedule(scopeKey);
        }
        finally {
            const rerun = this.rerunScopes.delete(scopeKey);
            this.activeScopes.delete(scopeKey);
            this.tasks.delete(scopeKey);
            if (rerun)
                this.request(scopeKey);
        }
    }
    canRun(scopeKey) {
        return !this.disposed && this.options.isCurrentScope(scopeKey);
    }
    ensureScope(scopeKey) {
        if (this.scopeKey === scopeKey)
            return;
        this.scopeChanged();
        this.scopeKey = scopeKey;
    }
    delays() {
        return this.options.delaysMs?.length ? this.options.delaysMs : DEFAULT_RECOVERY_DELAYS_MS;
    }
}
//# sourceMappingURL=official-operations.js.map