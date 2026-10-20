/**
 * Request header that carries the Host-issued loopback credential to a Mini App's own
 * port. Only the name is shared; the value stays in Electron main and local-runtime.
 */
export const MINIAPP_LOOPBACK_TOKEN_HEADER = 'x-mavis-miniapp-token';
/** Bounds one untrusted page request; input behavior remains owned by the chat input. */
export const MINIAPP_COMPOSER_MAX_TEXT_LENGTH = 100_000;
const MINIAPP_COMPOSER_FAILURE_CODES = [
    'user_cancelled',
    'invalid_request',
    'text_too_large',
    'not_allowed',
    'target_unavailable',
    'result_unknown',
];
/** Both IPC boundaries use the same allowlist and discard all non-contract fields. */
export function parseMiniAppComposerAppendResult(value) {
    if (!value || typeof value !== 'object')
        return null;
    const result = value;
    if (result.success === true)
        return { success: true };
    const code = MINIAPP_COMPOSER_FAILURE_CODES.find((candidate) => candidate === result.code);
    return result.success === false && code ? { success: false, code } : null;
}
/** Bounds one untrusted page Agent request before it crosses into Main. */
export const MINIAPP_AGENT_MAX_TEXT_LENGTH = 100_000;
export const MINIAPP_AGENT_FAILURE_CODES = [
    'invalid_request',
    'not_permitted',
    'busy',
    'session_not_found',
    'runtime_unavailable',
    'cancelled',
    'result_unknown',
    'request_not_found',
];
export function isMiniAppAgentBusyReason(value) {
    return value === 'session_busy' || value === 'queue_full';
}
/** Bounds a page-chosen request id; it is only a per-page correlation key. */
export const MINIAPP_AGENT_MAX_REQUEST_ID_LENGTH = 128;
/** Non-empty, bounded and free of control characters; checked on both sides of the IPC. */
export function isMiniAppAgentRequestId(value) {
    return (typeof value === 'string' &&
        value.length > 0 &&
        value.length <= MINIAPP_AGENT_MAX_REQUEST_ID_LENGTH &&
        !/[\u0000-\u001f\u007f]/u.test(value));
}
/** Bounds one untrusted questionnaire answer list before it crosses into Main. */
export const MINIAPP_AGENT_MAX_ANSWERS = 64;
export const MINIAPP_AGENT_MAX_ANSWER_TEXT_LENGTH = 4_096;
export function isMiniAppAgentPermissionDecision(value) {
    return value === 'allowOnce' || value === 'deny';
}
function isBoundedAnswerText(value) {
    return typeof value === 'string' && value.length <= MINIAPP_AGENT_MAX_ANSWER_TEXT_LENGTH;
}
const ANSWER_KEYS = new Set([
    'stepId',
    'selectedOptionIds',
    'selectedOther',
    'otherText',
    'skipped',
]);
function readMiniAppAgentAnswer(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return null;
    const input = value;
    if (!Object.keys(input).every((key) => ANSWER_KEYS.has(key)))
        return null;
    const { stepId, selectedOptionIds, selectedOther, otherText, skipped } = input;
    if (!isNonEmptyString(stepId) || !isBoundedAnswerText(stepId))
        return null;
    if (!Array.isArray(selectedOptionIds) ||
        selectedOptionIds.length > MINIAPP_AGENT_MAX_ANSWERS ||
        !selectedOptionIds.every(isBoundedAnswerText)) {
        return null;
    }
    if (typeof selectedOther !== 'boolean')
        return null;
    if (otherText !== undefined && !isBoundedAnswerText(otherText))
        return null;
    if (skipped !== undefined && typeof skipped !== 'boolean')
        return null;
    return {
        stepId,
        selectedOptionIds: [...selectedOptionIds],
        selectedOther,
        ...(otherText !== undefined ? { otherText } : {}),
        ...(skipped !== undefined ? { skipped } : {}),
    };
}
/** Closed-key, bounded copy of questionnaire answers; null when any entry is malformed. */
export function readMiniAppAgentAnswers(value) {
    if (!Array.isArray(value) || value.length > MINIAPP_AGENT_MAX_ANSWERS)
        return null;
    const answers = [];
    for (const entry of value) {
        const answer = readMiniAppAgentAnswer(entry);
        if (!answer)
            return null;
        answers.push(answer);
    }
    return answers;
}
/** Page `reply` payload, checked in the preload and again in Main; null when malformed. */
export function readMiniAppAgentReplyRequest(value) {
    if (!value || typeof value !== 'object')
        return null;
    const { sessionId, requestId, decision } = value;
    return isNonEmptyString(sessionId) &&
        isNonEmptyString(requestId) &&
        isMiniAppAgentPermissionDecision(decision)
        ? { sessionId, requestId, decision }
        : null;
}
/**
 * Wire-only `observe` flag of a turn-following request (`run`, `answer`): the preload sets it
 * when the page passed `onEvent`, and only then does Main subscribe the run to events (which
 * the runtime also counts as "someone can answer this run's asks"). Absent means `false`;
 * null when present but not a boolean.
 */
export function readMiniAppAgentObserveFlag(value) {
    if (value === undefined)
        return false;
    return typeof value === 'boolean' ? value : null;
}
/**
 * Page `answer` payload with its (page-chosen or preload-generated) `requestId` and the
 * wire-only `observe` flag, checked in the preload and again in Main; null when malformed.
 */
export function readMiniAppAgentAnswerRequest(value) {
    if (!value || typeof value !== 'object')
        return null;
    const input = value;
    const answers = readMiniAppAgentAnswers(input.answers);
    const observe = readMiniAppAgentObserveFlag(input.observe);
    const model = readOptionalModel(input.model);
    const { sessionId, questionId, requestId } = input;
    return isNonEmptyString(sessionId) &&
        isNonEmptyString(questionId) &&
        answers !== null &&
        observe !== null &&
        model !== null &&
        isMiniAppAgentRequestId(requestId)
        ? { sessionId, questionId, answers, requestId, observe, ...(model ? { model } : {}) }
        : null;
}
/** Page `run` payload with its (page-chosen or preload-generated) `requestId`; null when malformed. */
export function readMiniAppAgentRunRequest(value) {
    if (!value || typeof value !== 'object')
        return null;
    const input = value;
    const { text, sessionId, requestId, agent } = input;
    const observe = readMiniAppAgentObserveFlag(input.observe);
    const model = readOptionalModel(input.model);
    if (typeof text !== 'string' || text.length > MINIAPP_AGENT_MAX_TEXT_LENGTH)
        return null;
    if (!isMiniAppAgentRequestId(requestId) || observe === null || model === null)
        return null;
    if (!isOptionalNonEmptyString(sessionId) || !isOptionalNonEmptyString(agent))
        return null;
    return {
        requestId,
        text,
        ...(sessionId !== undefined ? { sessionId } : {}),
        ...(model ? { model } : {}),
        ...(agent !== undefined ? { agent } : {}),
        observe,
    };
}
/** `undefined` when absent, `null` when present but malformed. */
function readOptionalModel(value) {
    return value === undefined ? undefined : readMiniAppAgentModelSelection(value);
}
/**
 * Copies a model selection from untrusted input, dropping extra keys. Mirrors the runtime's
 * reader: `providerId` / `modelId` are non-empty strings, an empty `variant` is kept (thinking explicitly off).
 */
export function readMiniAppAgentModelSelection(value) {
    if (!isPlainRecord(value))
        return null;
    const { providerId, modelId, variant } = value;
    if (!isNonEmptyString(providerId) || !isNonEmptyString(modelId))
        return null;
    if (variant !== undefined && typeof variant !== 'string')
        return null;
    const thinking = readSelectionThinking(value.thinking);
    if (thinking === null)
        return null;
    return {
        providerId,
        modelId,
        ...(variant === undefined ? {} : { variant }),
        ...(thinking ? { thinking } : {}),
    };
}
/** `undefined` when absent, `null` when present but malformed. */
function readSelectionThinking(value) {
    if (value === undefined)
        return undefined;
    return isPlainRecord(value) && typeof value.effort === 'string' ? { effort: value.effort } : null;
}
function readStringList(value) {
    return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
        ? [...value]
        : null;
}
/** `undefined` when absent, `null` when present but malformed. */
function readOptionThinking(value) {
    if (value === undefined)
        return undefined;
    if (!isPlainRecord(value))
        return null;
    const efforts = readStringList(value.efforts);
    const defaultEffort = value.default;
    if (!efforts || (defaultEffort !== undefined && typeof defaultEffort !== 'string'))
        return null;
    return { efforts, ...(defaultEffort !== undefined ? { default: defaultEffort } : {}) };
}
function readModelOption(value) {
    if (!isPlainRecord(value))
        return null;
    const { providerId, modelId, displayName } = value;
    if (!isNonEmptyString(providerId) || !isNonEmptyString(modelId))
        return null;
    if (typeof displayName !== 'string')
        return null;
    const variants = value.variants === undefined ? undefined : readStringList(value.variants);
    const thinking = readOptionThinking(value.thinking);
    if (variants === null || thinking === null)
        return null;
    return {
        providerId,
        modelId,
        displayName,
        ...(variants ? { variants } : {}),
        ...(thinking ? { thinking } : {}),
    };
}
/** Allowlist copy of the model catalog; null when any part is malformed. */
export function readMiniAppAgentModels(value) {
    if (!isPlainRecord(value) || !Array.isArray(value.models))
        return null;
    const models = [];
    for (const entry of value.models) {
        const option = readModelOption(entry);
        if (!option)
            return null;
        models.push(option);
    }
    const fallback = readMiniAppAgentModelSelection(value.default);
    const host = readOptionalModel(value.host);
    if (!fallback || host === null)
        return null;
    return { models, default: fallback, ...(host ? { host } : {}) };
}
function readAgentOption(value) {
    if (!isPlainRecord(value))
        return null;
    const { name, displayName, primary } = value;
    return isNonEmptyString(name) && typeof displayName === 'string' && typeof primary === 'boolean'
        ? { name, displayName, primary }
        : null;
}
/** Allowlist copy of the agent list; null when any entry is malformed. */
export function readMiniAppAgentAgents(value) {
    if (!isPlainRecord(value) || !Array.isArray(value.agents))
        return null;
    const agents = [];
    for (const entry of value.agents) {
        const option = readAgentOption(entry);
        if (!option)
            return null;
        agents.push(option);
    }
    return { agents };
}
/** Page `create` payload (`{ agent? }`), checked in the preload and again in Main. */
export function readMiniAppAgentCreateRequest(value) {
    if (!isPlainRecord(value) || !isOptionalNonEmptyString(value.agent))
        return null;
    return value.agent !== undefined ? { agent: value.agent } : {};
}
export function readMiniAppAgentCreateResponse(value) {
    return isPlainRecord(value) && isNonEmptyString(value.sessionId)
        ? { sessionId: value.sessionId }
        : null;
}
/** Page `open` payload, checked in the preload and again in Main; null when malformed. */
export function readMiniAppAgentOpenRequest(value) {
    if (!value || typeof value !== 'object')
        return null;
    const { sessionId } = value;
    return isNonEmptyString(sessionId) ? { sessionId } : null;
}
/** Copies a Main `open` request for the Host renderer; null when malformed. */
export function readMiniAppAgentOpenSessionRequest(value) {
    if (!value || typeof value !== 'object')
        return null;
    const { hostSessionId, sessionId } = value;
    return isNonEmptyString(hostSessionId) && isNonEmptyString(sessionId)
        ? { hostSessionId, sessionId }
        : null;
}
export function readMiniAppAgentOpenSessionReply(value) {
    if (!value || typeof value !== 'object')
        return null;
    const { requestId, result } = value;
    if (!isNonEmptyString(requestId) || !result || typeof result !== 'object')
        return null;
    const { ok, code } = result;
    if (ok === true)
        return { requestId, result: { ok: true } };
    if (ok === false && (code === 'target_unavailable' || code === 'result_unknown')) {
        return { requestId, result: { ok: false, code } };
    }
    return null;
}
const MINIAPP_AGENT_RUNTIME_ERROR_CODES = {
    NOT_PERMITTED: 'not_permitted',
    BUSY: 'busy',
    SESSION_NOT_FOUND: 'session_not_found',
    INVALID_ARGUMENTS: 'invalid_request',
    AGENT_UNAVAILABLE: 'runtime_unavailable',
    REQUEST_CANCELLED: 'cancelled',
    AGENT_OUTCOME_UNKNOWN: 'result_unknown',
    REQUEST_NOT_FOUND: 'request_not_found',
};
/** Maps a runtime `MiniAppAgentErrorCode`; unknown codes return undefined. */
export function toMiniAppAgentFailureCode(runtimeCode) {
    return typeof runtimeCode === 'string' &&
        Object.prototype.hasOwnProperty.call(MINIAPP_AGENT_RUNTIME_ERROR_CODES, runtimeCode)
        ? MINIAPP_AGENT_RUNTIME_ERROR_CODES[runtimeCode]
        : undefined;
}
export function isMiniAppAgentFailureCode(value) {
    return MINIAPP_AGENT_FAILURE_CODES.some((code) => code === value);
}
function isNonEmptyString(value) {
    return typeof value === 'string' && value.length > 0;
}
function isOptionalNonEmptyString(value) {
    return value === undefined || isNonEmptyString(value);
}
/** Allowlist copy of a run result; returns null when a required field is malformed. */
export function readMiniAppAgentRunResult(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return null;
    const input = value;
    const { sessionId, turnId } = input;
    if (!isNonEmptyString(sessionId) || !isOptionalNonEmptyString(turnId))
        return null;
    const outcome = readRunOutcome(input);
    if (!outcome)
        return null;
    // A malformed model is dropped rather than failing a turn that already ran.
    const model = readOptionalModel(input.model);
    const pending = input.pendingQuestion;
    const pendingQuestion = pending && typeof pending === 'object'
        ? readPendingQuestion(pending)
        : null;
    if (pending !== undefined && !pendingQuestion)
        return null;
    return {
        sessionId,
        ...(turnId !== undefined ? { turnId } : {}),
        ...(model ? { model } : {}),
        ...outcome,
        ...(pendingQuestion ? { pendingQuestion } : {}),
    };
}
/** Reads `requestId` / `mode` / `request` of a run result's or event's questionnaire. */
function readPendingQuestion(input) {
    const { requestId, mode, request } = input;
    return isNonEmptyString(requestId) &&
        isMiniAppAgentQuestionMode(mode) &&
        isQuestionnaireRequest(request)
        ? { requestId, mode, request }
        : null;
}
export function isMiniAppAgentQuestionMode(value) {
    return value === 'questionnaire' || value === 'feature-enable' || value === 'plan';
}
/** Envelope check only; the steps are passed through as the Host chat renders them. */
function isQuestionnaireRequest(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return false;
    const request = value;
    return (request.schemaVersion === 2 && isNonEmptyString(request.id) && Array.isArray(request.steps));
}
function readRunOutcome(input) {
    if (input.status !== 'finished' && input.status !== 'error' && input.status !== 'aborted') {
        return null;
    }
    if (input.text !== undefined && typeof input.text !== 'string')
        return null;
    let error;
    if (input.error !== undefined) {
        if (!input.error || typeof input.error !== 'object')
            return null;
        const { code, message } = input.error;
        if (typeof code !== 'string' || typeof message !== 'string')
            return null;
        error = { code, message };
    }
    return {
        status: input.status,
        ...(input.text !== undefined ? { text: input.text } : {}),
        ...(error ? { error } : {}),
    };
}
/** Allowlist copy of one run event; unknown `type`s and malformed events return null. */
export function readMiniAppAgentRunEvent(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return null;
    const input = value;
    if (input.type === 'run.queued')
        return readRunQueuedEvent(input);
    const { sessionId } = input;
    if (!isNonEmptyString(sessionId))
        return null;
    if (input.type === 'question.requested')
        return readQuestionRequestedEvent(sessionId, input);
    if (input.type === 'permission.requested') {
        return readPermissionRequestedEvent(sessionId, input);
    }
    const { turnId } = input;
    if (!isNonEmptyString(turnId))
        return null;
    switch (input.type) {
        case 'turn.started': {
            const model = readMiniAppAgentModelSelection(input.model);
            return model ? { type: 'turn.started', sessionId, turnId, model } : null;
        }
        case 'text.delta':
        case 'message.committed':
            return typeof input.text === 'string'
                ? { type: input.type, sessionId, turnId, text: input.text }
                : null;
        case 'tool.started':
            return typeof input.name === 'string'
                ? { type: 'tool.started', sessionId, turnId, name: input.name }
                : null;
        case 'tool.finished':
            return typeof input.name === 'string' && typeof input.ok === 'boolean'
                ? { type: 'tool.finished', sessionId, turnId, name: input.name, ok: input.ok }
                : null;
        case 'turn.finished': {
            const outcome = readRunOutcome(input);
            return outcome ? { type: 'turn.finished', sessionId, turnId, ...outcome } : null;
        }
        default:
            return null;
    }
}
function readRunQueuedEvent(input) {
    const { sessionId, position } = input;
    if (!isOptionalNonEmptyString(sessionId))
        return null;
    if (typeof position !== 'number' || !Number.isSafeInteger(position) || position < 1)
        return null;
    return { type: 'run.queued', ...(sessionId !== undefined ? { sessionId } : {}), position };
}
function readPermissionRequestedEvent(sessionId, input) {
    const { turnId, requestId, toolName, toolInput, reason } = input;
    if (!isOptionalNonEmptyString(turnId) ||
        !isNonEmptyString(requestId) ||
        typeof toolName !== 'string' ||
        typeof reason !== 'string' ||
        (toolInput !== undefined && typeof toolInput !== 'string')) {
        return null;
    }
    return {
        type: 'permission.requested',
        sessionId,
        ...(turnId !== undefined ? { turnId } : {}),
        requestId,
        toolName,
        ...(toolInput !== undefined ? { toolInput } : {}),
        reason,
    };
}
function readQuestionRequestedEvent(sessionId, input) {
    const { turnId } = input;
    if (!isOptionalNonEmptyString(turnId))
        return null;
    const question = readPendingQuestion(input);
    if (!question)
        return null;
    return {
        type: 'question.requested',
        sessionId,
        ...(turnId !== undefined ? { turnId } : {}),
        ...question,
    };
}
/**
 * Both IPC boundaries parse the same envelope. Anything unrecognised is `result_unknown`: the
 * turn may already have run, so callers must not retry it automatically.
 */
export function parseMiniAppAgentRunResult(value) {
    if (value && typeof value === 'object') {
        const response = value;
        if (response.ok === true) {
            const result = readMiniAppAgentRunResult(response.result);
            if (result)
                return { ok: true, result };
        }
        else if (response.ok === false) {
            return readMiniAppAgentFailure(response);
        }
    }
    return { ok: false, code: 'result_unknown' };
}
/** Same envelope rules as `parseMiniAppAgentRunResult`; a reply has no result payload. */
export function parseMiniAppAgentReplyResult(value) {
    if (value && typeof value === 'object') {
        const response = value;
        if (response.ok === true)
            return { ok: true };
        if (response.ok === false)
            return readMiniAppAgentFailure(response);
    }
    return { ok: false, code: 'result_unknown' };
}
/** An unknown code is `result_unknown`; a malformed or non-`busy` `reason` is dropped. */
function readMiniAppAgentFailure(response) {
    const { code, reason } = response;
    if (!isMiniAppAgentFailureCode(code))
        return { ok: false, code: 'result_unknown' };
    return code === 'busy' && isMiniAppAgentBusyReason(reason)
        ? { ok: false, code, reason }
        : { ok: false, code };
}
function parseMiniAppAgentResultEnvelope(value, read) {
    if (value && typeof value === 'object') {
        const response = value;
        if (response.ok === true) {
            const result = read(response.result);
            if (result)
                return { ok: true, result };
        }
        else if (response.ok === false) {
            return readMiniAppAgentFailure(response);
        }
    }
    return { ok: false, code: 'result_unknown' };
}
/** Envelope of the `models` / `agents` / `create` invokes; malformed is `result_unknown`. */
export function parseMiniAppAgentModelsResult(value) {
    return parseMiniAppAgentResultEnvelope(value, readMiniAppAgentModels);
}
export function parseMiniAppAgentAgentsResult(value) {
    return parseMiniAppAgentResultEnvelope(value, readMiniAppAgentAgents);
}
export function parseMiniAppAgentCreateResult(value) {
    return parseMiniAppAgentResultEnvelope(value, readMiniAppAgentCreateResponse);
}
/** Same envelope as a reply acknowledgement. */
export function parseMiniAppAgentOpenResult(value) {
    return parseMiniAppAgentReplyResult(value);
}
/** Main passes the opaque handle id to the Mini App preload through Chromium argv. */
export const MINIAPP_SURFACE_ID_ARGUMENT_PREFIX = '--mavis-miniapp-surface-id=';
/**
 * `surface.window` manifest fields: the whitelisted `BaseWindowConstructorOptions`
 * passthrough for a popped-out Mini App window. Position, `parent`, `title`, and
 * close behavior are never declarable; the Host always applies those itself.
 * `clickThrough` is also the ceiling for the page's runtime window `update`.
 */
export const MINIAPP_SURFACE_WINDOW_DIMENSION_FIELDS = [
    'width',
    'height',
    'minWidth',
    'minHeight',
];
export const MINIAPP_SURFACE_WINDOW_BOOLEAN_FIELDS = [
    'resizable',
    'frame',
    'transparent',
    'alwaysOnTop',
    'skipTaskbar',
    'clickThrough',
];
export const MINIAPP_SURFACE_WINDOW_FIELDS = [
    ...MINIAPP_SURFACE_WINDOW_DIMENSION_FIELDS,
    ...MINIAPP_SURFACE_WINDOW_BOOLEAN_FIELDS,
];
export const MINIAPP_SURFACE_WINDOW_DIMENSION_MIN = 200;
export const MINIAPP_SURFACE_WINDOW_DIMENSION_MAX = 10_000;
const MINIAPP_SURFACE_WINDOW_FIELD_SET = new Set(MINIAPP_SURFACE_WINDOW_FIELDS);
const MINIAPP_SURFACE_WINDOW_MIN_PAIRS = [
    ['minWidth', 'width'],
    ['minHeight', 'height'],
];
function isSurfaceWindowDimension(value) {
    return (typeof value === 'number' &&
        Number.isInteger(value) &&
        value >= MINIAPP_SURFACE_WINDOW_DIMENSION_MIN &&
        value <= MINIAPP_SURFACE_WINDOW_DIMENSION_MAX);
}
/**
 * The full `surface.window` rule set, shared by the manifest reader and the
 * Electron broker (which re-validates instead of trusting the Utility side).
 * Returns a copy holding only the declared fields; `undefined` values count as absent.
 */
export function validateMiniAppSurfaceWindow(value) {
    if (!isPlainRecord(value))
        return { ok: false, reason: 'surface.window must be an object' };
    if (Object.keys(value).some((key) => !MINIAPP_SURFACE_WINDOW_FIELD_SET.has(key))) {
        return { ok: false, reason: 'surface.window contains an unknown field' };
    }
    const window = {};
    for (const key of MINIAPP_SURFACE_WINDOW_DIMENSION_FIELDS) {
        const entry = value[key];
        if (entry === undefined)
            continue;
        if (!isSurfaceWindowDimension(entry)) {
            return {
                ok: false,
                reason: `surface.window.${key} must be an integer between ${MINIAPP_SURFACE_WINDOW_DIMENSION_MIN} and ${MINIAPP_SURFACE_WINDOW_DIMENSION_MAX}`,
            };
        }
        window[key] = entry;
    }
    for (const [minKey, key] of MINIAPP_SURFACE_WINDOW_MIN_PAIRS) {
        const min = window[minKey];
        const size = window[key];
        if (min !== undefined && size !== undefined && min > size) {
            return {
                ok: false,
                reason: `surface.window.${minKey} must not exceed surface.window.${key}`,
            };
        }
    }
    for (const key of MINIAPP_SURFACE_WINDOW_BOOLEAN_FIELDS) {
        const entry = value[key];
        if (entry === undefined)
            continue;
        if (typeof entry !== 'boolean') {
            return { ok: false, reason: `surface.window.${key} must be a boolean` };
        }
        window[key] = entry;
    }
    // Electron transparent windows require an explicit frameless surface.
    if (window.transparent === true && window.frame !== false) {
        return {
            ok: false,
            reason: 'surface.window.transparent requires surface.window.frame to be false',
        };
    }
    return { ok: true, value: window };
}
export const MINIAPP_WINDOW_ERROR_CODES = [
    'inline_mode',
    'not_permitted',
    'busy',
    'result_unknown',
    'invalid_request',
];
const MINIAPP_WINDOW_PATCH_DIMENSIONS = ['width', 'height'];
const MINIAPP_WINDOW_PATCH_COORDINATES = ['x', 'y'];
/** No manifest equivalent; a wide but bounded runtime range keeps a malformed patch from being unbounded. */
const MINIAPP_WINDOW_COORDINATE_MAX = 100_000;
const MINIAPP_WINDOW_PATCH_BOOLEANS = [
    'visible',
    'resizable',
    'alwaysOnTop',
    'clickThrough',
    'skipTaskbar',
];
/** Declared once in the manifest (`surface.window`); a runtime patch never changes them. */
const MINIAPP_WINDOW_CONSTRUCTION_ONLY_KEYS = new Set([
    'frame',
    'transparent',
    'minWidth',
    'minHeight',
]);
const MINIAPP_WINDOW_PATCH_KEYS = new Set([
    'mode',
    ...MINIAPP_WINDOW_PATCH_DIMENSIONS,
    ...MINIAPP_WINDOW_PATCH_COORDINATES,
    ...MINIAPP_WINDOW_PATCH_BOOLEANS,
]);
function isPlainRecord(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}
function readPatchValue(key, value) {
    if (key === 'mode')
        return value === 'inline' || value === 'window';
    if (MINIAPP_WINDOW_PATCH_DIMENSIONS.includes(key)) {
        return (typeof value === 'number' &&
            Number.isFinite(value) &&
            value > 0 &&
            value <= MINIAPP_SURFACE_WINDOW_DIMENSION_MAX);
    }
    if (MINIAPP_WINDOW_PATCH_COORDINATES.includes(key)) {
        return (typeof value === 'number' &&
            Number.isFinite(value) &&
            Math.abs(value) <= MINIAPP_WINDOW_COORDINATE_MAX);
    }
    return typeof value === 'boolean';
}
/**
 * Shared by the preload and Main so both boundaries enforce one allowlist.
 * Non-object / unknown key / wrong type -> `invalid_request`; a construction-only
 * manifest key (`frame`, `transparent`, `minWidth`, `minHeight`) -> `not_permitted`.
 * `undefined` values are treated as absent.
 */
export function parseMiniAppWindowPatch(value) {
    if (!isPlainRecord(value))
        return { ok: false, code: 'invalid_request' };
    const entries = Object.entries(value).filter(([, entry]) => entry !== undefined);
    if (entries.some(([key]) => !MINIAPP_WINDOW_PATCH_KEYS.has(key) && !MINIAPP_WINDOW_CONSTRUCTION_ONLY_KEYS.has(key))) {
        return { ok: false, code: 'invalid_request' };
    }
    if (entries.some(([key]) => MINIAPP_WINDOW_CONSTRUCTION_ONLY_KEYS.has(key))) {
        return { ok: false, code: 'not_permitted' };
    }
    if (entries.some(([key, entry]) => !readPatchValue(key, entry))) {
        return { ok: false, code: 'invalid_request' };
    }
    return { ok: true, patch: Object.fromEntries(entries) };
}
const MINIAPP_WINDOW_OPTION_NUMBERS = [
    'width',
    'height',
    'minWidth',
    'minHeight',
    'x',
    'y',
];
const MINIAPP_WINDOW_OPTION_BOOLEANS = [
    'visible',
    'resizable',
    'frame',
    'transparent',
    'alwaysOnTop',
    'clickThrough',
    'skipTaskbar',
];
function parseMiniAppWindowOptions(value) {
    if (!isPlainRecord(value))
        return null;
    const options = {};
    for (const key of MINIAPP_WINDOW_OPTION_NUMBERS) {
        const entry = value[key];
        if (typeof entry !== 'number' || !Number.isFinite(entry))
            return null;
        options[key] = entry;
    }
    for (const key of MINIAPP_WINDOW_OPTION_BOOLEANS) {
        const entry = value[key];
        if (typeof entry !== 'boolean')
            return null;
        options[key] = entry;
    }
    // Built only from the two key lists above, so the key order is fixed too
    // (the preload compares states by their JSON).
    return options;
}
/** Rebuilds a state from only the contract fields; anything else is dropped. */
export function parseMiniAppWindowState(value) {
    if (!isPlainRecord(value))
        return null;
    if (value.mode === 'inline')
        return { mode: 'inline' };
    if (value.mode !== 'window')
        return null;
    const window = parseMiniAppWindowOptions(value.window);
    return window ? { mode: 'window', window } : null;
}
/** Page-facing allowlist: `not_found` and unknown codes are not representable here. */
export function parseMiniAppWindowResult(value) {
    if (!isPlainRecord(value))
        return null;
    if (value.success === true) {
        const state = parseMiniAppWindowState(value.state);
        return state ? { success: true, state } : null;
    }
    const code = MINIAPP_WINDOW_ERROR_CODES.find((candidate) => candidate === value.code);
    return value.success === false && code ? { success: false, code } : null;
}
//# sourceMappingURL=miniapp-surface.js.map