import { QuestionnairePurpose as DesktopQuestionnairePurpose, QuestionnaireSelectionMode, QuestionnaireStatus, QuestionnaireReopenReason, } from '@mavis/thrift-gen/generated/desktop-service/types';
import { getQuestionnaireCountdownSeconds } from '../questionnaire/request-view.js';
/**
 * DesktopService projections for questionnaire rows, split out of the
 * service adapter to keep it inside the local-runtime layout budget.
 */
export function toDesktopQuestionnaireResponse(record) {
    if (!record)
        return {};
    return {
        request: toDesktopRequestView(record),
        status: toDesktopStatus(record.status),
        sessionId: record.sessionId,
        agentName: record.agentName,
        createdAt: record.createdAt,
        answeredAt: record.answeredAt,
        dismissedAt: record.dismissedAt,
    };
}
/**
 * Request fields come from `request_json`; the AskUser v2 fields come from
 * the row: `responseMode` from the authoritative column, `answeredAt` /
 * `injectedAt` from their columns, `countdownSeconds` from `request_json`
 * (async only). `responseMode` and `countdownSeconds` stay unset for legacy
 * rows; `answeredAt` / `injectedAt` are projected for legacy rows too whenever
 * the columns are set (additive optional fields, older clients ignore them).
 */
export function toDesktopRequestView(record) {
    const request = record.request;
    return {
        schemaVersion: request.schemaVersion,
        id: request.id,
        title: request.title,
        tool: request.tool
            ? { messageId: request.tool.message_id, callId: request.tool.call_id }
            : undefined,
        requester: request.requester,
        presentation: request.presentation,
        steps: request.steps.map((step) => ({
            ...step,
            selectionMode: toDesktopSelectionMode(step.selectionMode),
            options: step.options,
        })),
        expiresAt: request.expiresAt,
        purpose: request.purpose === 'goal' ? DesktopQuestionnairePurpose.Goal : undefined,
        status: toDesktopStatus(record.status),
        createdAt: request.createdAt,
        mode: request.mode ?? 'questionnaire',
        reopenReason: request.reopenReason === 'content_recall'
            ? QuestionnaireReopenReason.ContentRecall
            : undefined,
        prefillAnswers: request.prefillAnswers?.map((answer) => ({
            ...answer,
            selectedOptionIds: [...answer.selectedOptionIds],
        })),
        ...(request.modePayload
            ? {
                modePayload: {
                    ...(request.modePayload.featureKey
                        ? { featureKey: request.modePayload.featureKey }
                        : {}),
                    ...(request.modePayload.planReview
                        ? {
                            planReview: {
                                markdown: request.modePayload.planReview.markdown,
                                path: request.modePayload.planReview.path,
                            },
                        }
                        : {}),
                },
            }
            : {}),
        // response_mode is a plain string on the wire ("sync" / "async"), so the
        // storage value passes through without a numeric-enum mapping.
        ...(record.responseMode ? { responseMode: record.responseMode } : {}),
        ...(record.answeredAt !== undefined ? { answeredAt: record.answeredAt } : {}),
        ...(record.injectedAt !== undefined ? { injectedAt: record.injectedAt } : {}),
        ...(record.responseMode === 'async'
            ? { countdownSeconds: getQuestionnaireCountdownSeconds(request) }
            : {}),
        ...(record.responseMode === 'sync' && request.syncWaiting !== undefined
            ? { syncWaiting: request.syncWaiting }
            : {}),
        ...(record.responseMode && request.originTurnRunning !== undefined
            ? { originTurnRunning: request.originTurnRunning }
            : {}),
    };
}
export function toDesktopReplyResponse(result) {
    return {
        ok: result.ok,
        requestId: result.requestId,
        sessionId: result.sessionId,
        ...(result.agentName ? { agentName: result.agentName } : {}),
        answeredAt: result.answeredAt,
        ...(result.state ? { state: toDesktopStateView(result.state) } : {}),
    };
}
function toDesktopStateView(state) {
    return {
        requestId: state.requestId,
        ...(state.syncWaiting !== undefined ? { syncWaiting: state.syncWaiting } : {}),
        status: toDesktopStatus(state.status),
        // Same pass-through as toDesktopRequestView: wire carries the string.
        ...(state.responseMode ? { responseMode: state.responseMode } : {}),
        ...(state.answeredAt !== undefined ? { answeredAt: state.answeredAt } : {}),
        ...(state.injectedAt !== undefined ? { injectedAt: state.injectedAt } : {}),
    };
}
function toDesktopSelectionMode(value) {
    return value === 'multiple'
        ? QuestionnaireSelectionMode.Multiple
        : QuestionnaireSelectionMode.Single;
}
function toDesktopStatus(value) {
    switch (value) {
        case 'answered':
            return QuestionnaireStatus.Answered;
        case 'expired':
            return QuestionnaireStatus.Expired;
        case 'superseded':
            return QuestionnaireStatus.Superseded;
        case 'dismissed':
            return QuestionnaireStatus.Dismissed;
        case 'pending':
        default:
            return QuestionnaireStatus.Pending;
    }
}
//# sourceMappingURL=desktop-questionnaire-view.js.map