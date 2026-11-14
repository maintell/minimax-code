import { and, eq } from 'drizzle-orm';
import { sessions } from '../../../../../infra/db/schema/sessions.js';
export function readSessionInteractionModeInTransaction(db, sessionId) {
    const row = db
        .select({ extraDataJson: sessions.extraDataJson })
        .from(sessions)
        .where(and(eq(sessions.sessionId, sessionId), eq(sessions.columnarVersion, 3)))
        .get();
    return row ? parseInteractionModeEnvelope(row.extraDataJson).mode : undefined;
}
export function compareAndSetSessionInteractionModeInTransaction(db, input) {
    return transitionSessionInteractionModeInTransaction(db, input) === 'updated';
}
export function transitionSessionInteractionModeInTransaction(db, input) {
    const row = db
        .select({ extraDataJson: sessions.extraDataJson })
        .from(sessions)
        .where(and(eq(sessions.sessionId, input.sessionId), eq(sessions.columnarVersion, 3)))
        .get();
    if (!row)
        return 'not-found';
    const envelope = parseInteractionModeEnvelope(row.extraDataJson);
    if (envelope.mode === input.next) {
        return alreadyInInteractionMode(input.next);
    }
    if (envelope.mode !== input.expected)
        return 'conflict';
    const nextExtraData = { ...envelope.data };
    if (input.next === 'plan' || input.next === 'goal') {
        nextExtraData.interactionMode = input.next;
    }
    else {
        delete nextExtraData.interactionMode;
    }
    const updated = db
        .update(sessions)
        .set({
        extraDataJson: JSON.stringify(nextExtraData),
        updatedAtMs: input.updatedAtMs,
    })
        .where(and(eq(sessions.sessionId, input.sessionId), eq(sessions.columnarVersion, 3), eq(sessions.extraDataJson, row.extraDataJson)))
        .run();
    return updated.changes === 1 ? 'updated' : 'conflict';
}
function alreadyInInteractionMode(mode) {
    if (mode === 'plan')
        return 'already-plan';
    if (mode === 'goal')
        return 'already-goal';
    return 'already-default';
}
function parseInteractionModeEnvelope(raw) {
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch (error) {
        throw new Error('Session extra_data_json is not valid JSON', { cause: error });
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('Session extra_data_json must be an object');
    }
    const data = parsed;
    const stored = data.interactionMode;
    if (stored === undefined || stored === null)
        return { data, mode: 'default' };
    if (stored === 'plan')
        return { data, mode: 'plan' };
    if (stored === 'goal')
        return { data, mode: 'goal' };
    throw new Error(`Session has invalid interactionMode: ${String(stored)}`);
}
//# sourceMappingURL=interaction-mode.js.map