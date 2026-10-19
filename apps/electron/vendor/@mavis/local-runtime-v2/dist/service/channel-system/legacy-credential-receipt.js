import { readPreferenceValue, upsertPreferenceValue } from '../../infra/db/preference-values.js';
const LEGACY_CREDENTIAL_MIGRATION_KEY = 'legacy-im-credentials-migrated';
/** Owns only the retry receipt; V1 remains the narrow legacy-state migration executor. */
export class LegacyCredentialMigrationReceipt {
    db;
    constructor(db) {
        this.db = db;
    }
    async run(action) {
        if (readPreferenceValue(this.db, LEGACY_CREDENTIAL_MIGRATION_KEY) === true)
            return;
        await action();
        upsertPreferenceValue(this.db, LEGACY_CREDENTIAL_MIGRATION_KEY, true);
    }
}
//# sourceMappingURL=legacy-credential-receipt.js.map