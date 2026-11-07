import { isOrdinaryQuestionnaireResponseOrigin, QUESTIONNAIRE_ANSWER_STEERING_PRODUCER, } from '@mavis/shared/questionnaire';
/**
 * AskUser v2: an answer that could not join or start a Turn right away (Plan
 * card awaiting a decision, compaction, ...) waits at the queue front with
 * `injected_at` empty. The moment the Turn carrying it is durably admitted is
 * when the answer reaches the model, so this participant reports that
 * admission back to the questionnaire owner (v1 compatibility), which writes
 * `injected_at` once and ignores legacy rows.
 *
 * Queue dispatch provenance does not carry the message origin, so a queued
 * submission is recognised by reading its queue item and any batch members;
 * direct submissions carry the origin in their provenance.
 *
 * Commit is best-effort: the Turn is already admitted, and failing it here
 * would drop the user's answer. A missed mark only leaves `injectedAt` unset.
 */
export function createQuestionnaireAnswerAdmissionPreparation(input) {
    return {
        prepare: async (candidate) => {
            const origins = await resolveOrigins(input, candidate);
            const requestIds = [
                ...new Set(origins.flatMap((origin) => isOrdinaryQuestionnaireResponseOrigin(origin) ? [origin.requestId] : [])),
            ];
            if (requestIds.length === 0)
                return undefined;
            const fields = {
                requestIds,
                sessionId: candidate.sessionId,
                turnId: candidate.turnId,
                ...(candidate.queueItemId ? { queueItemId: candidate.queueItemId } : {}),
            };
            return {
                status: 'ready',
                commit: async () => {
                    for (const requestId of requestIds) {
                        await markSafely(input, { ...fields, requestId, stage: 'turn_admitted' });
                    }
                },
                rollback: async () => {
                    input.logger?.info({ ...fields, reason: 'admission_rolled_back' }, 'Questionnaire answer Turn was not admitted');
                },
                compensate: async () => {
                    input.logger?.info({ ...fields, reason: 'admission_compensated' }, 'Questionnaire answer Turn failed before registration');
                },
            };
        },
    };
}
/**
 * Wraps a steering consumer (normal consumption or the Stop / abnormal-end
 * teardown commit into the conversation) so an AskUser v2 answer steered into
 * a running Turn gets `injected_at` only once the model can actually read it.
 * The steer ACK alone is not enough: an aborted Turn used to drop it.
 */
export function observeQuestionnaireAnswerSteering(consume, options) {
    const mark = createQuestionnaireAnswerSteeringMarker(options);
    return async (steer) => {
        await consume(steer);
        await mark(steer);
    };
}
/**
 * Records delivery of an AskUser v2 answer steer at a point the caller has
 * already made durable (e.g. the teardown sink's both-rows-committed hook).
 * A replayed queue batch may change the producer; its answer origin survives.
 */
export function createQuestionnaireAnswerSteeringMarker(options) {
    return async (steer) => {
        const origin = steer.message.provenance?.sourceContext?.origin ?? steer.message.message?.origin;
        let requestId = steer.message.producerId === QUESTIONNAIRE_ANSWER_STEERING_PRODUCER
            ? steer.message.idempotencyKey
            : undefined;
        if (isOrdinaryQuestionnaireResponseOrigin(origin))
            requestId = origin.requestId;
        if (!requestId)
            return;
        await markSafely({
            markAnswerAdmitted: options.markAnswerDelivered,
            ...(options.logger ? { logger: options.logger } : {}),
        }, {
            requestId,
            sessionId: steer.sessionId,
            turnId: steer.turnId,
            stage: options.stage,
        });
    };
}
async function resolveOrigins(input, candidate) {
    const direct = candidate.provenance.sourceContext?.origin;
    const origins = direct === undefined ? [] : [direct];
    if (!candidate.queueItemId || !input.readQueuedOrigins)
        return origins;
    try {
        return [
            ...origins,
            ...(await input.readQueuedOrigins(candidate.sessionId, candidate.queueItemId)),
        ];
    }
    catch (error) {
        // Unidentifiable input is admitted unchanged: the Turn must not fail over
        // bookkeeping. If it was an answer, injected_at stays empty and startup
        // recovery finds the answer through its queue item or redelivers it.
        input.logger?.warn({
            sessionId: candidate.sessionId,
            turnId: candidate.turnId,
            queueItemId: candidate.queueItemId,
            reason: 'queued_origin_read_failed',
            error: error instanceof Error ? error.message : String(error),
        }, 'Questionnaire answer admission could not read the queued item');
        return origins;
    }
}
async function markSafely(input, fields) {
    try {
        await input.markAnswerAdmitted({
            requestId: fields.requestId,
            sessionId: fields.sessionId,
            stage: fields.stage,
        });
    }
    catch (error) {
        input.logger?.warn({
            ...fields,
            reason: 'mark_answer_delivered_failed',
            error: error instanceof Error ? error.message : String(error),
        }, 'Questionnaire answer delivery mark failed');
    }
}
//# sourceMappingURL=questionnaire-answer-admission.js.map