import { readPreferenceValue, upsertPreferenceValue } from '../../infra/db/preference-values.js';
const WORKSPACE_INDEXING_ENABLED_KEY = 'workspace-indexing-enabled';
export class WorkspaceIndexingPolicy {
    db;
    constructor(db) {
        this.db = db;
    }
    async get() {
        return {
            enabled: readPreferenceValue(this.db, WORKSPACE_INDEXING_ENABLED_KEY) === true,
            forced: false,
        };
    }
    async put(enabled) {
        upsertPreferenceValue(this.db, WORKSPACE_INDEXING_ENABLED_KEY, enabled);
        return this.get();
    }
    async isEnabled() {
        return (await this.get()).enabled;
    }
}
export class WorkspaceIndexing {
    policy;
    executor;
    mutationTail = Promise.resolve();
    constructor(policy, executor) {
        this.policy = policy;
        this.executor = executor;
    }
    get() {
        return this.policy.get();
    }
    async put(enabled) {
        const previous = this.mutationTail;
        let release;
        this.mutationTail = new Promise((resolve) => {
            release = resolve;
        });
        await previous;
        try {
            const state = await this.policy.put(enabled);
            if (!state.forced && !state.enabled)
                this.executor.closeWorkspacePrewarm();
            return state;
        }
        finally {
            release();
        }
    }
    prepareSessionStart(sessionId) {
        return this.executor.prepareSessionStart(sessionId);
    }
    captureRevisionAfterTurn(sessionId) {
        return this.executor.captureRevisionAfterTurn(sessionId);
    }
    runSessionDeletion(sessionId, deletion) {
        return this.executor.runSessionDeletion(sessionId, deletion);
    }
    prewarm(workspaceDir) {
        this.executor.prewarmWorkspace(workspaceDir);
    }
}
//# sourceMappingURL=indexing.js.map