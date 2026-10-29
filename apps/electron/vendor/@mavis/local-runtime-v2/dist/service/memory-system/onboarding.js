import { readPreferenceValue, upsertPreferenceValue } from '../../infra/db/preference-values.js';
import { GLOBAL_SCOPE_KEY, } from './contracts.js';
const ONBOARDING_RECORD_KEY = 'memoryV2.onboarding';
const LEGACY_CHOICES = [
    'migrate',
    'abandon',
    'none-detected',
];
const BACKFILL_CHOICES = ['extract', 'reset'];
export class MemoryOnboardingStore {
    db;
    repository;
    nowMs;
    constructor(db, repository, nowMs) {
        this.db = db;
        this.repository = repository;
        this.nowMs = nowMs;
    }
    async inspect() {
        const record = parseRecord(readPreferenceValue(this.db, ONBOARDING_RECORD_KEY));
        if (record)
            return { record, needsOnboarding: false };
        return { record: undefined, needsOnboarding: !(await this.hasExistingMemory()) };
    }
    async complete(input) {
        const legacyChoice = pick(LEGACY_CHOICES, input.legacyChoice);
        const backfillChoice = pick(BACKFILL_CHOICES, input.backfillChoice);
        if (!legacyChoice || !backfillChoice)
            return { status: 'invalid-query' };
        // 客户端超时后重试时，服务端可能已经写过记录；原样返回，不清空已有的迁移进度。
        const existing = parseRecord(readPreferenceValue(this.db, ONBOARDING_RECORD_KEY));
        if (existing)
            return { status: 'completed', record: existing };
        const record = {
            completedAtMs: this.nowMs(),
            legacyChoice,
            backfillChoice,
            // 空进度数组标记静默迁移请求，与旧版"接受后才写 migrate"的完成记录区分。
            ...(legacyChoice === 'migrate'
                ? {
                    migratedLegacySessionIds: [],
                    ...(input.legacyMigrationResetEpoch === undefined
                        ? {}
                        : { legacyMigrationResetEpoch: input.legacyMigrationResetEpoch }),
                }
                : {}),
        };
        upsertPreferenceValue(this.db, ONBOARDING_RECORD_KEY, record);
        return { status: 'completed', record };
    }
    /** 同步读改写：better-sqlite3 调用不让出事件循环，并行迁移的登记不会互相覆盖。 */
    markLegacySessionMigrated(sessionId) {
        const record = parseRecord(readPreferenceValue(this.db, ONBOARDING_RECORD_KEY));
        const migrated = record?.migratedLegacySessionIds;
        if (!record || !migrated || migrated.includes(sessionId))
            return;
        upsertPreferenceValue(this.db, ONBOARDING_RECORD_KEY, {
            ...record,
            migratedLegacySessionIds: [...migrated, sessionId],
        });
    }
    markLegacySessionAbandoned(sessionId) {
        const record = parseRecord(readPreferenceValue(this.db, ONBOARDING_RECORD_KEY));
        if (!record?.migratedLegacySessionIds)
            return;
        const abandoned = record.abandonedLegacySessionIds ?? [];
        if (abandoned.includes(sessionId))
            return;
        upsertPreferenceValue(this.db, ONBOARDING_RECORD_KEY, {
            ...record,
            abandonedLegacySessionIds: [...abandoned, sessionId],
        });
    }
    markLegacyRecallDisabled() {
        const record = parseRecord(readPreferenceValue(this.db, ONBOARDING_RECORD_KEY));
        if (!record || record.legacyRecallDisabled)
            return;
        upsertPreferenceValue(this.db, ONBOARDING_RECORD_KEY, {
            ...record,
            legacyRecallDisabled: true,
        });
    }
    /** 会话状态行、已整理产物或曾执行 Reset，任一成立即说明 V2 已经运行过。 */
    async hasExistingMemory() {
        const scope = await this.repository.getScope(GLOBAL_SCOPE_KEY);
        if (scope && (scope.resetEpoch > 0 || scope.consolidatedDigest !== undefined))
            return true;
        return this.repository.hasSessionStates(GLOBAL_SCOPE_KEY);
    }
}
function pick(choices, value) {
    return choices.find((choice) => choice === value);
}
function parseRecord(value) {
    if (typeof value !== 'object' || value === null)
        return undefined;
    const raw = value;
    const legacyChoice = pick(LEGACY_CHOICES, raw.legacyChoice);
    const backfillChoice = pick(BACKFILL_CHOICES, raw.backfillChoice);
    if (typeof raw.completedAtMs !== 'number' || !Number.isFinite(raw.completedAtMs)) {
        return undefined;
    }
    if (!legacyChoice || !backfillChoice)
        return undefined;
    return { completedAtMs: raw.completedAtMs, legacyChoice, backfillChoice, ...migrationState(raw) };
}
/** 静默迁移的进度与收尾状态；缺失的字段不出现在记录里，旧版记录据此与新版区分。 */
function migrationState(raw) {
    const migrated = stringArray(raw.migratedLegacySessionIds);
    const abandoned = stringArray(raw.abandonedLegacySessionIds);
    const epoch = raw.legacyMigrationResetEpoch;
    return {
        ...(migrated ? { migratedLegacySessionIds: migrated } : {}),
        ...(abandoned ? { abandonedLegacySessionIds: abandoned } : {}),
        ...(raw.legacyRecallDisabled === true ? { legacyRecallDisabled: true } : {}),
        ...(typeof epoch === 'number' && Number.isInteger(epoch)
            ? { legacyMigrationResetEpoch: epoch }
            : {}),
    };
}
function stringArray(value) {
    return Array.isArray(value)
        ? value.filter((item) => typeof item === 'string')
        : undefined;
}
//# sourceMappingURL=onboarding.js.map