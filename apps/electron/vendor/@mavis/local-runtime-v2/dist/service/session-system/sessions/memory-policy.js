import { and, eq } from 'drizzle-orm';
import { sessions } from '../../../infra/db/schema/sessions.js';
export const DEFAULT_SESSION_MEMORY_POLICY = {
    recallEnabled: true,
    writeEnabled: true,
    recallLocked: false,
};
export function effectiveSessionMemoryPolicy(policy) {
    return policy ?? DEFAULT_SESSION_MEMORY_POLICY;
}
export function applySessionMemoryPolicyPatch(current, patch) {
    return { ...effectiveSessionMemoryPolicy(current), ...patch };
}
export function readSessionMemoryPolicy(value, field) {
    if (!isPlainObject(value))
        throw new Error(`${field} must be an object`);
    const recallEnabled = requireBoolean(value.recallEnabled, `${field}.recallEnabled`);
    const writeEnabled = requireBoolean(value.writeEnabled, `${field}.writeEnabled`);
    const recallLocked = requireBoolean(value.recallLocked, `${field}.recallLocked`);
    const recallLockedAtMs = optionalSafeInteger(value.recallLockedAtMs, `${field}.recallLockedAtMs`);
    if (recallLocked && recallLockedAtMs === undefined) {
        throw new Error(`${field}.recallLockedAtMs is required when recall is locked`);
    }
    if (!recallLocked && recallLockedAtMs !== undefined) {
        throw new Error(`${field}.recallLockedAtMs requires recallLocked`);
    }
    return {
        recallEnabled,
        writeEnabled,
        recallLocked,
        ...(recallLockedAtMs === undefined ? {} : { recallLockedAtMs }),
    };
}
export function lockSessionMemoryRecallInTransaction(db, input) {
    const row = db
        .select({ extraDataJson: sessions.extraDataJson })
        .from(sessions)
        .where(and(eq(sessions.sessionId, input.sessionId), eq(sessions.columnarVersion, 3)))
        .get();
    if (!row)
        return 'not-found';
    const data = parseExtraDataEnvelope(row.extraDataJson);
    const current = effectiveSessionMemoryPolicy(data.memoryPolicy === undefined
        ? undefined
        : readSessionMemoryPolicy(data.memoryPolicy, 'extra_data_json.memoryPolicy'));
    if (current.recallLocked)
        return 'already-locked';
    const next = {
        ...data,
        memoryPolicy: {
            ...current,
            recallLocked: true,
            recallLockedAtMs: input.lockedAtMs,
        },
    };
    db.update(sessions)
        .set({ extraDataJson: JSON.stringify(next), updatedAtMs: input.lockedAtMs })
        .where(and(eq(sessions.sessionId, input.sessionId), eq(sessions.columnarVersion, 3)))
        .run();
    return 'locked';
}
function parseExtraDataEnvelope(raw) {
    let value;
    try {
        value = JSON.parse(raw);
    }
    catch (error) {
        throw new Error('extra_data_json is not valid JSON', { cause: error });
    }
    if (!isPlainObject(value))
        throw new Error('extra_data_json must be an object');
    return value;
}
function requireBoolean(value, field) {
    if (typeof value !== 'boolean')
        throw new Error(`${field} must be a boolean`);
    return value;
}
function optionalSafeInteger(value, field) {
    if (value === undefined || value === null)
        return undefined;
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
        throw new Error(`${field} must be a safe integer`);
    }
    return value;
}
function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=memory-policy.js.map