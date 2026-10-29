"use strict";

// main/modules/browser/preload.ts
var import_electron = require("electron");
var EMBEDDED_BROWSER_COMMENT_BRIDGE_EVENT = "embedded-browser:comment-bridge-event";
var EMBEDDED_BROWSER_AGENT_CURSOR_EVENT = "embedded-browser:agent-cursor-event";
var EMBEDDED_COMMENT_WORLD_ID = 1004;
var EMBEDDED_AGENT_CURSOR_WORLD_ID = 1005;
var EMBEDDED_COMMENT_BRIDGE_API_KEY = "mavisEmbeddedBrowserBridge";
var EMBEDDED_AGENT_CURSOR_BRIDGE_API_KEY = "mavisEmbeddedBrowserCursorBridge";
var MAX_PENDING_COMMENT_MESSAGES = 256;
var pendingMessages = [];
var drainPromise = null;
var retryTimer = null;
function scheduleRetry() {
  if (retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void drainPendingMessages();
  }, 250);
}
function drainPendingMessages() {
  if (drainPromise) return drainPromise;
  drainPromise = (async () => {
    while (pendingMessages.length > 0) {
      const pending = pendingMessages[0];
      try {
        const result = await import_electron.ipcRenderer.invoke(
          EMBEDDED_BROWSER_COMMENT_BRIDGE_EVENT,
          pending.envelope
        );
        if (result && typeof result === "object" && result.success === false && result.retryable === true) {
          scheduleRetry();
          return;
        }
        pendingMessages.shift();
        pending.resolve(result);
      } catch {
        scheduleRetry();
        return;
      }
    }
  })().finally(() => {
    drainPromise = null;
  });
  return drainPromise;
}
import_electron.contextBridge.exposeInIsolatedWorld(EMBEDDED_COMMENT_WORLD_ID, EMBEDDED_COMMENT_BRIDGE_API_KEY, {
  emitCommentEvent(envelope) {
    if (pendingMessages.length >= MAX_PENDING_COMMENT_MESSAGES) {
      return Promise.resolve({ success: false, error: "Browser comment transport queue is full" });
    }
    return new Promise((resolve) => {
      pendingMessages.push({ envelope, resolve });
      void drainPendingMessages();
    });
  }
});
import_electron.contextBridge.exposeInIsolatedWorld(
  EMBEDDED_AGENT_CURSOR_WORLD_ID,
  EMBEDDED_AGENT_CURSOR_BRIDGE_API_KEY,
  {
    emitCursorEvent(envelope) {
      return import_electron.ipcRenderer.invoke(EMBEDDED_BROWSER_AGENT_CURSOR_EVENT, envelope);
    }
  }
);

// main/modules/browser/miniapp-preload.ts
var import_electron2 = require("electron");

// ../../packages/shared/dist/miniapp-surface.js
var MINIAPP_COMPOSER_MAX_TEXT_LENGTH = 1e5;
var MINIAPP_COMPOSER_FAILURE_CODES = [
  "user_cancelled",
  "invalid_request",
  "text_too_large",
  "not_allowed",
  "target_unavailable",
  "result_unknown"
];
function parseMiniAppComposerAppendResult(value) {
  if (!value || typeof value !== "object")
    return null;
  const result = value;
  if (result.success === true)
    return { success: true };
  const code = MINIAPP_COMPOSER_FAILURE_CODES.find((candidate) => candidate === result.code);
  return result.success === false && code ? { success: false, code } : null;
}
var MINIAPP_TOOL_REQUEST_MAX_NAMES = 10;
var MINIAPP_AGENT_MAX_TEXT_LENGTH = 1e5;
var MINIAPP_SPEECH_AUDIO_FORMAT = Object.freeze({
  sampleRate: 16e3,
  channelCount: 1,
  sampleFormat: "s16"
});
var MINIAPP_SPEECH_MAX_AUDIO_BYTES = 16e6;
var MINIAPP_SPEECH_FAILURE_CODES = [
  "invalid_request",
  "not_permitted",
  "audio_too_large",
  "busy",
  "runtime_unavailable",
  "transcription_failed",
  "result_unknown"
];
function isMiniAppSpeechFailureCode(value) {
  return MINIAPP_SPEECH_FAILURE_CODES.includes(value);
}
function isMiniAppSpeechAudioFormat(value) {
  if (!isPlainRecord(value))
    return false;
  const keys = Object.keys(value);
  const expected = Object.keys(MINIAPP_SPEECH_AUDIO_FORMAT);
  return keys.length === expected.length && expected.every((key) => value[key] === MINIAPP_SPEECH_AUDIO_FORMAT[key]);
}
var MINIAPP_SPEECH_CONTAINER_MAGIC = [
  [82, 73, 70, 70],
  // RIFF (WAV)
  [26, 69, 223, 163],
  // EBML (WebM / Matroska)
  [79, 103, 103, 83],
  // OggS
  [102, 76, 97, 67],
  // fLaC
  [73, 68, 51]
  // ID3 (MP3)
];
function isSharedArrayBuffer(buffer) {
  return typeof SharedArrayBuffer !== "undefined" && buffer instanceof SharedArrayBuffer;
}
function readMiniAppSpeechAudio(value) {
  let audio;
  if (value instanceof ArrayBuffer)
    audio = new Uint8Array(value);
  else if (ArrayBuffer.isView(value) && !isSharedArrayBuffer(value.buffer)) {
    audio = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  } else
    return { ok: false, code: "invalid_request" };
  if (audio.byteLength > MINIAPP_SPEECH_MAX_AUDIO_BYTES)
    return { ok: false, code: "audio_too_large" };
  if (audio.byteLength === 0 || audio.byteLength % 2 !== 0) {
    return { ok: false, code: "invalid_request" };
  }
  const container = MINIAPP_SPEECH_CONTAINER_MAGIC.some((magic) => magic.every((byte, index) => audio[index] === byte));
  return container ? { ok: false, code: "invalid_request" } : { ok: true, audio };
}
function parseMiniAppSpeechTranscribeResponse(value) {
  if (!isPlainRecord(value))
    return null;
  if (value.ok === true) {
    const text = isPlainRecord(value.result) ? value.result.text : void 0;
    return typeof text === "string" ? { ok: true, result: { text } } : null;
  }
  return value.ok === false && isMiniAppSpeechFailureCode(value.code) ? { ok: false, code: value.code } : null;
}
function readMiniAppSpeechPartialMessage(value) {
  if (!isPlainRecord(value))
    return null;
  const { requestId, text } = value;
  return typeof requestId === "string" && requestId && typeof text === "string" ? { requestId, text } : null;
}
var MINIAPP_HOST_CAPABILITIES = Object.freeze([
  "agent.agents",
  "agent.create",
  "agent.models",
  "agent.observe",
  "agent.open",
  "agent.run",
  "agent.session",
  "agent.sessions",
  "hostConnector",
  "message.append",
  "speech.transcribe",
  "tool",
  "tool.request",
  "window"
]);
function hasMiniAppHostCapability(name) {
  return MINIAPP_HOST_CAPABILITIES.includes(name);
}
var MINIAPP_DEVICE_ACCESS_ITEMS = Object.freeze(["microphone"]);
var MINIAPP_AGENT_FAILURE_CODES = [
  "invalid_request",
  "not_permitted",
  "busy",
  "session_not_found",
  "runtime_unavailable",
  "cancelled",
  "result_unknown",
  "request_not_found"
];
function isMiniAppAgentBusyReason(value) {
  return value === "session_busy" || value === "queue_full";
}
var MINIAPP_AGENT_MAX_REQUEST_ID_LENGTH = 128;
function isMiniAppAgentWhenBusy(value) {
  return value === "queue" || value === "steer";
}
function isMiniAppAgentRequestId(value) {
  return typeof value === "string" && value.length > 0 && value.length <= MINIAPP_AGENT_MAX_REQUEST_ID_LENGTH && !/[\u0000-\u001f\u007f]/u.test(value);
}
var MINIAPP_AGENT_MAX_ANSWERS = 64;
var MINIAPP_AGENT_MAX_ANSWER_TEXT_LENGTH = 4096;
function isMiniAppAgentPermissionDecision(value) {
  return value === "allowOnce" || value === "deny";
}
function isBoundedAnswerText(value) {
  return typeof value === "string" && value.length <= MINIAPP_AGENT_MAX_ANSWER_TEXT_LENGTH;
}
var ANSWER_KEYS = /* @__PURE__ */ new Set([
  "stepId",
  "selectedOptionIds",
  "selectedOther",
  "otherText",
  "skipped"
]);
function readMiniAppAgentAnswer(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return null;
  const input = value;
  if (!Object.keys(input).every((key) => ANSWER_KEYS.has(key)))
    return null;
  const { stepId, selectedOptionIds, selectedOther, otherText, skipped } = input;
  if (!isNonEmptyString(stepId) || !isBoundedAnswerText(stepId))
    return null;
  if (!Array.isArray(selectedOptionIds) || selectedOptionIds.length > MINIAPP_AGENT_MAX_ANSWERS || !selectedOptionIds.every(isBoundedAnswerText)) {
    return null;
  }
  if (typeof selectedOther !== "boolean")
    return null;
  if (otherText !== void 0 && !isBoundedAnswerText(otherText))
    return null;
  if (skipped !== void 0 && typeof skipped !== "boolean")
    return null;
  return {
    stepId,
    selectedOptionIds: [...selectedOptionIds],
    selectedOther,
    ...otherText !== void 0 ? { otherText } : {},
    ...skipped !== void 0 ? { skipped } : {}
  };
}
function readMiniAppAgentAnswers(value) {
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
function readMiniAppAgentReplyRequest(value) {
  if (!value || typeof value !== "object")
    return null;
  const { sessionId, requestId, decision } = value;
  return isNonEmptyString(sessionId) && isNonEmptyString(requestId) && isMiniAppAgentPermissionDecision(decision) ? { sessionId, requestId, decision } : null;
}
function readMiniAppAgentObserveFlag(value) {
  if (value === void 0)
    return false;
  return typeof value === "boolean" ? value : null;
}
function readMiniAppAgentAnswerRequest(value) {
  if (!value || typeof value !== "object")
    return null;
  const input = value;
  const answers = readMiniAppAgentAnswers(input.answers);
  const observe = readMiniAppAgentObserveFlag(input.observe);
  const model = readOptionalModel(input.model);
  const { sessionId, questionId, requestId } = input;
  return isNonEmptyString(sessionId) && isNonEmptyString(questionId) && answers !== null && observe !== null && model !== null && isMiniAppAgentRequestId(requestId) ? { sessionId, questionId, answers, requestId, observe, ...model ? { model } : {} } : null;
}
function readMiniAppAgentRunRequest(value) {
  if (!value || typeof value !== "object")
    return null;
  const input = value;
  const { text, sessionId, requestId, agent, whenBusy } = input;
  const observe = readMiniAppAgentObserveFlag(input.observe);
  const model = readOptionalModel(input.model);
  if (typeof text !== "string" || text.length > MINIAPP_AGENT_MAX_TEXT_LENGTH)
    return null;
  if (!isMiniAppAgentRequestId(requestId) || observe === null || model === null)
    return null;
  if (!isOptionalNonEmptyString(sessionId) || !isOptionalNonEmptyString(agent))
    return null;
  if (whenBusy !== void 0 && (!isMiniAppAgentWhenBusy(whenBusy) || sessionId === void 0)) {
    return null;
  }
  return {
    requestId,
    text,
    ...sessionId !== void 0 ? { sessionId } : {},
    ...model ? { model } : {},
    ...agent !== void 0 ? { agent } : {},
    ...whenBusy !== void 0 ? { whenBusy } : {},
    observe
  };
}
function readOptionalModel(value) {
  return value === void 0 ? void 0 : readMiniAppAgentModelSelection(value);
}
function readMiniAppAgentModelSelection(value) {
  if (!isPlainRecord(value))
    return null;
  const { providerId, modelId, variant } = value;
  if (!isNonEmptyString(providerId) || !isNonEmptyString(modelId))
    return null;
  if (variant !== void 0 && typeof variant !== "string")
    return null;
  const thinking = readSelectionThinking(value.thinking);
  if (thinking === null)
    return null;
  return {
    providerId,
    modelId,
    ...variant === void 0 ? {} : { variant },
    ...thinking ? { thinking } : {}
  };
}
function readSelectionThinking(value) {
  if (value === void 0)
    return void 0;
  return isPlainRecord(value) && typeof value.effort === "string" ? { effort: value.effort } : null;
}
function readStringList(value) {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? [...value] : null;
}
function readOptionThinking(value) {
  if (value === void 0)
    return void 0;
  if (!isPlainRecord(value))
    return null;
  const efforts = readStringList(value.efforts);
  const defaultEffort = value.default;
  if (!efforts || defaultEffort !== void 0 && typeof defaultEffort !== "string")
    return null;
  return { efforts, ...defaultEffort !== void 0 ? { default: defaultEffort } : {} };
}
function readModelOption(value) {
  if (!isPlainRecord(value))
    return null;
  const { providerId, modelId, displayName } = value;
  if (!isNonEmptyString(providerId) || !isNonEmptyString(modelId))
    return null;
  if (typeof displayName !== "string")
    return null;
  const variants = value.variants === void 0 ? void 0 : readStringList(value.variants);
  const thinking = readOptionThinking(value.thinking);
  if (variants === null || thinking === null)
    return null;
  return {
    providerId,
    modelId,
    displayName,
    ...variants ? { variants } : {},
    ...thinking ? { thinking } : {}
  };
}
function readMiniAppAgentModels(value) {
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
  return { models, default: fallback, ...host ? { host } : {} };
}
function readAgentOption(value) {
  if (!isPlainRecord(value))
    return null;
  const { name, displayName, primary } = value;
  return isNonEmptyString(name) && typeof displayName === "string" && typeof primary === "boolean" ? { name, displayName, primary } : null;
}
function readMiniAppAgentAgents(value) {
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
function readMiniAppAgentCreateRequest(value) {
  if (!isPlainRecord(value) || !isOptionalNonEmptyString(value.agent))
    return null;
  return value.agent !== void 0 ? { agent: value.agent } : {};
}
function readMiniAppAgentCreateResponse(value) {
  return isPlainRecord(value) && isNonEmptyString(value.sessionId) ? { sessionId: value.sessionId } : null;
}
function readMiniAppAgentOpenRequest(value) {
  if (!value || typeof value !== "object")
    return null;
  const { sessionId } = value;
  return isNonEmptyString(sessionId) ? { sessionId } : null;
}
function readMiniAppAgentSessionRequest(value) {
  if (!value || typeof value !== "object")
    return null;
  return value.sessionId === void 0 ? {} : readMiniAppAgentOpenRequest(value);
}
var MINIAPP_AGENT_MAX_SESSIONS = 100;
function isMiniAppAgentSessionStatus(value) {
  return value === "idle" || value === "running" || value === "error" || value === "aborted";
}
function readMiniAppAgentSessionSummary(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return null;
  const record = value;
  const { sessionId, title, agent, status, workspaceDir, isDefaultWorkspace } = record;
  const { createdAtMs, updatedAtMs } = record;
  if (!isNonEmptyString(sessionId) || title !== void 0 && typeof title !== "string" || !isNonEmptyString(agent) || !isMiniAppAgentSessionStatus(status) || typeof workspaceDir !== "string" || typeof isDefaultWorkspace !== "boolean" || !isFiniteNumber(createdAtMs) || !isFiniteNumber(updatedAtMs)) {
    return null;
  }
  return {
    sessionId,
    ...title !== void 0 ? { title } : {},
    agent,
    status,
    workspaceDir,
    isDefaultWorkspace,
    createdAtMs,
    updatedAtMs
  };
}
function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}
function readMiniAppAgentSessionList(value) {
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
function readMiniAppAgentSessionDetail(value) {
  const summary = readMiniAppAgentSessionSummary(value);
  if (!summary)
    return null;
  const record = value;
  const { lastAssistantText } = record;
  if (lastAssistantText !== void 0 && typeof lastAssistantText !== "string")
    return null;
  const model = readOptionalModel(record.model);
  const error = readSessionError(record.error);
  if (model === null || error === null)
    return null;
  return {
    ...summary,
    ...model ? { model } : {},
    ...error ? { error } : {},
    ...lastAssistantText !== void 0 ? { lastAssistantText } : {}
  };
}
function readSessionError(value) {
  if (value === void 0)
    return void 0;
  return isPlainRecord(value) && isNonEmptyString(value.message) ? { message: value.message } : null;
}
function readMiniAppAgentObserveTarget(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return null;
  const { sessionId, all } = value;
  if (sessionId !== void 0) {
    return isNonEmptyString(sessionId) && all === void 0 ? { sessionId } : null;
  }
  return all === true ? { all: true } : null;
}
function readMiniAppAgentObserveRequest(value) {
  const target = readMiniAppAgentObserveTarget(value);
  const { requestId } = value ?? {};
  return target && isMiniAppAgentRequestId(requestId) ? { ...target, requestId } : null;
}
function isMiniAppAgentFailureCode(value) {
  return MINIAPP_AGENT_FAILURE_CODES.some((code) => code === value);
}
function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}
function isOptionalNonEmptyString(value) {
  return value === void 0 || isNonEmptyString(value);
}
function readMiniAppAgentRunResult(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return null;
  const input = value;
  const { sessionId, turnId } = input;
  if (!isNonEmptyString(sessionId) || !isOptionalNonEmptyString(turnId))
    return null;
  const outcome = readRunOutcome(input);
  if (!outcome)
    return null;
  const model = readOptionalModel(input.model);
  const pending = input.pendingQuestion;
  const pendingQuestion = pending && typeof pending === "object" ? readPendingQuestion(pending) : null;
  if (pending !== void 0 && !pendingQuestion)
    return null;
  return {
    sessionId,
    ...turnId !== void 0 ? { turnId } : {},
    ...model ? { model } : {},
    ...outcome,
    ...pendingQuestion ? { pendingQuestion } : {}
  };
}
function readPendingQuestion(input) {
  const { requestId, mode, request } = input;
  return isNonEmptyString(requestId) && isMiniAppAgentQuestionMode(mode) && isQuestionnaireRequest(request) ? { requestId, mode, request } : null;
}
function isMiniAppAgentQuestionMode(value) {
  return value === "questionnaire" || value === "feature-enable" || value === "plan";
}
function isQuestionnaireRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return false;
  const request = value;
  return request.schemaVersion === 2 && isNonEmptyString(request.id) && Array.isArray(request.steps);
}
function readRunOutcome(input) {
  if (input.status !== "finished" && input.status !== "error" && input.status !== "aborted" && input.status !== "steered") {
    return null;
  }
  if (input.text !== void 0 && typeof input.text !== "string")
    return null;
  let error;
  if (input.error !== void 0) {
    if (!input.error || typeof input.error !== "object")
      return null;
    const { code, message } = input.error;
    if (typeof code !== "string" || typeof message !== "string")
      return null;
    error = { code, message };
  }
  return {
    status: input.status,
    ...input.text !== void 0 ? { text: input.text } : {},
    ...error ? { error } : {}
  };
}
function readMiniAppAgentRunEvent(value) {
  return readAgentStreamEvent(value, false);
}
function readMiniAppAgentObservedEvent(value) {
  return readAgentStreamEvent(value, true);
}
function readAgentStreamEvent(value, observed) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return null;
  const input = value;
  if (input.type === "run.queued")
    return observed ? null : readRunQueuedEvent(input);
  const { sessionId } = input;
  if (!isNonEmptyString(sessionId))
    return null;
  if (input.type === "question.requested") {
    return observed ? null : readQuestionRequestedEvent(sessionId, input);
  }
  if (input.type === "permission.requested") {
    return observed ? null : readPermissionRequestedEvent(sessionId, input);
  }
  const { turnId, title } = input;
  if (!isNonEmptyString(turnId))
    return null;
  if (observed && title !== void 0 && typeof title !== "string")
    return null;
  const titled = observed && typeof title === "string" ? { title } : {};
  switch (input.type) {
    case "turn.started": {
      const model = readMiniAppAgentModelSelection(input.model);
      if (model)
        return { type: "turn.started", sessionId, turnId, model, ...titled };
      return observed && input.model === void 0 ? { type: "turn.started", sessionId, turnId, ...titled } : null;
    }
    case "text.delta":
      return typeof input.text === "string" ? { type: "text.delta", sessionId, turnId, text: input.text } : null;
    case "message.committed":
      return typeof input.text === "string" ? { type: "message.committed", sessionId, turnId, text: input.text, ...titled } : null;
    case "tool.started":
      return typeof input.name === "string" ? { type: "tool.started", sessionId, turnId, name: input.name } : null;
    case "tool.finished":
      return typeof input.name === "string" && typeof input.ok === "boolean" ? { type: "tool.finished", sessionId, turnId, name: input.name, ok: input.ok } : null;
    case "turn.finished": {
      const outcome = readRunOutcome(input);
      return outcome ? { type: "turn.finished", sessionId, turnId, ...outcome, ...titled } : null;
    }
    case "message.pending":
    case "message.steered":
      return { type: input.type, sessionId, turnId };
    default:
      return null;
  }
}
function readRunQueuedEvent(input) {
  const { sessionId, position } = input;
  if (!isOptionalNonEmptyString(sessionId))
    return null;
  if (typeof position !== "number" || !Number.isSafeInteger(position) || position < 1)
    return null;
  return { type: "run.queued", ...sessionId !== void 0 ? { sessionId } : {}, position };
}
function readPermissionRequestedEvent(sessionId, input) {
  const { turnId, requestId, toolName, toolInput, reason } = input;
  if (!isOptionalNonEmptyString(turnId) || !isNonEmptyString(requestId) || typeof toolName !== "string" || typeof reason !== "string" || toolInput !== void 0 && typeof toolInput !== "string") {
    return null;
  }
  return {
    type: "permission.requested",
    sessionId,
    ...turnId !== void 0 ? { turnId } : {},
    requestId,
    toolName,
    ...toolInput !== void 0 ? { toolInput } : {},
    reason
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
    type: "question.requested",
    sessionId,
    ...turnId !== void 0 ? { turnId } : {},
    ...question
  };
}
function parseMiniAppAgentRunResult(value) {
  if (value && typeof value === "object") {
    const response = value;
    if (response.ok === true) {
      const result = readMiniAppAgentRunResult(response.result);
      if (result)
        return { ok: true, result };
    } else if (response.ok === false) {
      return readMiniAppAgentFailure(response);
    }
  }
  return { ok: false, code: "result_unknown" };
}
function parseMiniAppAgentReplyResult(value) {
  if (value && typeof value === "object") {
    const response = value;
    if (response.ok === true)
      return { ok: true };
    if (response.ok === false)
      return readMiniAppAgentFailure(response);
  }
  return { ok: false, code: "result_unknown" };
}
function readMiniAppAgentFailure(response) {
  const { code, reason } = response;
  if (!isMiniAppAgentFailureCode(code))
    return { ok: false, code: "result_unknown" };
  return code === "busy" && isMiniAppAgentBusyReason(reason) ? { ok: false, code, reason } : { ok: false, code };
}
function parseMiniAppAgentResultEnvelope(value, read) {
  if (value && typeof value === "object") {
    const response = value;
    if (response.ok === true) {
      const result = read(response.result);
      if (result)
        return { ok: true, result };
    } else if (response.ok === false) {
      return readMiniAppAgentFailure(response);
    }
  }
  return { ok: false, code: "result_unknown" };
}
function parseMiniAppAgentModelsResult(value) {
  return parseMiniAppAgentResultEnvelope(value, readMiniAppAgentModels);
}
function parseMiniAppAgentAgentsResult(value) {
  return parseMiniAppAgentResultEnvelope(value, readMiniAppAgentAgents);
}
function parseMiniAppAgentCreateResult(value) {
  return parseMiniAppAgentResultEnvelope(value, readMiniAppAgentCreateResponse);
}
function parseMiniAppAgentOpenResult(value) {
  return parseMiniAppAgentReplyResult(value);
}
function parseMiniAppAgentObserveResult(value) {
  if (!value || typeof value !== "object")
    return { ok: false, code: "runtime_unavailable" };
  const response = value;
  return response.ok === true ? { ok: true } : readReadFailure(response);
}
function readReadFailure(response) {
  return response.ok === false && isMiniAppAgentFailureCode(response.code) ? { ok: false, code: response.code } : { ok: false, code: "runtime_unavailable" };
}
function parseMiniAppAgentSessionsResult(value) {
  if (!value || typeof value !== "object")
    return { ok: false, code: "runtime_unavailable" };
  const response = value;
  if (response.ok !== true)
    return readReadFailure(response);
  const sessions = readMiniAppAgentSessionList(response.sessions);
  return sessions ? { ok: true, sessions } : { ok: false, code: "runtime_unavailable" };
}
function parseMiniAppAgentSessionResult(value) {
  if (!value || typeof value !== "object")
    return { ok: false, code: "runtime_unavailable" };
  const response = value;
  if (response.ok !== true)
    return readReadFailure(response);
  if (response.session === void 0)
    return { ok: true };
  const session = readMiniAppAgentSessionDetail(response.session);
  return session ? { ok: true, session } : { ok: false, code: "runtime_unavailable" };
}
var MINIAPP_SURFACE_ID_ARGUMENT_PREFIX = "--mavis-miniapp-surface-id=";
var MINIAPP_SURFACE_WINDOW_DIMENSION_FIELDS = [
  "width",
  "height",
  "minWidth",
  "minHeight"
];
var MINIAPP_SURFACE_WINDOW_BOOLEAN_FIELDS = [
  "resizable",
  "frame",
  "transparent",
  "alwaysOnTop",
  "skipTaskbar",
  "clickThrough"
];
var MINIAPP_SURFACE_WINDOW_FIELDS = [
  ...MINIAPP_SURFACE_WINDOW_DIMENSION_FIELDS,
  ...MINIAPP_SURFACE_WINDOW_BOOLEAN_FIELDS
];
var MINIAPP_SURFACE_WINDOW_DIMENSION_MAX = 1e4;
var MINIAPP_SURFACE_WINDOW_FIELD_SET = new Set(MINIAPP_SURFACE_WINDOW_FIELDS);
var MINIAPP_WINDOW_ERROR_CODES = [
  "inline_mode",
  "not_permitted",
  "busy",
  "result_unknown",
  "invalid_request"
];
var MINIAPP_WINDOW_PATCH_DIMENSIONS = ["width", "height"];
var MINIAPP_WINDOW_PATCH_COORDINATES = ["x", "y"];
var MINIAPP_WINDOW_COORDINATE_MAX = 1e5;
var MINIAPP_WINDOW_PATCH_BOOLEANS = [
  "visible",
  "resizable",
  "alwaysOnTop",
  "clickThrough",
  "skipTaskbar"
];
var MINIAPP_WINDOW_CONSTRUCTION_ONLY_KEYS = /* @__PURE__ */ new Set([
  "frame",
  "transparent",
  "minWidth",
  "minHeight"
]);
var MINIAPP_WINDOW_PATCH_KEYS = /* @__PURE__ */ new Set([
  "mode",
  ...MINIAPP_WINDOW_PATCH_DIMENSIONS,
  ...MINIAPP_WINDOW_PATCH_COORDINATES,
  ...MINIAPP_WINDOW_PATCH_BOOLEANS
]);
function isPlainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function readPatchValue(key, value) {
  if (key === "mode")
    return value === "inline" || value === "window";
  if (MINIAPP_WINDOW_PATCH_DIMENSIONS.includes(key)) {
    return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= MINIAPP_SURFACE_WINDOW_DIMENSION_MAX;
  }
  if (MINIAPP_WINDOW_PATCH_COORDINATES.includes(key)) {
    return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= MINIAPP_WINDOW_COORDINATE_MAX;
  }
  return typeof value === "boolean";
}
function parseMiniAppWindowPatch(value) {
  if (!isPlainRecord(value))
    return { ok: false, code: "invalid_request" };
  const entries = Object.entries(value).filter(([, entry]) => entry !== void 0);
  if (entries.some(([key]) => !MINIAPP_WINDOW_PATCH_KEYS.has(key) && !MINIAPP_WINDOW_CONSTRUCTION_ONLY_KEYS.has(key))) {
    return { ok: false, code: "invalid_request" };
  }
  if (entries.some(([key]) => MINIAPP_WINDOW_CONSTRUCTION_ONLY_KEYS.has(key))) {
    return { ok: false, code: "not_permitted" };
  }
  if (entries.some(([key, entry]) => !readPatchValue(key, entry))) {
    return { ok: false, code: "invalid_request" };
  }
  return { ok: true, patch: Object.fromEntries(entries) };
}
var MINIAPP_WINDOW_OPTION_NUMBERS = [
  "width",
  "height",
  "minWidth",
  "minHeight",
  "x",
  "y"
];
var MINIAPP_WINDOW_OPTION_BOOLEANS = [
  "visible",
  "resizable",
  "frame",
  "transparent",
  "alwaysOnTop",
  "clickThrough",
  "skipTaskbar"
];
function parseMiniAppWindowOptions(value) {
  if (!isPlainRecord(value))
    return null;
  const options = {};
  for (const key of MINIAPP_WINDOW_OPTION_NUMBERS) {
    const entry = value[key];
    if (typeof entry !== "number" || !Number.isFinite(entry))
      return null;
    options[key] = entry;
  }
  for (const key of MINIAPP_WINDOW_OPTION_BOOLEANS) {
    const entry = value[key];
    if (typeof entry !== "boolean")
      return null;
    options[key] = entry;
  }
  return options;
}
function parseMiniAppWindowState(value) {
  if (!isPlainRecord(value))
    return null;
  if (value.mode === "inline")
    return { mode: "inline" };
  if (value.mode !== "window")
    return null;
  const window = parseMiniAppWindowOptions(value.window);
  return window ? { mode: "window", window } : null;
}
function parseMiniAppWindowResult(value) {
  if (!isPlainRecord(value))
    return null;
  if (value.success === true) {
    const state = parseMiniAppWindowState(value.state);
    return state ? { success: true, state } : null;
  }
  const code = MINIAPP_WINDOW_ERROR_CODES.find((candidate) => candidate === value.code);
  return value.success === false && code ? { success: false, code } : null;
}

// main/modules/browser/miniapp-preload.ts
var MINIAPP_COMPOSER_APPEND = "miniapp:composer-append";
var MINIAPP_AGENT_RUN = "miniapp:agent-run";
var MINIAPP_AGENT_CANCEL = "miniapp:agent-cancel";
var MINIAPP_AGENT_EVENT = "miniapp:agent-event";
var MINIAPP_AGENT_REPLY = "miniapp:agent-reply";
var MINIAPP_AGENT_ANSWER = "miniapp:agent-answer";
var MINIAPP_AGENT_OPEN = "miniapp:agent-open";
var MINIAPP_AGENT_MODELS = "miniapp:agent-models";
var MINIAPP_AGENT_AGENTS = "miniapp:agent-agents";
var MINIAPP_AGENT_CREATE = "miniapp:agent-create";
var MINIAPP_AGENT_OBSERVE = "miniapp:agent-observe";
var MINIAPP_AGENT_SESSIONS = "miniapp:agent-sessions";
var MINIAPP_AGENT_SESSION = "miniapp:agent-session";
var MINIAPP_TOOL_REQUEST = "miniapp:tool-request";
var TOOL_PERMISSIONS = /* @__PURE__ */ new Set(["allow", "ask", "deny"]);
var MINIAPP_SPEECH_TRANSCRIBE = "miniapp:speech-transcribe";
var MINIAPP_SPEECH_PARTIAL = "miniapp:speech-partial";
var speechRequestSequence = 0;
async function transcribeSpeech(input, options) {
  if (!input || typeof input !== "object") throw new Error("invalid_request");
  const { audio, format } = input;
  if (!isMiniAppSpeechAudioFormat(format)) throw new Error("invalid_request");
  const read = readMiniAppSpeechAudio(audio);
  if (!read.ok) throw new Error(read.code);
  const samples = read.audio.byteLength === read.audio.buffer.byteLength ? read.audio : read.audio.slice();
  const requestId = `speech-${++speechRequestSequence}`;
  const onPartial = typeof options?.onPartial === "function" ? options.onPartial : void 0;
  const listener = (_event, message) => {
    const partial = readMiniAppSpeechPartialMessage(message);
    if (!onPartial || partial?.requestId !== requestId) return;
    try {
      onPartial(partial.text);
    } catch (error) {
      console.error("[miniapp] speech onPartial handler threw", error);
    }
  };
  if (onPartial) import_electron2.ipcRenderer.on(MINIAPP_SPEECH_PARTIAL, listener);
  let response;
  try {
    response = await import_electron2.ipcRenderer.invoke(MINIAPP_SPEECH_TRANSCRIBE, {
      requestId,
      audio: samples,
      format: MINIAPP_SPEECH_AUDIO_FORMAT
    });
  } catch {
    throw new Error("result_unknown");
  } finally {
    if (onPartial) import_electron2.ipcRenderer.removeListener(MINIAPP_SPEECH_PARTIAL, listener);
  }
  const result = parseMiniAppSpeechTranscribeResponse(response);
  if (!result) throw new Error("result_unknown");
  if (!result.ok) throw new Error(result.code);
  return result.result;
}
var agentRequestPrefix = Math.random().toString(36).slice(2, 10);
var agentRequestSequence = 0;
var inFlightAgentRequests = /* @__PURE__ */ new Set();
var SETTLEMENT_GUARD_MS = 1e4;
async function followAgentStream(input) {
  const { requestId, onEvent, read } = input;
  let isSettled = false;
  let settle = () => void 0;
  const settled = new Promise((resolve) => {
    settle = (response) => {
      isSettled = true;
      resolve(response);
    };
  });
  const listener = (_event, message) => {
    if (!message || typeof message !== "object") return;
    const envelope = message;
    if (envelope.requestId !== requestId) return;
    if ("settled" in envelope) {
      settle(envelope.settled);
      return;
    }
    const event = read(envelope.event);
    if (!event) return;
    try {
      onEvent(event);
    } catch (error) {
      console.error("[miniapp] agent onEvent handler threw", error);
    }
  };
  import_electron2.ipcRenderer.on(MINIAPP_AGENT_EVENT, listener);
  let guard;
  try {
    let reply;
    try {
      reply = await input.invoke();
    } catch {
      if (isSettled) return await settled;
      throw new Error(input.lost);
    }
    return await Promise.race([
      settled,
      new Promise((resolve) => {
        guard = setTimeout(() => {
          console.error(
            "[miniapp] agent request answered without a settlement on its event channel",
            requestId
          );
          resolve(reply);
        }, SETTLEMENT_GUARD_MS);
      })
    ]);
  } finally {
    if (guard !== void 0) clearTimeout(guard);
    import_electron2.ipcRenderer.removeListener(MINIAPP_AGENT_EVENT, listener);
  }
}
async function observeAgent(input, options) {
  const fields = input && typeof input === "object" ? input : {};
  const request = readMiniAppAgentObserveRequest({
    ...fields,
    requestId: fields.requestId ?? `${agentRequestPrefix}-${++agentRequestSequence}`
  });
  const onEvent = options?.onEvent;
  if (!request || typeof onEvent !== "function") throw new Error("invalid_request");
  const { requestId } = request;
  if (inFlightAgentRequests.has(requestId)) throw new Error("busy");
  inFlightAgentRequests.add(requestId);
  let response;
  try {
    response = await followAgentStream({
      requestId,
      onEvent,
      read: readMiniAppAgentObservedEvent,
      invoke: () => import_electron2.ipcRenderer.invoke(MINIAPP_AGENT_OBSERVE, request),
      // Observing changes nothing, so a lost settlement is simply retryable.
      lost: "runtime_unavailable"
    });
  } finally {
    inFlightAgentRequests.delete(requestId);
  }
  const result = parseMiniAppAgentObserveResult(response);
  if (!result.ok) throw new Error(result.code);
}
async function listAgentSessions() {
  let response;
  try {
    response = await import_electron2.ipcRenderer.invoke(MINIAPP_AGENT_SESSIONS);
  } catch {
    throw new Error("runtime_unavailable");
  }
  const result = parseMiniAppAgentSessionsResult(response);
  if (!result.ok) throw new Error(result.code);
  return { sessions: result.sessions };
}
async function getAgentSession(sessionId) {
  const request = readMiniAppAgentSessionRequest(sessionId === void 0 ? {} : { sessionId });
  if (!request) throw new Error("invalid_request");
  let response;
  try {
    response = await import_electron2.ipcRenderer.invoke(MINIAPP_AGENT_SESSION, request);
  } catch {
    throw new Error("runtime_unavailable");
  }
  const result = parseMiniAppAgentSessionResult(response);
  if (!result.ok) throw new Error(result.code);
  if (!result.session && request.sessionId !== void 0) throw new Error("runtime_unavailable");
  return result.session;
}
async function invokeAgentTurn(channel, requestId, payload, options) {
  if (inFlightAgentRequests.has(requestId)) throw new Error("busy");
  const onEvent = typeof options?.onEvent === "function" ? options.onEvent : void 0;
  inFlightAgentRequests.add(requestId);
  const observe = onEvent !== void 0;
  const invoke = () => import_electron2.ipcRenderer.invoke(channel, { requestId, ...payload, observe });
  let response;
  try {
    if (onEvent) {
      response = await followAgentStream({
        requestId,
        onEvent,
        read: readMiniAppAgentRunEvent,
        invoke,
        // The turn may already have been submitted; never retry implicitly.
        lost: "result_unknown"
      });
    } else {
      try {
        response = await invoke();
      } catch {
        throw new Error("result_unknown");
      }
    }
  } finally {
    inFlightAgentRequests.delete(requestId);
  }
  const result = parseMiniAppAgentRunResult(response);
  if (!result.ok) throw agentFailureError(result);
  return result.result;
}
function agentFailureError(failure) {
  const error = new Error(failure.code);
  return failure.reason ? Object.assign(error, { reason: failure.reason }) : error;
}
async function invokeAgentCall(channel, payload, parse) {
  let response;
  try {
    response = await import_electron2.ipcRenderer.invoke(channel, payload);
  } catch {
    throw new Error("result_unknown");
  }
  const result = parse(response);
  if (!result.ok) throw agentFailureError(result);
  return result.result;
}
var MINIAPP_WINDOW_GET_STATE = "miniapp:window-get-state";
var MINIAPP_WINDOW_UPDATE = "miniapp:window-update";
var MINIAPP_WINDOW_FOCUS = "miniapp:window-focus";
var WINDOW_STATE_POLL_INTERVAL_MS = 1e3;
var WINDOW_UPDATE_FRAME_FALLBACK_MS = 16;
var WINDOW_UPDATE_HIDDEN_FALLBACK_MS = 50;
var windowGlobal = globalThis;
if (process.isMainFrame) {
  const argv = Array.isArray(process.argv) ? process.argv : void 0;
  const surfaceIdArgument = argv?.find(
    (argument) => argument.startsWith(MINIAPP_SURFACE_ID_ARGUMENT_PREFIX)
  );
  const surfaceId = surfaceIdArgument ? surfaceIdArgument.slice(MINIAPP_SURFACE_ID_ARGUMENT_PREFIX.length) : "";
  import_electron2.contextBridge.exposeInMainWorld("mcode", {
    miniapp: {
      message: {
        // Only an individually confirmed draft append. Sent messages are never writable here.
        async append(text) {
          if (typeof text !== "string") {
            throw new Error("invalid_request");
          }
          if (text.length > MINIAPP_COMPOSER_MAX_TEXT_LENGTH) {
            throw new Error("text_too_large");
          }
          let response;
          try {
            response = await import_electron2.ipcRenderer.invoke(MINIAPP_COMPOSER_APPEND, { text });
          } catch {
            throw new Error("result_unknown");
          }
          const result = parseMiniAppComposerAppendResult(response);
          if (!result) throw new Error("result_unknown");
          if (!result.success) throw new Error(result.code);
        }
      },
      agent: {
        // Identity is resolved by Main from this tab; the payload carries only text and session.
        async run(input, options) {
          const request = readMiniAppAgentRunRequest({
            text: input?.text,
            sessionId: input?.sessionId,
            model: input?.model,
            agent: input?.agent,
            whenBusy: input?.whenBusy,
            requestId: input?.requestId ?? `${agentRequestPrefix}-${++agentRequestSequence}`
          });
          if (!request) throw new Error("invalid_request");
          const { requestId, text, sessionId, model, agent, whenBusy } = request;
          return invokeAgentTurn(
            MINIAPP_AGENT_RUN,
            requestId,
            {
              text,
              ...sessionId !== void 0 ? { sessionId } : {},
              ...model ? { model } : {},
              ...agent !== void 0 ? { agent } : {},
              ...whenBusy !== void 0 ? { whenBusy } : {}
            },
            options
          );
        },
        // AbortSignal cannot cross contextBridge, so cancellation is an explicit id-based call.
        cancel(requestId) {
          if (!inFlightAgentRequests.has(requestId)) return;
          import_electron2.ipcRenderer.send(MINIAPP_AGENT_CANCEL, { requestId });
        },
        async reply(input) {
          const request = readMiniAppAgentReplyRequest(input);
          if (!request) throw new Error("invalid_request");
          let response;
          try {
            response = await import_electron2.ipcRenderer.invoke(MINIAPP_AGENT_REPLY, request);
          } catch {
            throw new Error("result_unknown");
          }
          const result = parseMiniAppAgentReplyResult(response);
          if (!result.ok) throw new Error(result.code);
        },
        async answer(input, options) {
          const request = readMiniAppAgentAnswerRequest({
            sessionId: input?.sessionId,
            questionId: input?.questionId,
            answers: input?.answers,
            model: input?.model,
            requestId: input?.requestId ?? `${agentRequestPrefix}-${++agentRequestSequence}`
          });
          if (!request) throw new Error("invalid_request");
          const { requestId, sessionId, questionId, answers, model } = request;
          return invokeAgentTurn(
            MINIAPP_AGENT_ANSWER,
            requestId,
            { sessionId, questionId, answers, ...model ? { model } : {} },
            options
          );
        },
        // Shows one of this plugin's own sessions in the host chat's side panel.
        async open(sessionId) {
          const request = readMiniAppAgentOpenRequest({ sessionId });
          if (!request) throw new Error("invalid_request");
          let response;
          try {
            response = await import_electron2.ipcRenderer.invoke(MINIAPP_AGENT_OPEN, request);
          } catch {
            throw new Error("result_unknown");
          }
          const result = parseMiniAppAgentOpenResult(response);
          if (!result.ok) throw new Error(result.code);
        },
        // The enabled models, the default, and the host chat's current model when there is one.
        models() {
          return invokeAgentCall(MINIAPP_AGENT_MODELS, {}, parseMiniAppAgentModelsResult);
        },
        agents() {
          return invokeAgentCall(MINIAPP_AGENT_AGENTS, {}, parseMiniAppAgentAgentsResult);
        },
        // A session without a turn; `run({ sessionId })` continues it.
        async create(input) {
          const request = readMiniAppAgentCreateRequest(input ?? {});
          if (!request) throw new Error("invalid_request");
          return invokeAgentCall(MINIAPP_AGENT_CREATE, request, parseMiniAppAgentCreateResult);
        },
        // Need `session.read` for anything but this Mini App's own sessions.
        observe: observeAgent,
        sessions: listAgentSessions,
        session: getAgentSession
      },
      // Only `request`: listing and calling tools is Node `context.tool`.
      tool: {
        async request(names) {
          if (windowGlobal.navigator?.userActivation?.isActive !== true) {
            throw new Error("invalid_request");
          }
          if (!Array.isArray(names) || names.length === 0 || names.length > MINIAPP_TOOL_REQUEST_MAX_NAMES || !names.every((name) => typeof name === "string")) {
            throw new Error("invalid_request");
          }
          let response;
          try {
            response = await import_electron2.ipcRenderer.invoke(MINIAPP_TOOL_REQUEST, { names: [...names] });
          } catch {
            throw new Error("result_unknown");
          }
          return readToolRequestResponse(response);
        }
      },
      window: createMiniAppWindowHandle(surfaceId),
      // Requires `deviceAccess: ["microphone"]` and that switch on; Main decides per call.
      speech: {
        transcribe(input, options) {
          return transcribeSpeech(input, options);
        }
      },
      // Fixed per Host version; answers nothing about this Mini App's manifest or grants.
      capabilities: {
        has(name) {
          return typeof name === "string" && hasMiniAppHostCapability(name);
        }
      }
    }
  });
}
function readToolRequestResponse(response) {
  const value = response ?? {};
  if (value.success === false && typeof value.code === "string") throw new Error(value.code);
  const permissions = value.permissions;
  if (value.success !== true || !permissions || typeof permissions !== "object" || !Object.values(permissions).every((verdict) => TOOL_PERMISSIONS.has(verdict))) {
    throw new Error("result_unknown");
  }
  return { ...permissions };
}
function createMiniAppWindowHandle(surfaceId) {
  let pendingFrame = null;
  let cancelScheduledFlush = null;
  const listeners = /* @__PURE__ */ new Set();
  let pollHandle = null;
  let lastDeliveredJson = null;
  function hasActiveGesture() {
    return windowGlobal.navigator?.userActivation?.isActive === true;
  }
  function scheduleFlush() {
    const raf = windowGlobal.requestAnimationFrame;
    if (typeof raf !== "function") {
      const handle = setTimeout(() => flushPendingFrame(), WINDOW_UPDATE_FRAME_FALLBACK_MS);
      cancelScheduledFlush = () => clearTimeout(handle);
      return;
    }
    const timeout = setTimeout(() => flushPendingFrame(), WINDOW_UPDATE_HIDDEN_FALLBACK_MS);
    const rafHandle = raf(() => flushPendingFrame());
    cancelScheduledFlush = () => {
      windowGlobal.cancelAnimationFrame?.(rafHandle);
      clearTimeout(timeout);
    };
  }
  function flushPendingFrame() {
    if (!pendingFrame) return;
    cancelScheduledFlush?.();
    cancelScheduledFlush = null;
    const { patch, waiters, userActivated } = pendingFrame;
    pendingFrame = null;
    dispatchUpdate(patch, userActivated).then(
      (state) => waiters.forEach((waiter) => waiter.resolve(state)),
      (error) => waiters.forEach((waiter) => waiter.reject(error))
    );
  }
  function deliverStateChange(state) {
    lastDeliveredJson = JSON.stringify(state);
    for (const listener of listeners) {
      try {
        listener(state);
      } catch {
      }
    }
  }
  async function invokeWindowIpc(channel, ...args) {
    let response;
    try {
      response = await import_electron2.ipcRenderer.invoke(channel, ...args);
    } catch {
      throw new Error("result_unknown");
    }
    const parsed = parseMiniAppWindowResult(response);
    if (!parsed) throw new Error("result_unknown");
    if (!parsed.success) throw new Error(parsed.code);
    return parsed.state;
  }
  async function dispatchUpdate(patch, userActivated) {
    const state = await invokeWindowIpc(MINIAPP_WINDOW_UPDATE, { patch, userActivated });
    deliverStateChange(state);
    return state;
  }
  function stopPolling() {
    if (pollHandle === null) return;
    clearInterval(pollHandle);
    pollHandle = null;
  }
  function ensurePolling() {
    if (pollHandle !== null) return;
    pollHandle = setInterval(() => {
      getState().then(
        (state) => {
          const json = JSON.stringify(state);
          if (lastDeliveredJson === null) {
            lastDeliveredJson = json;
            return;
          }
          if (json !== lastDeliveredJson) deliverStateChange(state);
        },
        () => {
        }
      );
    }, WINDOW_STATE_POLL_INTERVAL_MS);
  }
  async function getState() {
    if (!surfaceId) throw new Error("result_unknown");
    return invokeWindowIpc(MINIAPP_WINDOW_GET_STATE);
  }
  async function update(patch) {
    if (!surfaceId) throw new Error("result_unknown");
    const parsed = parseMiniAppWindowPatch(patch);
    if (!parsed.ok) throw new Error(parsed.code);
    const validated = parsed.patch;
    const activated = hasActiveGesture();
    if (validated.mode !== void 0) {
      if (!activated) throw new Error("not_permitted");
      flushPendingFrame();
      return dispatchUpdate(validated, true);
    }
    return new Promise((resolve, reject) => {
      const frame = pendingFrame ?? { patch: {}, waiters: [], userActivated: false };
      if (!pendingFrame) {
        pendingFrame = frame;
        scheduleFlush();
      }
      Object.assign(frame.patch, validated);
      frame.userActivated = frame.userActivated || activated;
      frame.waiters.push({ resolve, reject });
    });
  }
  async function focus() {
    if (!surfaceId) throw new Error("result_unknown");
    if (!hasActiveGesture()) throw new Error("not_permitted");
    await invokeWindowIpc(MINIAPP_WINDOW_FOCUS, { userActivated: true });
  }
  function onDidChangeState(listener) {
    if (typeof listener !== "function") throw new Error("invalid_request");
    const isFirstSubscriber = listeners.size === 0;
    listeners.add(listener);
    if (isFirstSubscriber) {
      getState().then(
        (state) => {
          lastDeliveredJson = JSON.stringify(state);
        },
        () => {
        }
      );
    }
    ensurePolling();
    return {
      dispose() {
        if (listeners.delete(listener) && listeners.size === 0) {
          stopPolling();
          lastDeliveredJson = null;
        }
      }
    };
  }
  windowGlobal.addEventListener?.("pagehide", () => {
    stopPolling();
    listeners.clear();
  });
  return { id: surfaceId, getState, update, focus, onDidChangeState };
}
