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
//# sourceMappingURL=indexing.js.map