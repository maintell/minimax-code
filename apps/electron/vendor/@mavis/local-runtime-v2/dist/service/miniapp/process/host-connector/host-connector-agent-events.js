/**
 * Wire shapes of `agent.*` event frames and the field checks they share with the result
 * decoders: what the Host may send for a run and for an observer, copied by exact keys.
 */
import { isMiniAppAgentQuestionMode } from '@mavis/shared/miniapp-surface';
import { readMiniAppAgentModelSelection } from '../../agent/model-selection.js';
import { HostConnectorProtocolError } from './host-connector-errors.js';
import { hasExactKeys, isBoundedIdentifier, isRecord } from './host-connector-wire.js';
export function isModelSelection(value) {
    return readMiniAppAgentModelSelection(value) !== null;
}
export function decodeAgentRunEvent(value, observed = false) {
    const event = copyAgentRunEvent(value, observed);
    if (event)
        return event;
    if (isRecord(value) && typeof value.type === 'string' && !agentEventShape(value.type, observed)) {
        return undefined;
    }
    throw new HostConnectorProtocolError('Mini App Agent event is invalid');
}
export const isString = (field) => typeof field === 'string';
export const isBoolean = (field) => typeof field === 'boolean';
const TEXT_EVENT = { required: ['text'], valid: (value) => isString(value.text) };
const AGENT_EVENT_SHAPES = {
    'run.queued': {
        required: ['position'],
        turnId: 'absent',
        sessionIdOptional: true,
        valid: (value) => typeof value.position === 'number' &&
            Number.isSafeInteger(value.position) &&
            value.position >= 1,
    },
    'turn.started': { required: ['model'], valid: (value) => isModelSelection(value.model) },
    'text.delta': TEXT_EVENT,
    'message.committed': TEXT_EVENT,
    'tool.started': { required: ['name'], valid: (value) => isString(value.name) },
    'tool.finished': {
        required: ['name', 'ok'],
        valid: (value) => isString(value.name) && typeof value.ok === 'boolean',
    },
    'message.pending': { required: [], valid: () => true },
    'message.steered': { required: [], valid: () => true },
    'permission.requested': {
        required: ['requestId', 'toolName', 'reason'],
        optional: ['toolInput'],
        turnId: 'optional',
        valid: (value) => isBoundedIdentifier(value.requestId) &&
            isString(value.toolName) &&
            isString(value.reason) &&
            isOptional(value, 'toolInput', isString),
    },
    'question.requested': {
        required: ['requestId', 'mode', 'request'],
        turnId: 'optional',
        valid: (value) => isBoundedIdentifier(value.requestId) &&
            isMiniAppAgentQuestionMode(value.mode) &&
            isQuestionnaireRequest(value.request),
    },
    'turn.finished': {
        required: ['status'],
        optional: ['text', 'error'],
        valid: (value) => isRunStatus(value.status) &&
            isOptional(value, 'text', isString) &&
            isOptional(value, 'error', isResultError),
    },
};
/** `observe({ all: true })` adds the session `title` to the lifecycle events. */
function withTitle(shape) {
    return {
        ...shape,
        optional: [...(shape.optional ?? []), 'title'],
        valid: (value) => shape.valid(value) && isOptional(value, 'title', isString),
    };
}
/**
 * An observer's events: no `run.queued` or asks, and `turn.started` names the session's model
 * only when the Host could read it.
 */
const OBSERVED_EVENT_SHAPES = {
    'turn.started': withTitle({
        required: [],
        optional: ['model'],
        valid: (value) => isOptional(value, 'model', isModelSelection),
    }),
    'text.delta': AGENT_EVENT_SHAPES['text.delta'],
    'message.committed': withTitle(AGENT_EVENT_SHAPES['message.committed']),
    'tool.started': AGENT_EVENT_SHAPES['tool.started'],
    'tool.finished': AGENT_EVENT_SHAPES['tool.finished'],
    'turn.finished': withTitle(AGENT_EVENT_SHAPES['turn.finished']),
};
function hasAgentEventEnvelope(value, shape) {
    const sessionKey = shape.sessionIdOptional ? 'optional' : 'required';
    const turnKey = shape.turnId ?? 'required';
    const required = [
        'type',
        ...(sessionKey === 'required' ? ['sessionId'] : []),
        ...(turnKey === 'required' ? ['turnId'] : []),
        ...shape.required,
    ];
    const optional = [
        ...(sessionKey === 'optional' ? ['sessionId'] : []),
        ...(turnKey === 'optional' ? ['turnId'] : []),
        ...(shape.optional ?? []),
    ];
    return (isOptional(value, 'sessionId', isBoundedIdentifier) &&
        isOptional(value, 'turnId', isBoundedIdentifier) &&
        hasOptionalKeys(value, required, optional));
}
function agentEventShape(type, observed) {
    const shapes = observed
        ? OBSERVED_EVENT_SHAPES
        : AGENT_EVENT_SHAPES;
    return Object.prototype.hasOwnProperty.call(shapes, type) ? shapes[type] : undefined;
}
export function copyAgentRunEvent(raw, observed = false) {
    if (!isRecord(raw) || typeof raw.type !== 'string')
        return undefined;
    const value = Object.fromEntries(Object.entries(raw).filter(([, field]) => field !== undefined));
    const shape = agentEventShape(raw.type, observed);
    if (!shape || !hasAgentEventEnvelope(value, shape) || !shape.valid(value))
        return undefined;
    // Every field is now a validated primitive except `error`, whose exact keys were checked,
    // and the questionnaire `request`, whose size the response frame bound limits.
    return {
        ...value,
        ...(isRecord(value.error) ? { error: { ...value.error } } : {}),
        ...(raw.type === 'turn.started' && value.model !== undefined
            ? { model: readMiniAppAgentModelSelection(value.model) }
            : {}),
    };
}
export function isRunStatus(value) {
    return value === 'finished' || value === 'error' || value === 'aborted' || value === 'steered';
}
/** Envelope check only; the step list is passed through as the Host chat renders it. */
export function isQuestionnaireRequest(value) {
    return (isRecord(value) &&
        value.schemaVersion === 2 &&
        isBoundedIdentifier(value.id) &&
        Array.isArray(value.steps));
}
export function isOptional(value, key, check) {
    return !(key in value) || check(value[key]);
}
export function isResultError(value) {
    return (isRecord(value) &&
        hasExactKeys(value, ['code', 'message']) &&
        typeof value.code === 'string' &&
        typeof value.message === 'string');
}
export function hasOptionalKeys(value, required, optional) {
    return hasExactKeys(value, [...required, ...optional.filter((key) => key in value)]);
}
//# sourceMappingURL=host-connector-agent-events.js.map