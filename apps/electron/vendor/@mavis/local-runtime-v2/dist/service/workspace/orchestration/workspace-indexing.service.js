/** @internal Storage key shared by the V2 indexing adapter and its tests. */
export const WORKSPACE_INDEXING_ENABLED_PREFERENCE_KEY = 'workspace-indexing-enabled';
/**
 * V2 owner for workspace-indexing policy and lifecycle. The scanner/storage
 * worker sits behind a narrow injected port; HTTP and Turn lifecycle callers
 * only know this owner.
 */
export class WorkspaceIndexingServiceImpl {
    options;
    pendingPreferenceWrite = Promise.resolve();
    closed = false;
    generation = 0;
    constructor(options) {
        this.options = options;
    }
    async getPreference() {
        const forced = this.options.forced === true;
        const persisted = await this.options.preferences.get(WORKSPACE_INDEXING_ENABLED_PREFERENCE_KEY);
        return { enabled: forced || persisted === true, forced };
    }
    setEnabled(enabled) {
        if (this.closed)
            return Promise.reject(new Error('workspace_indexing_closed'));
        // Invalidate admitted reads immediately, including disable→enable races.
        if (!this.options.forced)
            this.generation += 1;
        const previous = this.pendingPreferenceWrite;
        const update = async () => {
            try {
                await previous;
            }
            catch {
                // A failed preference write must not block later user changes.
            }
            if (this.closed)
                throw new Error('workspace_indexing_closed');
            if (!this.options.forced) {
                await this.options.preferences.set(WORKSPACE_INDEXING_ENABLED_PREFERENCE_KEY, enabled);
                if (this.closed)
                    throw new Error('workspace_indexing_closed');
                if (!enabled)
                    this.options.worker?.closePrewarm();
            }
            return this.getPreference();
        };
        const pending = update();
        this.pendingPreferenceWrite = pending;
        return pending;
    }
    async prewarm(workspaceDir) {
        const generation = this.generation;
        const value = workspaceDir.trim();
        if (!value || this.closed)
            return;
        try {
            if (!(await this.getPreference()).enabled)
                return;
        }
        catch {
            // Indexing is a weak dependency; a preference read failure must not
            // turn workspace selection into a failed Desktop request.
            return;
        }
        // Prewarm is advisory. Consume failures here so an indexing outage never
        // turns the Desktop request into a process-level unhandled rejection.
        // The DesktopService contract is intentionally schedule-only: scanning and
        // packaging continue in the background after the HTTP response returns.
        schedulePrewarm(this.options.worker?.prewarm ?? this.options.prewarm, value, () => this.isCurrent(generation));
    }
    async prepareSessionStart(sessionId) {
        const generation = this.generation;
        if (this.closed)
            return { status: 'disabled' };
        try {
            const preference = await this.getPreference();
            if (!preference.enabled || !this.isCurrent(generation))
                return { status: 'disabled' };
            const session = await this.options.getSession?.(sessionId);
            if (!this.isCurrent(generation))
                return { status: 'disabled' };
            if (!session)
                return { status: 'no_session' };
            if (!isEligible(session))
                return { status: 'no_workspace' };
            const worker = this.options.worker;
            if (!worker)
                return { status: 'disabled' };
            const result = await worker.prepareSessionStart({
                sessionId: session.sessionId,
                workspaceDir: session.workspaceDir,
            });
            return this.isCurrent(generation) ? result : { status: 'disabled' };
        }
        catch (error) {
            return { status: 'degraded', code: errorCode(error, 'workspace_initial_snapshot_failed') };
        }
    }
    async captureRevisionAfterTurn(sessionId) {
        const generation = this.generation;
        if (this.closed)
            return { status: 'disabled' };
        try {
            const preference = await this.getPreference();
            if (!preference.enabled || !this.isCurrent(generation))
                return { status: 'disabled' };
            const session = await this.options.getSession?.(sessionId);
            if (!this.isCurrent(generation))
                return { status: 'disabled' };
            if (!session || !isEligible(session))
                return { status: 'not_prepared' };
            const worker = this.options.worker;
            if (!worker)
                return { status: 'not_prepared' };
            const result = await worker.captureRevisionAfterTurn({
                sessionId: session.sessionId,
                workspaceDir: session.workspaceDir,
            });
            return this.isCurrent(generation) ? result : { status: 'disabled' };
        }
        catch (error) {
            return { status: 'degraded', code: errorCode(error, 'workspace_revision_capture_failed') };
        }
    }
    async deleteSession(sessionId, completeDeletion) {
        if (this.options.worker?.deleteSession) {
            await this.options.worker.deleteSession(sessionId, completeDeletion);
            return;
        }
        await completeDeletion?.();
    }
    close() {
        if (this.closed)
            return;
        this.closed = true;
        this.generation += 1;
        this.options.worker?.closePrewarm();
    }
    isCurrent(generation) {
        return !this.closed && generation === this.generation;
    }
}
function schedulePrewarm(prewarm, workspaceDir, isCurrent) {
    if (!prewarm)
        return;
    // eslint-disable-next-line @typescript-eslint/no-misused-promises -- queueMicrotask is detached and runPrewarm consumes both sync and async failures
    queueMicrotask(async () => {
        if (isCurrent())
            await runPrewarm(prewarm, workspaceDir);
    });
}
async function runPrewarm(prewarm, workspaceDir) {
    try {
        await prewarm(workspaceDir);
    }
    catch {
        // Prewarm is advisory; a failed background request must not affect HTTP.
    }
}
function isEligible(session) {
    return session.isDefaultWorkspace === false && session.workspaceDir.trim().length > 0;
}
function errorCode(error, fallback) {
    if (error && typeof error === 'object') {
        const code = Reflect.get(error, 'code');
        if (typeof code === 'string' && code.trim())
            return code;
    }
    if (error instanceof Error && error.name.trim())
        return error.name;
    return fallback;
}
//# sourceMappingURL=workspace-indexing.service.js.map