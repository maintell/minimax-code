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
    complete(input) {
        const legacyChoice = pick(LEGACY_CHOICES, input.legacyChoice);
        const backfillChoice = pick(BACKFILL_CHOICES, input.backfillChoice);
        if (!legacyChoice || !backfillChoice)
            return { status: 'invalid-query' };
        const record = {
            completedAtMs: this.nowMs(),
            legacyChoice,
            backfillChoice,
        };
        upsertPreferenceValue(this.db, ONBOARDING_RECORD_KEY, record);
        return { status: 'completed', record };
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
    return { completedAtMs: raw.completedAtMs, legacyChoice, backfillChoice };
}
//# sourceMappingURL=onboarding.js.map