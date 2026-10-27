import { logger } from '../common/logger.js';
export const QUESTIONNAIRE_ROW_SELECT = `
  request_id, session_id, agent_name, msg_id, origin_channel_context_json, request_json,
  status, created_at, answered_at, reply_payload, injected_at, dismissed_at, response_mode
`;
export const QUALIFIED_QUESTIONNAIRE_ROW_SELECT = `
  qr.request_id, qr.session_id, qr.agent_name, qr.msg_id, qr.origin_channel_context_json,
  qr.request_json,
  qr.status, qr.created_at, qr.answered_at, qr.reply_payload, qr.injected_at,
  qr.dismissed_at, qr.response_mode
`;
export function toQuestionnaireRequestRecord(row) {
    const requestId = requireString(row.request_id, 'request_id');
    const sessionId = requireString(row.session_id, 'session_id');
    let request;
    try {
        request = JSON.parse(requireString(row.request_json, 'request_json'));
    }
    catch {
        request = {
            schemaVersion: 2,
            id: requestId,
            presentation: {
                replaceComposer: true,
                showProgress: true,
                allowBackNavigation: true,
            },
            steps: [],
            status: 'expired',
            createdAt: Number(row.created_at ?? 0),
        };
    }
    let replyPayload;
    if (row.reply_payload) {
        try {
            replyPayload = JSON.parse(row.reply_payload);
        }
        catch {
            replyPayload = undefined;
        }
    }
    const originChannelContext = parseQuestionnaireOriginChannelContext(row.origin_channel_context_json);
    const responseMode = parseResponseMode(row.response_mode, requestId);
    return {
        requestId,
        sessionId,
        ...(row.agent_name ? { agentName: row.agent_name } : {}),
        ...(row.msg_id ? { msgId: row.msg_id } : {}),
        ...(originChannelContext ? { originChannelContext } : {}),
        request,
        ...(responseMode ? { responseMode } : {}),
        status: isValidStatus(row.status) ? row.status : 'pending',
        createdAt: Number(row.created_at ?? 0),
        ...(typeof row.answered_at === 'number' ? { answeredAt: row.answered_at } : {}),
        ...(replyPayload ? { replyPayload } : {}),
        ...(typeof row.injected_at === 'number' ? { injectedAt: row.injected_at } : {}),
        ...(typeof row.dismissed_at === 'number' ? { dismissedAt: row.dismissed_at } : {}),
    };
}
export function parseQuestionnaireOriginChannelContext(raw) {
    if (!raw)
        return undefined;
    try {
        const value = JSON.parse(raw);
        if (!value)
            return undefined;
        if (typeof value.platform !== 'string' ||
            typeof value.chatType !== 'string' ||
            typeof value.chatId !== 'string' ||
            typeof value.senderId !== 'string' ||
            typeof value.clientName !== 'string') {
            return undefined;
        }
        const threadId = typeof value.threadId === 'string' ? value.threadId : undefined;
        const sourceMessageId = typeof value.sourceMessageId === 'string' ? value.sourceMessageId : undefined;
        const contextToken = typeof value.contextToken === 'string' ? value.contextToken : undefined;
        return {
            platform: value.platform,
            chatType: value.chatType,
            chatId: value.chatId,
            senderId: value.senderId,
            clientName: value.clientName,
            ...(threadId ? { threadId } : {}),
            ...(sourceMessageId ? { sourceMessageId } : {}),
            ...(contextToken ? { contextToken } : {}),
        };
    }
    catch {
        return undefined;
    }
}
/**
 * The column is written only by the runtime, so an unknown value means a
 * newer or corrupted row. Treat it as legacy: the legacy lifecycle is the
 * conservative one (it keeps every gate), and it is what older builds did.
 */
function parseResponseMode(value, requestId) {
    if (value === 'sync' || value === 'async')
        return value;
    if (value !== null && value !== undefined) {
        logger.warn({ requestId, rawResponseMode: String(value), reason: 'unknown_response_mode' }, 'Questionnaire row has an unknown response_mode; treating it as legacy');
    }
    return undefined;
}
function isValidStatus(value) {
    return (value === 'pending' ||
        value === 'answered' ||
        value === 'expired' ||
        value === 'superseded' ||
        value === 'dismissed');
}
function requireString(value, column) {
    if (typeof value === 'string')
        return value;
    throw new Error(`questionnaire_requests.${column} is missing`);
}
export function isOwnedActionRequestJson(raw) {
    if (!raw)
        return false;
    try {
        return isOwnedActionRequest(normalizePersistedQuestionnaireRequest(JSON.parse(raw)));
    }
    catch {
        return false;
    }
}
export function isOwnedActionRequest(request) {
    return (typeof request.mode === 'string' &&
        request.mode !== 'questionnaire' &&
        request.mode !== 'feature-enable');
}
export function toCompatibleQuestionnaireRequestRecord(row) {
    const record = toQuestionnaireRequestRecord(row);
    return {
        ...record,
        request: normalizePersistedQuestionnaireRequest(record.request),
    };
}
/**
 * Read-only compatibility for rows written before Questionnaire adopted
 * `mode` / `modePayload`. New writes remain canonical and old JSON is not
 * rewritten, so rollback keeps seeing its original storage contract.
 */
function normalizePersistedQuestionnaireRequest(request) {
    if (typeof request.mode === 'string')
        return request;
    const { purpose, planReview, ...canonical } = request;
    const legacyPurpose = purpose;
    if (legacyPurpose === 'plan_enter_confirmation') {
        return { ...canonical, mode: 'plan' };
    }
    if (legacyPurpose === 'plan_exit_review') {
        return {
            ...canonical,
            mode: 'plan',
            modePayload: { planReview: readPreModePlanReview(planReview) },
        };
    }
    return { ...canonical, mode: 'questionnaire' };
}
function readPreModePlanReview(value) {
    const markdown = typeof value === 'object' &&
        value !== null &&
        typeof Reflect.get(value, 'markdown') === 'string'
        ? Reflect.get(value, 'markdown')
        : '';
    const path = typeof value === 'object' && value !== null && typeof Reflect.get(value, 'path') === 'string'
        ? Reflect.get(value, 'path')
        : '';
    // Keep incomplete persisted Plan reviews inside the Plan-owned recovery lane.
    // The owner validates both fields and fails closed instead of letting startup
    // recovery inject this row as an ordinary Questionnaire reply.
    return { markdown, path };
}
//# sourceMappingURL=sqlite-row-codec.js.map