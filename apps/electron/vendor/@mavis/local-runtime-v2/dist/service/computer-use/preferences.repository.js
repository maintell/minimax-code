import { readPreferenceValue, upsertPreferenceValue } from '../../infra/db/preference-values.js';
/** Keep existing Computer Use keys in the V2-owned preference table. */
export function createComputerUsePreferenceStore(db) {
    return {
        get: async (key) => readPreferenceValue(db, key),
        set: async (key, value) => {
            upsertPreferenceValue(db, key, value);
        },
    };
}
//# sourceMappingURL=preferences.repository.js.map