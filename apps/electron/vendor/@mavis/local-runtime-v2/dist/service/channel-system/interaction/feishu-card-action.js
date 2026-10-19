import { json } from '../delivery/legacy-http/http-helpers.js';
import { feishuClientId } from '../transport/feishu/feishu-store.js';
import { buildQuestionnaireSubmittedCard, buildQuestionnaireExpiredCard, decodeCardAction, extractFormValue, extractQuestionnaireSubmitValue, mapFormValueToAnswers, } from '../transport/feishu/cards/feishu-card.js';
import { buildPermissionResolvedCard, extractPermissionActionValue, } from '../transport/feishu/cards/feishu-permission-card.js';
import { imLogger as logger } from '@mavis/shared/local-runtime-logging/im-logger';
export function createFeishuCardActionHandler(input) {
    const inFlightQuestionnaires = new Set();
    return async (body) => {
        const rawBody = (body ?? {});
        const payload = (rawBody.action && typeof rawBody.action === 'object' ? rawBody : { action: rawBody });
        // Dispatch on the button `value.kind` FIRST: a permission card and a
        // questionnaire card share this endpoint but carry disjoint discriminators
        // (`permission_action` vs `questionnaire_submit`), so neither branch can
        // ever eat the other's click.
        const permissionValue = extractPermissionActionValue(rawBody);
        if (permissionValue)
            return handlePermissionAction({ ...input, rawBody, payload, permissionValue });
        const submitValue = extractQuestionnaireSubmitValue(rawBody);
        if (submitValue)
            return handleFormSubmit({
                ...input,
                rawBody,
                payload,
                submitValue,
                inFlightQuestionnaires,
            });
        const decoded = decodeCardAction(payload);
        if (!decoded.token)
            return json({ ok: true, ignored: true, reason: 'no-questionnaire-token' });
        if (!input.getAdapter()) {
            return json({ ok: false, error: 'feishu adapter not registered', code: 'FEISHU_ADAPTER_MISSING' }, { status: 503 });
        }
        const reply = input.questionnaireBridge.buildReply({
            requestId: decoded.token.r,
            answers: [
                {
                    stepId: decoded.token.s,
                    selectedOptionIds: decoded.token.o === null ? [] : [decoded.token.o],
                    selectedOther: decoded.token.o === null,
                    ...(decoded.otherText ? { otherText: decoded.otherText } : {}),
                },
            ],
        });
        await input.questionnaireBridge.submit({
            ctx: legacyPayloadContext(payload, input.feishuPlatformAdapter.clientName),
            reply,
        });
        input.metrics?.incr('channel_ask_user_total', { channel: 'feishu', phase: 'replied' });
        return json({ ok: true, requestId: decoded.token.r });
    };
}
/**
 * Shared pending-card lookup for both card kinds: find the requestId-keyed
 * pending render, reject a cross-chat click, and resolve the exact adapter
 * that rendered the card. Returns a terminal Response when the click must be
 * ignored/failed; both outcomes preserve the v1 log lines verbatim.
 */
function resolvePendingCardTarget(input) {
    const { kind, requestId } = input;
    const pending = input.pendingMap.get(requestId);
    logger.info({
        requestId,
        ...input.receivedLog,
        pendingFound: Boolean(pending),
        pendingMsgId: pending?.messageId ?? null,
        pendingCount: input.pendingMap.size,
    }, input.receivedMessage);
    if (!pending) {
        return { response: json({ ok: true, ignored: true, reason: `${kind}-not-pending` }) };
    }
    if (input.payloadChatId && input.payloadChatId !== pending.chatId) {
        logger.warn({
            requestId,
            pendingClientName: pending.clientName,
            pendingChatId: pending.chatId,
            payloadChatId: input.payloadChatId,
            reason: 'chat_id_mismatch',
        }, kind === 'permission'
            ? 'Feishu permission action rejected for pending chat mismatch'
            : 'Feishu questionnaire submit rejected for pending chat mismatch');
        return {
            response: json({ ok: true, ignored: true, reason: `${kind}-chat-mismatch`, requestId }),
        };
    }
    const adapter = input.getAdapter(pending.clientName);
    if (!adapter) {
        logger.warn({ requestId, pendingClientName: pending.clientName, reason: 'adapter_missing' }, kind === 'permission'
            ? 'Feishu permission action adapter missing for pending client'
            : 'Feishu questionnaire submit adapter missing for pending client');
        return {
            response: json({
                ok: false,
                requestId,
                error: 'Feishu adapter is not registered for the originating client',
                code: 'FEISHU_PENDING_ADAPTER_MISSING',
            }, { status: 503 }),
        };
    }
    return { pending, adapter };
}
/**
 * Resolve a permission-card click. The button value already carries
 * `requestId` + `behavior` (decoded at dispatch), so this looks up the
 * `requestId`-keyed pending render, settles the decision through the host
 * `applyPermissionReply` seam (the SAME seam MR-1 wired for Telegram inbound),
 * then PATCHes the card into its terminal state.
 *
 * Consume-once at the Feishu layer: a missing pending → the card was already
 * clicked (or the desktop UI settled it first), so we ignore the duplicate
 * without re-settling. When a pending IS present but the route seam no-ops
 * (desktop-first race, NOT_PENDING treated as idempotent by
 * `applyPermissionReplyFromChannel`), we STILL patch the terminal card so the
 * IM surface never dangles.
 */
async function handlePermissionAction(input) {
    const { requestId, behavior } = input.permissionValue;
    const target = resolvePendingCardTarget({
        kind: 'permission',
        requestId,
        pendingMap: input.feishuPendingPermissions,
        payloadChatId: nonEmptyPayloadChatId(input.payload.open_chat_id),
        getAdapter: input.getAdapter,
        receivedLog: { behavior },
        receivedMessage: 'Feishu permission action received',
    });
    if ('response' in target)
        return target.response;
    const { pending, adapter } = target;
    // Consume-once: drop the pending BEFORE any await so a rapid double-click
    // cannot both settle + double-patch.
    input.feishuPendingPermissions.delete(requestId);
    // The click IS the user decision; count it regardless of settle outcome.
    input.metrics?.incr('channel_permission_ask_total', { channel: 'feishu', phase: 'replied' });
    if (input.applyPermissionReply) {
        try {
            await input.applyPermissionReply({ requestId, behavior });
        }
        catch (err) {
            // Never surface a settle failure as a hard error — the click was real
            // and the card must still reach a terminal state. (The route seam
            // already folds the desktop-first NOT_PENDING race into a no-op.)
            logger.warn({ err, requestId, behavior }, 'Feishu permission applyPermissionReply failed');
        }
    }
    const resolvedCard = buildPermissionResolvedCard(pending.renderable, behavior, input.payload.open_id ?? input.payload.user_id);
    await patchResolvedCard(adapter, pending.messageId || input.payload.open_message_id, resolvedCard, requestId);
    return json({
        ok: true,
        requestId,
        toast: { type: behavior === 'deny' ? 'info' : 'success', content: '已处理' },
        card: { type: 'raw', data: resolvedCard },
    });
}
async function handleFormSubmit(input) {
    const requestId = input.submitValue.requestId;
    const target = resolvePendingCardTarget({
        kind: 'questionnaire',
        requestId,
        pendingMap: input.feishuPendingQuestionnaires,
        payloadChatId: nonEmptyPayloadChatId(input.payload.open_chat_id),
        getAdapter: input.getAdapter,
        receivedLog: {},
        receivedMessage: 'Feishu questionnaire submit received',
    });
    if ('response' in target)
        return target.response;
    const { pending, adapter } = target;
    if (input.inFlightQuestionnaires.has(requestId)) {
        return json({ ok: true, ignored: true, reason: 'questionnaire-in-flight', requestId });
    }
    let reply;
    try {
        reply = input.questionnaireBridge.buildReply({
            requestId,
            answers: mapFormValueToAnswers(pending.request, extractFormValue(input.rawBody)),
        });
    }
    catch (err) {
        logger.error({ err, requestId, pendingClientName: pending.clientName }, 'Feishu questionnaire reply construction failed');
        return json({
            ok: false,
            requestId,
            error: err instanceof Error ? err.message : String(err),
            toast: { type: 'error', content: '提交失败，请稍后再试' },
        });
    }
    const agentName = pending.request.requester?.agentName ?? input.agentName;
    input.inFlightQuestionnaires.add(requestId);
    // The submit IS the user reply; count it regardless of downstream outcome.
    input.metrics?.incr('channel_ask_user_total', { channel: 'feishu', phase: 'replied' });
    try {
        await input.questionnaireBridge.submit({
            ctx: legacyPayloadContext(input.payload, adapter.clientName, pending.chatId),
            reply,
        });
        const outcome = await resolveSubmitOutcome(input, agentName, requestId, reply);
        if (outcome.status === 'retryable') {
            input.inFlightQuestionnaires.delete(requestId);
            return json({
                ok: false,
                requestId,
                error: outcome.code ?? 'QUESTIONNAIRE_REPLY_RETRYABLE',
                toast: { type: 'error', content: '提交失败，请稍后再试' },
            });
        }
        // Accepted and terminal outcomes consume the pending entry before the
        // best-effort Feishu card patch.
        input.inFlightQuestionnaires.delete(requestId);
        input.feishuPendingQuestionnaires.delete(requestId);
        return finishAcceptedOrTerminalSubmit({ adapter, pending, requestId, outcome });
    }
    catch (err) {
        logger.error({ err, requestId, pendingClientName: pending.clientName }, 'Feishu questionnaire submission failed unexpectedly');
        input.inFlightQuestionnaires.delete(requestId);
        return json({
            ok: false,
            requestId,
            error: err instanceof Error ? err.message : String(err),
            toast: { type: 'error', content: '提交失败，请稍后再试' },
        });
    }
}
/**
 * Terminal-state completion for an accepted / terminal questionnaire submit:
 * pick the matching card morph, PATCH it best-effort and shape the exact v1
 * response body (toast + raw card).
 */
async function finishAcceptedOrTerminalSubmit(scope) {
    const { adapter, pending, requestId, outcome } = scope;
    const terminal = outcome.status === 'terminal';
    const terminalCode = outcome.status === 'terminal' ? outcome.code : undefined;
    const alreadyAnswered = terminalCode === 'QUESTIONNAIRE_ALREADY_ANSWERED';
    const terminalCard = outcome.status === 'accepted' || alreadyAnswered
        ? buildQuestionnaireSubmittedCard(pending.request)
        : buildQuestionnaireExpiredCard(pending.request);
    await patchSubmittedCard(adapter, pending.messageId, terminalCard, requestId);
    return json({
        ok: true,
        requestId,
        ...(terminal ? { terminal: true, error: terminalCode ?? 'QUESTIONNAIRE_TERMINAL' } : {}),
        toast: {
            type: terminal ? 'info' : 'success',
            content: terminal ? '该问卷已处理或已过期' : '已提交',
        },
        card: { type: 'raw', data: terminalCard },
    });
}
/** Drive the host reply seam; absent seam or void result defaults to accepted. */
async function resolveSubmitOutcome(input, agentName, requestId, reply) {
    if (!input.submitQuestionnaireReply)
        return { status: 'accepted' };
    const resolved = await input.submitQuestionnaireReply({ agentName, requestId, reply });
    return resolved ?? { status: 'accepted' };
}
function legacyPayloadContext(payload, clientName, fallbackChatId = '') {
    return {
        platform: 'feishu',
        chatType: 'p2p',
        chatId: String(payload.open_chat_id ?? fallbackChatId),
        senderId: String(payload.open_id ?? payload.user_id ?? ''),
        clientName: clientName || feishuClientId('mavis'),
    };
}
function nonEmptyPayloadChatId(value) {
    return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}
async function patchSubmittedCard(adapter, messageId, submittedCard, requestId) {
    if (!messageId) {
        logger.warn({ requestId, reason: 'missing_pending_message_id' }, 'Feishu questionnaire submitted card patch skipped');
        return;
    }
    try {
        logger.info({ messageId, requestId }, 'Feishu questionnaire submitted card patch started');
        await adapter.patchCard(messageId, submittedCard);
        logger.info({ messageId }, 'Feishu questionnaire submitted card patch completed');
    }
    catch (err) {
        logger.warn({ err, messageId, requestId }, 'Feishu questionnaire submitted card patch failed');
    }
}
/**
 * PATCH the permission card into its terminal (resolved) state. Best-effort —
 * a missing message id or a transport failure is logged, never thrown, so a
 * failed morph cannot turn a settled permission into an HTTP error.
 */
async function patchResolvedCard(adapter, messageId, resolvedCard, requestId) {
    if (!messageId) {
        logger.warn({ requestId, reason: 'missing_pending_message_id' }, 'Feishu permission resolved card patch skipped');
        return;
    }
    try {
        await adapter.patchCard(messageId, resolvedCard);
        logger.info({ messageId, requestId }, 'Feishu permission resolved card patch completed');
    }
    catch (err) {
        logger.warn({ err, messageId, requestId }, 'Feishu permission resolved card patch failed');
    }
}
//# sourceMappingURL=feishu-card-action.js.map