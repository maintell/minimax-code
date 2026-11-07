import { QUESTIONNAIRE_TTL_MS, } from '@mavis/shared/questionnaire';
import { ASYNC_QUESTIONNAIRE_COUNTDOWN_SECONDS } from '../../../infra/legacy-db/questionnaire-action-contracts.js';
import { logger } from '../../../infra/logging/logger.js';
import { LocalQuestionnaireError } from '../../../infra/legacy-db/questionnaire-errors.js';
import { emitQuestionnaireAsk } from '../orchestration/ask-delivery.js';
import { generateQuestionnaireRequestId, normalizeAskUserInput, QuestionnaireNormalizationError, } from '../../../infra/legacy-db/questionnaire-normalize.js';
import { isOwnedQuestionnaireRequest } from './owned-action-lifecycle.js';
export class QuestionnaireRequestLifecycle {
    deps;
    constructor(deps) {
        this.deps = deps;
    }
    async begin(input) {
        if (this.deps.configGetter().askUser?.enabled === false) {
            throw new LocalQuestionnaireError(403, 'ASK_USER_DISABLED', 'ask_user is disabled by config (askUser.enabled=false)');
        }
        return this.beginWithPolicy(input, input.toolInput.mode ?? 'questionnaire', input.toolInput.modePayload);
    }
    async beginOwned(input) {
        return this.beginWithPolicy(input, input.mode, input.modePayload);
    }
    async getPending(input) {
        const record = await this.deps.store.findLatestPendingBySession(input.sessionId, this.deps.nowMs() - QUESTIONNAIRE_TTL_MS, input.legacyOnly ? { legacyOnly: true } : {});
        if (!record || !isQuestionnaireAgentAllowed(record, input.agentName))
            return null;
        return record;
    }
    async get(input) {
        const record = await this.deps.store.get(input.requestId);
        if (!record || !isQuestionnaireAgentAllowed(record, input.agentName))
            return null;
        return record;
    }
    async getLatestPlanReview(input) {
        const record = await this.deps.store.findLatestPlanReviewBySession(input.sessionId, this.deps.nowMs() - QUESTIONNAIRE_TTL_MS);
        if (!record || !isQuestionnaireAgentAllowed(record, input.agentName))
            return null;
        return record;
    }
    async beginWithPolicy(input, mode, modePayload) {
        const session = await this.deps.getSessionById(input.sessionId);
        if (!session) {
            throw new LocalQuestionnaireError(404, 'SESSION_NOT_FOUND', input.sessionId);
        }
        const createdAt = this.deps.nowMs();
        // The persisted session owner is authoritative. Tool-context aliases are
        // intentionally ignored so a questionnaire cannot be stored under the
        // canonical execution target instead of the real session owner.
        const agentName = session.agentName || this.deps.primaryAgentName;
        // v2 only for model questionnaires; Plan / feature-enable cards stay legacy.
        const responseMode = resolveResponseMode(input, mode, session.sessionId);
        // Only an ordinary ask can belong to the owner's current work (a Goal).
        const claim = mode === 'questionnaire' && !responseMode
            ? await this.deps.workOwner?.claim({
                sessionId: session.sessionId,
                createdAt,
                allowsAutoReply: false,
            })
            : undefined;
        const request = normalizeRequest(input, {
            sessionId: session.sessionId,
            agentName,
            createdAt,
            claim,
            responseMode,
            mode,
            modePayload,
        });
        const admissionRejection = await this.deps.requestAdmission?.({ request, session });
        if (admissionRejection) {
            throw new LocalQuestionnaireError(admissionRejection.status ?? 403, admissionRejection.code ?? 'QUESTIONNAIRE_REQUEST_REJECTED', admissionRejection.message);
        }
        const record = buildPendingRecord(input, {
            request,
            sessionId: session.sessionId,
            agentName,
            responseMode,
            createdAt,
        });
        const beginResult = await this.persistPending(record, { claim, mode, createdAt });
        if (beginResult.status === 'pending-conflict') {
            throw pendingConflictError({ record, mode, responseMode, claim });
        }
        logRetainedPendingRequests(beginResult, record, responseMode);
        this.announceSuperseded(record, beginResult.supersededRequestIds, createdAt);
        this.announceCreated(record, request, responseMode);
        return { requestId: request.id, schemaVersion: 2, stepCount: request.steps.length, record };
    }
    async persistPending(record, context) {
        const { claim, mode, createdAt } = context;
        if (claim) {
            const result = await this.deps.store.replacePendingWhen(record, claim.stillOwns);
            return result.inserted
                ? { status: 'created', supersededRequestIds: result.supersededRequestIds }
                : { status: 'pending-conflict' };
        }
        if (this.deps.store.beginPendingWithPolicy) {
            return this.deps.store.beginPendingWithPolicy({
                record,
                policy: isOwnedQuestionnaireRequest({ mode }) ? 'exclusive' : 'replaceable',
                createdAtCutoff: createdAt - QUESTIONNAIRE_TTL_MS,
            });
        }
        await this.deps.store.upsert(record);
        return {
            status: 'created',
            supersededRequestIds: await this.deps.store.supersedePendingBySession(record.sessionId, record.requestId),
        };
    }
    announceSuperseded(record, supersededRequestIds, createdAt) {
        for (const requestId of supersededRequestIds) {
            this.deps.autoReplyScheduler?.cancel(requestId);
            this.deps.publishGlobalEvent?.({
                type: 'questionnaire.superseded',
                payload: {
                    requestId,
                    sessionId: record.sessionId,
                    ...(record.agentName ? { agentName: record.agentName } : {}),
                    keepRequestId: record.requestId,
                    supersededAt: createdAt,
                },
            });
        }
    }
    announceCreated(record, request, responseMode) {
        if (request.purpose === 'goal') {
            // Nothing is scheduled here on purpose: auto-adoption is cancelled for
            // newly created Goal questionnaires (no `expiresAt` is written above).
            // Only pre-upgrade rows still carry a deadline, and those are re-armed
            // by startup recovery — never by this creation path.
            logger.info({
                requestId: record.requestId,
                sessionId: record.sessionId,
                goalId: request.goalId,
            }, 'Goal questionnaire created without auto-reply deadline — auto-adopt cancelled');
        }
        if (responseMode === 'sync') {
            // Reserve before questionnaire.ask goes out so an answer that races the
            // tool's wait() is buffered for it instead of being steered into the
            // very Turn that is blocked on this call.
            this.deps.syncWaits?.reserve(record.requestId, record.sessionId);
        }
        if (responseMode) {
            logger.info({
                requestId: record.requestId,
                sessionId: record.sessionId,
                responseMode,
                countdownSeconds: request.countdownSeconds,
                ...(request.expiresAt !== undefined ? { autoSelectAt: request.expiresAt } : {}),
                stepCount: request.steps.length,
            }, 'Questionnaire v2 request created');
        }
        try {
            emitQuestionnaireAsk(this.deps, record);
        }
        catch (error) {
            // The call fails, so no ask_user waits for this row: drop the
            // reservation instead of leaking it (an answer would be buffered for a
            // wait that never comes).
            if (responseMode === 'sync') {
                this.deps.syncWaits?.release(record.requestId, 'ask_publish_failed');
            }
            logger.error({ requestId: record.requestId, sessionId: record.sessionId, responseMode, err: error }, 'Questionnaire ask publish failed');
            throw error;
        }
    }
}
function resolveResponseMode(input, mode, sessionId) {
    const responseMode = mode === 'questionnaire' ? input.responseMode : undefined;
    if (input.responseMode && !responseMode) {
        logger.warn({
            sessionId,
            mode,
            responseMode: input.responseMode,
            reason: 'mode_not_v2',
        }, 'Questionnaire response mode ignored for non-questionnaire mode');
    }
    return responseMode;
}
function normalizeRequest(input, context) {
    const { sessionId, agentName, createdAt, claim, responseMode, mode, modePayload } = context;
    let request;
    try {
        request = normalizeAskUserInput(input.toolInput, {
            requestId: generateQuestionnaireRequestId(),
            createdAt,
            sessionId,
            agentName,
            toolMessageId: input.messageId,
            toolCallId: input.callId,
            runId: input.runId,
            ...claim?.stamp,
            ...(responseMode ? { recommendations: recommendationPolicy(input) } : {}),
        });
        request.mode = mode;
        if (modePayload !== undefined)
            request.modePayload = structuredClone(modePayload);
        if (responseMode) {
            applyResponseMode(request, responseMode, {
                createdAt,
                autoSelectAfterMs: input.autoSelectAfterMs,
            });
        }
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const code = err instanceof QuestionnaireNormalizationError
            ? 'QUESTIONNAIRE_INVALID_INPUT'
            : 'VALIDATION_ERROR';
        throw new LocalQuestionnaireError(400, code, message);
    }
    return request;
}
function recommendationPolicy(input) {
    return input.fillRecommendation ? 'explicit-or-first' : 'explicit-only';
}
function applyResponseMode(request, responseMode, deadline) {
    const { createdAt, autoSelectAfterMs } = deadline;
    request.responseMode = responseMode;
    // Async only: the absolute end of the "blocking" display window.
    // Sync questionnaires block until the ask_user call returns, which
    // clients read from the message stream, so they carry no countdown.
    if (responseMode === 'async') {
        request.countdownSeconds = ASYNC_QUESTIONNAIRE_COUNTDOWN_SECONDS;
    }
    // Goal + skip (sync): when the waiting ask_user call answers with the
    // recommended options. Display only for clients; no `purpose`, so the
    // legacy Goal auto-reply paths never read it.
    if (responseMode === 'sync' && autoSelectAfterMs !== undefined) {
        request.expiresAt = createdAt + autoSelectAfterMs;
    }
}
function buildPendingRecord(input, context) {
    const { request, responseMode } = context;
    return {
        requestId: request.id,
        sessionId: context.sessionId,
        agentName: context.agentName,
        ...(input.messageId ? { msgId: input.messageId } : {}),
        ...(input.originChannelContext ? { originChannelContext: input.originChannelContext } : {}),
        request,
        ...(responseMode ? { responseMode } : {}),
        status: 'pending',
        createdAt: context.createdAt,
    };
}
function pendingConflictError(context) {
    const { record, mode, responseMode, claim } = context;
    // Goal route: ownership changed. Plan card (exclusive): a legacy row is
    // pending. Legacy request (replaceable): a Plan card is pending; v2
    // requests never reach this branch for that reason.
    logger.info({
        requestId: record.requestId,
        sessionId: record.sessionId,
        mode,
        responseMode,
        reason: pendingConflictReason(claim, mode),
    }, 'Questionnaire request rejected: conflicting request pending');
    return new LocalQuestionnaireError(409, claim ? 'QUESTIONNAIRE_GOAL_NO_LONGER_CURRENT' : 'QUESTIONNAIRE_PENDING_CONFLICT', claim
        ? 'Questionnaire request no longer belongs to the active Goal'
        : 'An exclusive or newer Questionnaire request is already pending');
}
function pendingConflictReason(claim, mode) {
    if (claim)
        return 'goal_ownership';
    return isOwnedQuestionnaireRequest({ mode }) ? 'exclusive_pending' : 'owned_card_pending';
}
function logRetainedPendingRequests(beginResult, record, responseMode) {
    const retained = 'retainedV2RequestIds' in beginResult ? beginResult.retainedV2RequestIds : [];
    for (const retainedRequestId of retained ?? []) {
        logger.info({
            requestId: retainedRequestId,
            sessionId: record.sessionId,
            keepRequestId: record.requestId,
            reason: 'v2_not_replaceable',
        }, 'Questionnaire v2 request kept pending while a new request was created');
    }
    const retainedCards = 'retainedOwnedRequestIds' in beginResult ? beginResult.retainedOwnedRequestIds : [];
    for (const retainedRequestId of retainedCards ?? []) {
        logger.info({
            requestId: record.requestId,
            sessionId: record.sessionId,
            responseMode,
            planCardRequestId: retainedRequestId,
            reason: 'v2_created_beside_plan_card',
        }, 'Questionnaire v2 request created while a Plan card is pending; the card stays pending');
    }
}
export function isQuestionnaireAgentAllowed(record, agentName) {
    const owner = record.agentName ?? record.request.requester?.agentName;
    return !owner || owner === agentName;
}
//# sourceMappingURL=request-lifecycle.js.map