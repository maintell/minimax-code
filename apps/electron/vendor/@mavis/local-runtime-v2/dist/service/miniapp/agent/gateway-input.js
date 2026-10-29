import { isMiniAppAgentPermissionDecision, MINIAPP_AGENT_MAX_TEXT_LENGTH, } from '@mavis/shared/miniapp-surface';
import { isMiniAppAgentWhenBusy, } from './contracts.js';
import { readMiniAppAgentModelSelection } from './model-selection.js';
/** Shape checks of untrusted Agent API arguments; availability is checked where it is used. */
const MAX_REQUEST_ID_LENGTH = 256;
export function invalidText(text) {
    return typeof text === 'string' && text.trim() && text.length <= MINIAPP_AGENT_MAX_TEXT_LENGTH
        ? undefined
        : 'Mini App Agent text must be non-empty and bounded';
}
/** `model` is optional; once given, it must have the contract shape (availability is checked later). */
export function readRequestedModel(value) {
    if (value === undefined)
        return { call: {} };
    const model = readMiniAppAgentModelSelection(value);
    return model
        ? { call: { model } }
        : {
            call: {},
            invalid: 'Mini App Agent model must be { providerId, modelId, variant?, thinking?: { effort } }',
        };
}
/**
 * `agent` is optional and only chooses the agent of a session that is being created; once given it
 * must be a non-empty string (that it names an offered agent is checked later).
 */
export function readRequestedAgent(value, sessionId) {
    if (value === undefined)
        return { call: {} };
    if (sessionId !== undefined) {
        return { call: {}, invalid: 'Mini App Agent agent can only be chosen when creating a session' };
    }
    return typeof value === 'string' && value.trim()
        ? { call: { agent: value } }
        : { call: {}, invalid: 'Mini App Agent agent must be a non-empty agent name' };
}
/** `whenBusy` is optional and only continues an existing session. */
export function readWhenBusy(value, sessionId) {
    if (value === undefined)
        return { call: {} };
    if (!isMiniAppAgentWhenBusy(value)) {
        return { call: {}, invalid: 'Mini App Agent whenBusy must be queue or steer' };
    }
    return sessionId === undefined
        ? { call: {}, invalid: 'Mini App Agent whenBusy needs a sessionId' }
        : { call: { whenBusy: value } };
}
export function invalidAnswer(input) {
    if (!isId(input.sessionId) || !isId(input.requestId) || !Array.isArray(input.answers)) {
        return 'Mini App Agent answer needs a sessionId, a requestId and an answers list';
    }
    return undefined;
}
export function invalidReply(input) {
    if (!isId(input.sessionId) || !isId(input.requestId)) {
        return 'Mini App Agent reply needs a sessionId and a requestId';
    }
    return isMiniAppAgentPermissionDecision(input.decision)
        ? undefined
        : 'Mini App Agent reply decision must be allowOnce or deny';
}
export function isId(value) {
    return typeof value === 'string' && value.length > 0 && value.length <= MAX_REQUEST_ID_LENGTH;
}
//# sourceMappingURL=gateway-input.js.map