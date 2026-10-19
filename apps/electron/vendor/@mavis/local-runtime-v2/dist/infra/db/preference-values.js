import { eq } from 'drizzle-orm';
import { preferences } from './schema/preferences.js';
/** Read one committed JSON value from the shared local runtime KV table. */
export function readPreferenceValue(db, key) {
    const row = db
        .select({ valueJson: preferences.valueJson })
        .from(preferences)
        .where(eq(preferences.key, key))
        .get();
    if (!row)
        return undefined;
    try {
        return JSON.parse(row.valueJson);
    }
    catch {
        return undefined;
    }
}
/** Insert or replace one JSON value without retaining process-local state. */
export function upsertPreferenceValue(db, key, value) {
    const valueJson = JSON.stringify(value);
    if (valueJson === undefined) {
        throw new TypeError('Preference value must be JSON-serializable');
    }
    db.insert(preferences)
        .values({ key, valueJson })
        .onConflictDoUpdate({ target: preferences.key, set: { valueJson } })
        .run();
}
/** Delete one value; deleting a missing row is intentionally idempotent. */
export function deletePreferenceValue(db, key) {
    db.delete(preferences).where(eq(preferences.key, key)).run();
}
//# sourceMappingURL=preference-values.js.map