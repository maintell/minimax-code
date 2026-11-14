import { insertPreferenceValueIfAbsent, readPreferenceValue, upsertPreferenceValue, } from '../../../../infra/db/preference-values.js';
import { sessions } from '../../../../infra/db/schema/sessions.js';
const PTC_DEVICE_COHORT_KEY = 'ptc-default-device-cohort';
/**
 * The one record that decides whether Apollo can still reach this device. It is written once and
 * only ever gains `ptcRemoteApplied`, so no second process can pull a decided device back to
 * undecided.
 */
export function createPtcDeviceCohortStore(db) {
    return {
        read: () => readPreferenceValue(db, PTC_DEVICE_COHORT_KEY),
        writeIfAbsent: (record) => insertPreferenceValueIfAbsent(db, PTC_DEVICE_COHORT_KEY, record),
        markApplied: () => {
            const stored = readPreferenceValue(db, PTC_DEVICE_COHORT_KEY);
            if (typeof stored !== 'object' || stored === null || Array.isArray(stored))
                return;
            const record = stored;
            if (record.ptcRemoteApplied === true)
                return;
            upsertPreferenceValue(db, PTC_DEVICE_COHORT_KEY, { ...record, ptcRemoteApplied: true });
        },
        /** Any row counts: archived and deleted Sessions still prove the device was used. */
        hasSessions: () => db.select({ id: sessions.sessionId }).from(sessions).limit(1).get() !== undefined,
    };
}
//# sourceMappingURL=ptc-device-cohort-store.js.map