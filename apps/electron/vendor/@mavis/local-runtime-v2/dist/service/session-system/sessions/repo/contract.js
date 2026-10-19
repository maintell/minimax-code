export const SESSION_RUNTIMES = ['pi-agent', 'opencode'];
export const SESSION_TYPES = ['root', 'branch'];
export const SESSION_STATUSES = ['idle', 'started', 'error', 'aborted', 'interrupted'];
export const LEGACY_SESSION_STATUSES = [...SESSION_STATUSES, 'finished'];
export const SESSION_VISIBILITIES = ['visible', 'hidden'];
export const SESSION_KINDS = [
    'conversation',
    'task',
    'peek',
    'channel',
    'cron',
    'unknown',
];
export const SESSION_RUN_LOCATION_MODES = ['current', 'new-worktree', 'existing-worktree'];
export const SESSION_REPOSITORY_CAPABILITIES = [
    'get',
    'getMany',
    'has',
    'create',
    'getTaskAgentBinding',
    'backfillTaskAgentBindingIfAbsent',
    'upsertImportedLegacy',
    'upsert',
    'update',
    'detachCronSessions',
    'delete',
    'touch',
    'swapRoot',
    'reparentChildren',
    'applyAgentState',
    'list',
    'count',
    'listPage',
    'searchPage',
    'listByCronOriginPage',
    'listStalePiSessions',
    'listRootPage',
    'listChildren',
    'listChildrenMany',
    'listProjectRootPage',
    'listProjectRootPreviews',
];
export class SessionUniqueViolation extends Error {
    sessionId;
    constructor(sessionId) {
        super(`Session ${sessionId} already exists`);
        this.sessionId = sessionId;
        this.name = 'SessionUniqueViolation';
    }
}
export class SessionRootSwapError extends Error {
    reason;
    constructor(reason) {
        super(`Session root swap failed: ${reason}`);
        this.reason = reason;
        this.name = 'SessionRootSwapError';
    }
}
export class SessionTitleConflictError extends Error {
    constructor() {
        super('Session title changed');
        this.name = 'SessionTitleConflictError';
    }
}
//# sourceMappingURL=contract.js.map