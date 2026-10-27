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
/** `request()` asks for at most this many tools at once. */
export const MINIAPP_TOOL_REQUEST_MAX_NAMES = 10;
const MINIAPP_TOOL_PERMISSION_DECISIONS = ['allowOnce', 'allowAlways', 'deny'];
/** Both IPC boundaries keep only the contract fields; anything else is no answer. */
export function readMiniAppToolPermissionDecision(value) {
    if (!value || typeof value !== 'object')
        return null;
    const input = value;
    const decision = MINIAPP_TOOL_PERMISSION_DECISIONS.find((item) => item === input.decision);
    if (!decision)
        return null;
    if (input.names === undefined)
        return { decision };
    if (!Array.isArray(input.names) ||
        input.names.length > MINIAPP_TOOL_REQUEST_MAX_NAMES ||
        !input.names.every((name) => typeof name === 'string')) {
        return null;
    }
    return { decision, names: [...input.names] };
}
/** Bounds one untrusted page Agent request before it crosses into Main. */
export const MINIAPP_AGENT_MAX_TEXT_LENGTH = 100_000;
/**
 * The only PCM the Host transcribes: 16 kHz, mono, signed 16-bit little-endian samples. Named
 * with the Web Audio / WebCodecs words a page already uses, and required verbatim on every call
 * so a page that captured at another rate fails at the call instead of producing garbage text.
 */
export const MINIAPP_SPEECH_AUDIO_FORMAT = Object.freeze({
    sampleRate: 16_000,
    channelCount: 1,
    sampleFormat: 's16',
});
/** 500 s of that PCM; the Host's transcription limit. */
export const MINIAPP_SPEECH_MAX_AUDIO_BYTES = 16_000_000;
/** Page-visible `transcribe()` failures; the page reads them as the rejection's `message`. */
export const MINIAPP_SPEECH_FAILURE_CODES = [
    'invalid_request',
    'not_permitted',
    'audio_too_large',
    'busy',
    'runtime_unavailable',
    'transcription_failed',
    'result_unknown',
];
export function isMiniAppSpeechFailureCode(value) {
    return MINIAPP_SPEECH_FAILURE_CODES.includes(value);
}
export function isMiniAppSpeechAudioFormat(value) {
    if (!isPlainRecord(value))
        return false;
    const keys = Object.keys(value);
    const expected = Object.keys(MINIAPP_SPEECH_AUDIO_FORMAT);
    return (keys.length === expected.length &&
        expected.every((key) => value[key] === MINIAPP_SPEECH_AUDIO_FORMAT[key]));
}
/**
 * Leading bytes of the audio containers a page might send by mistake (`MediaRecorder` output or
 * a WAV it encoded itself). Raw PCM is not inspected beyond this; the format is a contract.
 */
const MINIAPP_SPEECH_CONTAINER_MAGIC = [
    [0x52, 0x49, 0x46, 0x46], // RIFF (WAV)
    [0x1a, 0x45, 0xdf, 0xa3], // EBML (WebM / Matroska)
    [0x4f, 0x67, 0x67, 0x53], // OggS
    [0x66, 0x4c, 0x61, 0x43], // fLaC
    [0x49, 0x44, 0x33], // ID3 (MP3)
];
/** Shared memory cannot cross IPC; refusing it here gives the page `invalid_request` up front. */
function isSharedArrayBuffer(buffer) {
    return typeof SharedArrayBuffer !== 'undefined' && buffer instanceof SharedArrayBuffer;
}
/**
 * Views the page's samples as bytes without copying. Both the preload and Main apply it: an
 * ArrayBuffer or any view over one, at least one whole sample, an even byte count, under the
 * size limit, and not the start of a known container.
 */
export function readMiniAppSpeechAudio(value) {
    let audio;
    if (value instanceof ArrayBuffer)
        audio = new Uint8Array(value);
    else if (ArrayBuffer.isView(value) && !isSharedArrayBuffer(value.buffer)) {
        audio = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    }
    else
        return { ok: false, code: 'invalid_request' };
    if (audio.byteLength > MINIAPP_SPEECH_MAX_AUDIO_BYTES)
        return { ok: false, code: 'audio_too_large' };
    if (audio.byteLength === 0 || audio.byteLength % 2 !== 0) {
        return { ok: false, code: 'invalid_request' };
    }
    const container = MINIAPP_SPEECH_CONTAINER_MAGIC.some((magic) => magic.every((byte, index) => audio[index] === byte));
    return container ? { ok: false, code: 'invalid_request' } : { ok: true, audio };
}
export function parseMiniAppSpeechTranscribeResponse(value) {
    if (!isPlainRecord(value))
        return null;
    if (value.ok === true) {
        const text = isPlainRecord(value.result) ? value.result.text : undefined;
        return typeof text === 'string' ? { ok: true, result: { text } } : null;
    }
    return value.ok === false && isMiniAppSpeechFailureCode(value.code)
        ? { ok: false, code: value.code }
        : null;
}
export function readMiniAppSpeechPartialMessage(value) {
    if (!isPlainRecord(value))
        return null;
    const { requestId, text } = value;
    return typeof requestId === 'string' && requestId && typeof text === 'string'
        ? { requestId, text }
        : null;
}
/**
 * Host features a page or Node module may probe with `capabilities.has`, named by their API path.
 * Fixed per Host version and shared by both surfaces: a name is listed once the Host offers that
 * API on either surface. Says nothing about this Mini App's manifest or authorization.
 */
export const MINIAPP_HOST_CAPABILITIES = Object.freeze([
    'agent.agents',
    'agent.create',
    'agent.models',
    'agent.observe',
    'agent.open',
    'agent.run',
    'agent.session',
    'agent.sessions',
    'hostConnector',
    'message.append',
    'speech.transcribe',
    'tool',
    'tool.request',
    'window',
]);
export function hasMiniAppHostCapability(name) {
    return MINIAPP_HOST_CAPABILITIES.includes(name);
}
/**
 * Manifest `agentAccess` items. `session.run` starts and continues the Mini App's own Agent
 * sessions; `session.read` lists, reads and observes the user's own conversations. Neither
 * implies the other.
 */
export const MINIAPP_AGENT_ACCESS_ITEMS = ['session.run', 'session.read'];
export function isMiniAppAgentAccess(value) {
    return MINIAPP_AGENT_ACCESS_ITEMS.some((item) => item === value);
}
const MINIAPP_CONNECTOR_PROVIDER = /^[a-z0-9_-]{1,64}$/u;
/**
 * `deviceAccess` entries: each is one Chromium device permission the page may hold, named as
 * `navigator.permissions.query` names it. The same list bounds the manifest reader.
 */
export const MINIAPP_DEVICE_ACCESS_ITEMS = Object.freeze(['microphone']);
export function isMiniAppDeviceAccessItem(value) {
    return MINIAPP_DEVICE_ACCESS_ITEMS.includes(value);
}
/** Builds the id of one declared item; the single place the `<domain>:<item>` shape is written. */
export function miniAppPermissionId(domain, item) {
    return `${domain}:${item}`;
}
function isMiniAppPermissionItem(domain, item) {
    switch (domain) {
        case 'connector':
            return MINIAPP_CONNECTOR_PROVIDER.test(item);
        case 'agent':
            return isMiniAppAgentAccess(item);
        case 'tool':
            return item === 'call';
        case 'device':
            return isMiniAppDeviceAccessItem(item);
        default:
            return false;
    }
}
export function parseMiniAppPermissionId(value) {
    if (typeof value !== 'string')
        return null;
    const separator = value.indexOf(':');
    if (separator <= 0)
        return null;
    const domain = value.slice(0, separator);
    const item = value.slice(separator + 1);
    return isMiniAppPermissionItem(domain, item)
        ? { id: value, domain: domain, item }
        : null;
}
const MINIAPP_PERMISSION_MAX_ITEMS = 256;
/** Rebuilds a permission list from contract fields only; any invalid entry rejects the whole list. */
export function parseMiniAppPermissionList(value) {
    if (!isPlainRecord(value))
        return null;
    const { pluginId, source, items } = value;
    if (typeof pluginId !== 'string' || !pluginId || pluginId.length > 256)
        return null;
    if (source !== 'local' && source !== 'official')
        return null;
    if (!Array.isArray(items) || items.length > MINIAPP_PERMISSION_MAX_ITEMS)
        return null;
    const seen = new Set();
    const parsed = [];
    for (const entry of items) {
        if (!isPlainRecord(entry) || typeof entry.enabled !== 'boolean')
            return null;
        const permission = parseMiniAppPermissionId(entry.id);
        if (!permission || seen.has(permission.id))
            return null;
        seen.add(permission.id);
        parsed.push({ id: permission.id, enabled: entry.enabled });
    }
    return { pluginId, source, items: parsed };
}
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
export function isMiniAppAgentWhenBusy(value) {
    return value === 'queue' || value === 'steer';
}
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
    const { text, sessionId, requestId, agent, whenBusy } = input;
    const observe = readMiniAppAgentObserveFlag(input.observe);
    const model = readOptionalModel(input.model);
    if (typeof text !== 'string' || text.length > MINIAPP_AGENT_MAX_TEXT_LENGTH)
        return null;
    if (!isMiniAppAgentRequestId(requestId) || observe === null || model === null)
        return null;
    if (!isOptionalNonEmptyString(sessionId) || !isOptionalNonEmptyString(agent))
        return null;
    if (whenBusy !== undefined && (!isMiniAppAgentWhenBusy(whenBusy) || sessionId === undefined)) {
        return null;
    }
    return {
        requestId,
        text,
        ...(sessionId !== undefined ? { sessionId } : {}),
        ...(model ? { model } : {}),
        ...(agent !== undefined ? { agent } : {}),
        ...(whenBusy !== undefined ? { whenBusy } : {}),
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
/**
 * Page `session` payload: `{ sessionId }`, or `{}` for the session of the chat the tab is in.
 * Checked in the preload and again in Main; null when malformed.
 */
export function readMiniAppAgentSessionRequest(value) {
    if (!value || typeof value !== 'object')
        return null;
    return value.sessionId === undefined
        ? {}
        : readMiniAppAgentOpenRequest(value);
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
/** Bounds one list result crossing a process boundary. */
export const MINIAPP_AGENT_MAX_SESSIONS = 100;
function isMiniAppAgentSessionStatus(value) {
    return value === 'idle' || value === 'running' || value === 'error' || value === 'aborted';
}
/** Allowlist copy of a session summary; null when a field is malformed. */
export function readMiniAppAgentSessionSummary(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return null;
    const record = value;
    const { sessionId, title, agent, status, workspaceDir, isDefaultWorkspace } = record;
    const { createdAtMs, updatedAtMs } = record;
    if (!isNonEmptyString(sessionId) ||
        (title !== undefined && typeof title !== 'string') ||
        !isNonEmptyString(agent) ||
        !isMiniAppAgentSessionStatus(status) ||
        typeof workspaceDir !== 'string' ||
        typeof isDefaultWorkspace !== 'boolean' ||
        !isFiniteNumber(createdAtMs) ||
        !isFiniteNumber(updatedAtMs)) {
        return null;
    }
    return {
        sessionId,
        ...(title !== undefined ? { title } : {}),
        agent,
        status,
        workspaceDir,
        isDefaultWorkspace,
        createdAtMs,
        updatedAtMs,
    };
}
function isFiniteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value);
}
/** Allowlist copy of a bounded summary list; null when the list or any entry is malformed. */
export function readMiniAppAgentSessionList(value) {
    if (!Array.isArray(value) || value.length > MINIAPP_AGENT_MAX_SESSIONS)
        return null;
    const sessions = [];
    for (const entry of value) {
        const summary = readMiniAppAgentSessionSummary(entry);
        if (!summary)
            return null;
        sessions.push(summary);
    }
    return sessions;
}
/** Allowlist copy of a session detail; null when a field is malformed. */
export function readMiniAppAgentSessionDetail(value) {
    const summary = readMiniAppAgentSessionSummary(value);
    if (!summary)
        return null;
    const record = value;
    const { lastAssistantText } = record;
    if (lastAssistantText !== undefined && typeof lastAssistantText !== 'string')
        return null;
    const model = readOptionalModel(record.model);
    const error = readSessionError(record.error);
    if (model === null || error === null)
        return null;
    return {
        ...summary,
        ...(model ? { model } : {}),
        ...(error ? { error } : {}),
        ...(lastAssistantText !== undefined ? { lastAssistantText } : {}),
    };
}
/** `undefined` when absent, `null` when present but malformed. */
function readSessionError(value) {
    if (value === undefined)
        return undefined;
    return isPlainRecord(value) && isNonEmptyString(value.message)
        ? { message: value.message }
        : null;
}
/** Exactly one of `sessionId` / `all: true`; null otherwise. */
export function readMiniAppAgentObserveTarget(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return null;
    const { sessionId, all } = value;
    if (sessionId !== undefined) {
        return isNonEmptyString(sessionId) && all === undefined ? { sessionId } : null;
    }
    return all === true ? { all: true } : null;
}
/**
 * Page `observe` payload with its (page-chosen or preload-generated) `requestId`, checked in
 * the preload and again in Main; null when malformed.
 */
export function readMiniAppAgentObserveRequest(value) {
    const target = readMiniAppAgentObserveTarget(value);
    const { requestId } = (value ?? {});
    return target && isMiniAppAgentRequestId(requestId) ? { ...target, requestId } : null;
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
    if (input.status !== 'finished' &&
        input.status !== 'error' &&
        input.status !== 'aborted' &&
        input.status !== 'steered') {
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
    return readAgentStreamEvent(value, false);
}
/**
 * Allowlist copy of one observer event: no `run.queued` or asks, `turn.started.model` may be
 * absent, and the lifecycle events may carry `title`.
 */
export function readMiniAppAgentObservedEvent(value) {
    return readAgentStreamEvent(value, true);
}
function readAgentStreamEvent(value, observed) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return null;
    const input = value;
    if (input.type === 'run.queued')
        return observed ? null : readRunQueuedEvent(input);
    const { sessionId } = input;
    if (!isNonEmptyString(sessionId))
        return null;
    if (input.type === 'question.requested') {
        return observed ? null : readQuestionRequestedEvent(sessionId, input);
    }
    if (input.type === 'permission.requested') {
        return observed ? null : readPermissionRequestedEvent(sessionId, input);
    }
    const { turnId, title } = input;
    if (!isNonEmptyString(turnId))
        return null;
    if (observed && title !== undefined && typeof title !== 'string')
        return null;
    // Only an observer's lifecycle events carry the session title.
    const titled = observed && typeof title === 'string' ? { title } : {};
    switch (input.type) {
        case 'turn.started': {
            const model = readMiniAppAgentModelSelection(input.model);
            if (model)
                return { type: 'turn.started', sessionId, turnId, model, ...titled };
            // An observer's `turn.started` omits a model the Host could not read.
            return observed && input.model === undefined
                ? { type: 'turn.started', sessionId, turnId, ...titled }
                : null;
        }
        case 'text.delta':
            return typeof input.text === 'string'
                ? { type: 'text.delta', sessionId, turnId, text: input.text }
                : null;
        case 'message.committed':
            return typeof input.text === 'string'
                ? { type: 'message.committed', sessionId, turnId, text: input.text, ...titled }
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
            return outcome ? { type: 'turn.finished', sessionId, turnId, ...outcome, ...titled } : null;
        }
        case 'message.pending':
        case 'message.steered':
            return { type: input.type, sessionId, turnId };
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
/** `ok` once the subscription ended; like a read, a malformed reply is `runtime_unavailable`. */
export function parseMiniAppAgentObserveResult(value) {
    if (!value || typeof value !== 'object')
        return { ok: false, code: 'runtime_unavailable' };
    const response = value;
    return response.ok === true ? { ok: true } : readReadFailure(response);
}
/** A read changes nothing: a malformed result is retryable `runtime_unavailable`, never unknown. */
function readReadFailure(response) {
    return response.ok === false && isMiniAppAgentFailureCode(response.code)
        ? { ok: false, code: response.code }
        : { ok: false, code: 'runtime_unavailable' };
}
/** Any malformed entry rejects the whole list. */
export function parseMiniAppAgentSessionsResult(value) {
    if (!value || typeof value !== 'object')
        return { ok: false, code: 'runtime_unavailable' };
    const response = value;
    if (response.ok !== true)
        return readReadFailure(response);
    const sessions = readMiniAppAgentSessionList(response.sessions);
    return sessions ? { ok: true, sessions } : { ok: false, code: 'runtime_unavailable' };
}
/** An absent `session` is a page's `session()` outside a chat tab. */
export function parseMiniAppAgentSessionResult(value) {
    if (!value || typeof value !== 'object')
        return { ok: false, code: 'runtime_unavailable' };
    const response = value;
    if (response.ok !== true)
        return readReadFailure(response);
    if (response.session === undefined)
        return { ok: true };
    const session = readMiniAppAgentSessionDetail(response.session);
    return session ? { ok: true, session } : { ok: false, code: 'runtime_unavailable' };
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