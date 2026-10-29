import { logger } from '../common/logger.js';
import { LocalQuestionnaireError } from '../questionnaire/errors.js';
import { decideQuestionnaireResponseMode } from '../questionnaire/response-mode-policy.js';
import { publishQuestionnaireState } from '../questionnaire/v2-state.js';
import { markV2Injected } from '../questionnaire/v2-answer-delivery.js';
import { buildQuestionnaireImageResult } from '../questionnaire/context-image-result.js';
import { resolveQuestionnaireAnswers, serializeQuestionnaireResponseMessage, } from '../questionnaire/serializer.js';
import { LocalQuestionnaireService, } from '../questionnaire/service.js';
export function buildLocalAskUserAdapter(ctx) {
    if (!ctx || ctx.configGetter().askUser?.enabled === false)
        return undefined;
    return {
        begin: async (toolCtx, toolInput, signal) => beginLocalAskUserQuestionnaire(ctx, toolCtx, toolInput, signal),
    };
}
async function beginLocalAskUserQuestionnaire(ctx, toolCtx, toolInput, signal) {
    if (signal?.aborted)
        throw new Error('Operation aborted');
    const mode = toolInput.mode ?? 'questionnaire';
    if (mode === 'questionnaire' && (await hasPendingUserSteering(ctx, toolCtx.sessionId))) {
        // Decision v3: suppress before any record or event exists so the UI has
        // nothing to render and no dangling questionnaire can wedge the session.
        // Consent prompts (feature-enable) and owned modes are never suppressed.
        return { suppressed: true, reason: 'user-steering-pending' };
    }
    const decision = await decideQuestionnaireResponseMode(ctx, {
        sessionId: toolCtx.sessionId,
        toolInput,
        fromImChannel: toolCtx.channelContext !== undefined,
        planActive: toolCtx.askUserPlanActive === true,
    });
    // Goal + skip: the call waits at most this long, then answers with each
    // question's recommended option, so creation marks one where the model left
    // none and stores the deadline for the UI countdown.
    const autoSelectAfterMs = decision.v2 ? decision.autoSelectAfterMs : undefined;
    let result;
    try {
        result = await new LocalQuestionnaireService(ctx).begin({
            sessionId: toolCtx.sessionId,
            agentName: toolCtx.agentName,
            runId: toolCtx.turnId,
            callId: toolCtx.toolCallId,
            ...(toolCtx.channelContext ? { originChannelContext: toolCtx.channelContext } : {}),
            ...(decision.v2 ? { responseMode: decision.responseMode } : {}),
            ...(autoSelectAfterMs !== undefined ? { fillRecommendation: true, autoSelectAfterMs } : {}),
            toolInput,
        });
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`ask_user failed: ${message}`);
    }
    const base = {
        requestId: result.requestId,
        schemaVersion: result.schemaVersion,
        stepCount: result.stepCount,
    };
    if (!decision.v2)
        return base;
    const v2 = {
        ...base,
        responseMode: decision.responseMode,
        policyOverridden: decision.policyOverridden,
    };
    if (decision.responseMode === 'async') {
        // Async: the questionnaire is shown and the Turn continues right away.
        logger.info({ requestId: result.requestId, sessionId: toolCtx.sessionId, responseMode: 'async' }, 'ask_user returned without waiting');
        return v2;
    }
    const autoSelectAt = autoSelectAfterMs !== undefined ? result.record.request.expiresAt : undefined;
    try {
        return {
            ...v2,
            outcome: await waitForSyncAnswer(ctx, toolCtx, result, autoSelectAt, signal),
        };
    }
    finally {
        // wait() removes its own entry; this only clears a reservation the wait
        // never took (e.g. the call failed before waiting), so it cannot leak.
        ctx.syncWaits?.release(result.requestId, 'ask_user_call_finished');
        ctx.syncWaits?.finishAnswerDelivery(result.requestId);
        const current = await ctx.store.get(result.requestId).catch(() => undefined);
        if (current)
            publishQuestionnaireState(ctx, current, 'sync_wait_finished');
    }
}
/**
 * Goal + skip: at `autoSelectAt` the runtime answers with each question's
 * recommended option through the normal reply path (source `auto`), so the row
 * is answered, the UI closes the question and this wait returns the answer.
 * The reply path saves it only while this call still waits and the row is
 * still pending; otherwise the first ending stands. Cancelled when the wait
 * ends for any reason.
 */
function armAutoSelect(ctx, toolCtx, result, autoSelectAt) {
    const timer = setTimeout(() => void autoSelectRecommended(ctx, toolCtx, result), Math.max(0, autoSelectAt - ctx.nowMs()));
    timer.unref?.();
    return () => clearTimeout(timer);
}
async function autoSelectRecommended(ctx, toolCtx, result) {
    const { record } = result;
    const fields = { requestId: result.requestId, sessionId: toolCtx.sessionId };
    const reply = recommendedReply(record.request.steps, result.requestId, ctx.nowMs());
    // Ids only: question and option text stay out of logs.
    const steps = reply.answers.flatMap((answer) => answer.selectedOptionIds.map((optionId) => ({ stepId: answer.stepId, optionId })));
    if (steps.length === 0) {
        logger.warn({ ...fields, reason: 'no_option_to_select' }, 'ask_user goal skip has no option to select; keeps waiting');
        return;
    }
    try {
        await new LocalQuestionnaireService(ctx).reply({
            agentName: record.agentName ?? ctx.primaryAgentName,
            requestId: result.requestId,
            reply,
            source: 'auto',
        });
        logger.info({ ...fields, steps }, 'ask_user goal skip auto-selected recommended options');
    }
    catch (error) {
        if (error instanceof LocalQuestionnaireError &&
            error.code === 'QUESTIONNAIRE_AUTO_REPLY_CANCELLED') {
            // The user answered first or the wait already ended: that ending stands.
            logger.info({ ...fields, reason: 'auto_select_not_applied', err: error }, 'ask_user goal skip did not auto-select');
            return;
        }
        // Not saved, or saved but not delivered (recovery redelivers a saved
        // answer): the call keeps its other endings, as without a deadline.
        logger.warn({ ...fields, reason: 'auto_select_failed', err: error }, 'ask_user goal skip auto-select failed');
    }
}
/**
 * Each question takes its recommended option. Creation marked one in every
 * question with options, so the first-option fallback only guards a step
 * without a mark; a step without options is skipped.
 */
function recommendedReply(steps, requestId, submittedAt) {
    return {
        schemaVersion: 2,
        requestId,
        submittedAt,
        answers: steps.map((step) => {
            const option = step.options.find((candidate) => candidate.recommended === true) ?? step.options[0];
            return option
                ? { stepId: step.id, selectedOptionIds: [option.id], selectedOther: false }
                : { stepId: step.id, selectedOptionIds: [], selectedOther: false, skipped: true };
        }),
    };
}
/**
 * Sync: block this tool call (and so the Turn) until the user answers, skips
 * or closes, sends a new message, or stops the Turn. No timeout, except in a
 * Goal (Goal + skip, `autoSelectAt` set), where the runtime answers with the
 * recommended options at the deadline.
 */
async function waitForSyncAnswer(ctx, toolCtx, result, autoSelectAt, signal) {
    const syncWaits = ctx.syncWaits;
    if (!syncWaits) {
        // Only hosts without the shared registry (tests / headless) reach this.
        // Returning "not answered" keeps the Turn alive; the answer still arrives
        // later through steer.
        logger.error({
            requestId: result.requestId,
            sessionId: toolCtx.sessionId,
            responseMode: 'sync',
            reason: 'sync_wait_registry_missing',
        }, 'ask_user cannot wait for the answer on this host');
        return { kind: 'dismissed' };
    }
    const steeringProbe = ctx.hasPendingUserSteering;
    const queueProbe = ctx.hasQueuedUserInputSince;
    if (autoSelectAt !== undefined) {
        logger.info({ requestId: result.requestId, sessionId: toolCtx.sessionId, autoSelectAt }, 'ask_user goal skip waits for an answer');
    }
    const cancelAutoSelect = autoSelectAt !== undefined ? armAutoSelect(ctx, toolCtx, result, autoSelectAt) : undefined;
    let outcome;
    try {
        outcome = await syncWaits.wait({
            requestId: result.requestId,
            sessionId: toolCtx.sessionId,
            ...(signal ? { signal } : {}),
            ...(steeringProbe ? { hasPendingUserSteering: () => steeringProbe(toolCtx.sessionId) } : {}),
            ...(queueProbe
                ? { hasQueuedUserInputSince: (sinceMs) => queueProbe(toolCtx.sessionId, sinceMs) }
                : {}),
        });
    }
    finally {
        cancelAutoSelect?.();
    }
    if (outcome.kind === 'dismissed') {
        const answers = result.record.request.steps.map((step) => ({
            stepId: step.id,
            selectedOptionIds: [],
            selectedOther: false,
            skipped: true,
        }));
        return {
            kind: 'dismissed',
            answers: resolveQuestionnaireAnswers(result.record.request, answers, ctx.resolveLocale?.()),
            content: serializeQuestionnaireResponseMessage(result.record.request, {
                schemaVersion: 2,
                requestId: result.requestId,
                submittedAt: ctx.nowMs(),
                answers,
            }, ctx.resolveLocale?.()),
        };
    }
    if (outcome.kind !== 'answered')
        return outcome;
    const media = await buildQuestionnaireImageResult(ctx, toolCtx.sessionId, outcome.reply, toolCtx.parentAgentConfig?.model.capabilities, signal);
    if (outcome.buffered || media.contextImages?.length) {
        // The reply arrived before this call started waiting; the answer reaches
        // the model only now, as this tool result.
        try {
            await markV2Injected(ctx, result.requestId, outcome.buffered ? 'tool_result_buffered' : 'tool_result_images');
        }
        catch (error) {
            // The model still gets the answer; failing the call would lose it. An
            // unwritten injected_at only means recovery may deliver it once more.
            logger.error({
                requestId: result.requestId,
                sessionId: toolCtx.sessionId,
                responseMode: 'sync',
                reason: 'mark_injected_failed',
                err: error,
            }, 'ask_user could not record injection of a buffered answer');
        }
    }
    return {
        kind: 'answered',
        ...media,
        // The runtime's deadline answer, not the user's: the tool result says so.
        ...(outcome.reply.source === 'automatic_timeout' ? { autoSelected: true } : {}),
        answers: resolveQuestionnaireAnswers(result.record.request, outcome.reply.answers, ctx.resolveLocale?.()),
        // Same content the legacy answer message carries, moved into the tool result.
        content: serializeQuestionnaireResponseMessage(result.record.request, outcome.reply, ctx.resolveLocale?.()),
    };
}
async function hasPendingUserSteering(ctx, sessionId) {
    const probe = ctx.hasPendingUserSteering;
    if (!probe)
        return false;
    try {
        return (await probe(sessionId)) === true;
    }
    catch {
        // Fail-open: a broken probe must never swallow a question aimed at the user.
        return false;
    }
}
//# sourceMappingURL=local-ask-user-adapter.js.map