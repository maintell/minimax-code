import { randomUUID } from "node:crypto";
import { MINIAPP_AGENT_FAILURE_CODES, readMiniAppAgentObservedEvent, readMiniAppAgentRunEvent, readMiniAppAgentRunResult, toMiniAppAgentFailureCode, isMiniAppAgentBusyReason, parseMiniAppPermissionId, readMiniAppAgentModelSelection, MINIAPP_AGENT_MAX_TEXT_LENGTH, isMiniAppAgentWhenBusy, isMiniAppAgentPermissionDecision, readMiniAppAgentAnswers, readMiniAppAgentObserveTarget, readMiniAppAgentSessionList, readMiniAppAgentSessionDetail, readMiniAppAgentModels, readMiniAppAgentAgents, readMiniAppAgentCreateResponse, validateMiniAppSurfaceWindow, parseMiniAppPermissionList } from "@mavis/shared/miniapp-surface";
import { parseMiniAppLoopbackOrigin } from "../../browser/miniapp-loopback-origin";
import { isSafeBrokerRequestId } from "./control";
const UTILITY_CONSOLE_LOGGER = {
    warn: (message, fields) => console.warn(`[LocalRuntimeUtility] ${message}`, fields),
};
const MINIAPP_ERROR_MESSAGES = {
    invalid_request: 'Invalid Mini App request',
    runtime_unavailable: 'Mini App runtime is unavailable',
    not_found: 'Mini App was not found',
    busy: 'Mini App is busy',
    refresh_failed: 'Mini App page refresh failed',
    stop_failed: 'Mini App failed to stop',
    start_failed: 'Mini App failed to start',
    detach_failed: 'Mini App page could not open in its own window',
    attach_failed: 'Mini App page could not return to the panel',
    no_update: 'Mini App has no pending update',
    update_failed: 'Mini App update failed',
    permission_unknown: 'Mini App does not declare this permission',
    permission_failed: 'Mini App permission could not be changed',
    not_permitted: 'Mini App Agent access is not permitted',
    session_not_found: 'Mini App Agent session was not found',
    cancelled: 'Mini App Agent run was cancelled',
    result_unknown: 'Mini App Agent run result is unknown',
    request_not_found: 'Mini App Agent request was not found or already settled',
};
const MINIAPP_AGENT_FAILURE_CODE_SET = new Set(MINIAPP_AGENT_FAILURE_CODES);
const MINIAPP_SURFACE_ERROR_CODE_SET = new Set([
    'invalid_request',
    'runtime_unavailable',
    'not_found',
    'busy',
    'refresh_failed',
    'stop_failed',
    'start_failed',
    'no_update',
    'update_failed',
    'permission_unknown',
    'permission_failed',
]);
const REQUEST_TIMEOUT_MS = 60000;
const REQUEST_SETTLEMENT_TIMEOUT_MS = 15000;
function isAgentTurnMethod(method) {
    return method === 'agent.run' || method === 'agent.answer';
}
/** The one place a method's settlement rules are decided; every settlement path reads it. */
const AGENT_METHOD_TRAITS = {
    'agent.run': { stream: true, unknownOnLoss: true },
    'agent.answer': { stream: true, unknownOnLoss: true },
    'agent.observe': { stream: true, unknownOnLoss: false },
    'agent.reply': { stream: false, unknownOnLoss: true },
    'agent.open': { stream: false, unknownOnLoss: true },
    'agent.panelOpened': { stream: false, unknownOnLoss: true },
    'agent.panelClosed': { stream: false, unknownOnLoss: true },
    'agent.models': { stream: false, unknownOnLoss: true },
    'agent.agents': { stream: false, unknownOnLoss: true },
    'agent.create': { stream: false, unknownOnLoss: true },
    'agent.sessions': { stream: false, unknownOnLoss: false },
    'agent.session': { stream: false, unknownOnLoss: false },
};
function isAgentStreamMethod(method) {
    return isAgentMethod(method) && AGENT_METHOD_TRAITS[method].stream;
}
function isAgentReadMethod(method) {
    return method === 'agent.sessions' || method === 'agent.session';
}
/** How a lost Agent settlement is reported; `undefined` for a surface method. */
function lostAgentSettlementCode(method) {
    if (!isAgentMethod(method))
        return undefined;
    return AGENT_METHOD_TRAITS[method].unknownOnLoss ? 'result_unknown' : 'runtime_unavailable';
}
function isAgentPanelMethod(method) {
    return method === 'agent.panelOpened' || method === 'agent.panelClosed';
}
function isAgentCatalogMethod(method) {
    return method === 'agent.models' || method === 'agent.agents' || method === 'agent.create';
}
function isAgentMethod(method) {
    return (typeof method === 'string' && Object.prototype.hasOwnProperty.call(AGENT_METHOD_TRAITS, method));
}
function isAgentCatalogRequest(message) {
    return isAgentCatalogMethod(message.method);
}
function isAgentRequestMessage(message) {
    return isAgentMethod(message.method);
}
// Broker diagnostics cross a process boundary. Keep this closed to the
// Host-owned codes that distinguish manual activation/publication failures;
// unknown values stay private instead of being mirrored automatically.
const MINIAPP_BROKER_HOST_CODES = [
    'ACTIVATION_FAILED',
    'BUSY',
    'CANDIDATE_CHANGED',
    'CLEANUP_UNPROVEN',
    'CLOSED',
    'DISABLED',
    'MINIAPP_CATALOG_STALE',
    'MINIAPP_NOT_AVAILABLE',
    'MINIAPP_PREPARATION_FAILED',
    'NOT_FOUND',
    'NO_ACTIVE_GENERATION',
    'PERSISTENCE_COMPENSATION_FAILED',
    'PERSISTENCE_WRITE_FAILED',
    'PLUGIN_NOT_ENABLED',
    'PLUGIN_NOT_FOUND',
    'PUBLICATION_SUPERSEDED',
    'QUARANTINED',
    'RETIRED_GENERATION',
    'RUNTIME_EXITED',
    'RUNTIME_FAILED',
    'RUNTIME_START_FAILED',
    'RUNTIME_UNAVAILABLE',
    'SERVICE_RESTARTED',
    'SUPERSEDED',
];
const MINIAPP_BROKER_REASON_CODES = [
    'CANDIDATE_CHANGED',
    'ENTRY_OUTSIDE_ARTIFACT',
    'HOST_CONNECTOR_PROTOCOL_VIOLATION',
    'HOST_CONNECTOR_UNAVAILABLE',
    'MINIAPP_MCP_RUNTIME_NOT_READY',
    'MCP_SERVER_START_FAILED',
    'NO_CANDIDATE_PORT',
    'PUBLICATION_NOT_ACCEPTED',
    'PUBLICATION_SUPERSEDED',
    'READINESS_TIMEOUT',
    'RUNNER_LIFECYCLE_INVALID',
    'RUNNER_START_FAILED',
    'START_EXPORT_MISSING',
    'TCP_CONNECT_TIMEOUT',
];
const MINIAPP_BROKER_HOST_CODE_SET = new Set(MINIAPP_BROKER_HOST_CODES);
const MINIAPP_BROKER_REASON_CODE_SET = new Set(MINIAPP_BROKER_REASON_CODES);
const MINIAPP_STOP_ERROR_TYPES = [
    'Error',
    'TypeError',
    'RangeError',
    'SyntaxError',
    'ReferenceError',
    'URIError',
    'EvalError',
    'AggregateError',
    'AbortError',
    'MiniAppError',
    'MiniAppCleanupUnprovenError',
    'MiniAppNodeRuntimeError',
    'PluginSystemError',
    'unknown',
];
const MAX_STOP_FAILURE_DEPTH = 4;
const brokerFailureDiagnostics = new WeakMap();
export class MainMiniAppBrokerClient {
    constructor() {
        this.pending = new Map();
    }
    request(target, method, pluginId, signal) {
        if (signal?.aborted)
            return Promise.reject(abortError());
        const requestId = randomUUID();
        const message = {
            type: 'miniapp-request',
            requestId,
            method,
            ...(pluginId ? { pluginId } : {}),
        };
        if (!isMiniAppBrokerRequestMessage(message)) {
            return Promise.reject(miniAppError('invalid_request'));
        }
        return this.dispatch(target, message, signal);
    }
    /** Short request; resolves with the stored permission list. */
    setPermission(target, input) {
        const message = {
            type: 'miniapp-request',
            requestId: randomUUID(),
            method: 'permissions.set',
            payload: {
                pluginId: input.pluginId,
                permission: input.permission,
                enabled: input.enabled,
            },
        };
        if (!isMiniAppBrokerRequestMessage(message)) {
            return Promise.reject(miniAppError('invalid_request'));
        }
        return this.dispatch(target, message);
    }
    /** Agent turns can run for minutes: no request deadline, only caller cancellation or target loss. */
    runAgent(target, input, options = {}) {
        return this.dispatchAgentTurn(target, {
            type: 'miniapp-request',
            requestId: randomUUID(),
            method: 'agent.run',
            payload: {
                caller: copyAgentCaller(input.caller),
                text: input.text,
                ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
                ...copyAgentModel(input.model),
                ...(input.agent !== undefined ? { agent: input.agent } : {}),
                ...(input.whenBusy !== undefined ? { whenBusy: input.whenBusy } : {}),
                observe: options.onEvent !== undefined,
            },
        }, options);
    }
    /** The continuation turn is followed exactly like `runAgent`. */
    answerAgent(target, input, options = {}) {
        return this.dispatchAgentTurn(target, {
            type: 'miniapp-request',
            requestId: randomUUID(),
            method: 'agent.answer',
            payload: {
                caller: copyAgentCaller(input.caller),
                sessionId: input.sessionId,
                questionId: input.questionId,
                answers: input.answers,
                ...copyAgentModel(input.model),
                observe: options.onEvent !== undefined,
            },
        }, options);
    }
    /** Short request under the ordinary request deadline. */
    async replyAgent(target, input) {
        const message = {
            type: 'miniapp-request',
            requestId: randomUUID(),
            method: 'agent.reply',
            payload: {
                caller: copyAgentCaller(input.caller),
                sessionId: input.sessionId,
                requestId: input.requestId,
                decision: input.decision,
            },
        };
        if (!isMiniAppBrokerRequestMessage(message))
            throw miniAppError('invalid_request');
        await this.dispatch(target, message);
    }
    /** Short request under the ordinary request deadline; the Utility side only checks ownership. */
    async openAgent(target, input) {
        const message = {
            type: 'miniapp-request',
            requestId: randomUUID(),
            method: 'agent.open',
            payload: { caller: copyAgentCaller(input.caller), sessionId: input.sessionId },
        };
        if (!isMiniAppBrokerRequestMessage(message))
            throw miniAppError('invalid_request');
        return (await this.dispatch(target, message));
    }
    /** Short request under the ordinary request deadline; `caller` comes from the sending tab. */
    async modelsAgent(target, input) {
        return (await this.requestAgentCall(target, 'agent.models', {
            caller: copyAgentCaller(input.caller),
        }));
    }
    async agentsAgent(target, input) {
        return (await this.requestAgentCall(target, 'agent.agents', {
            caller: copyAgentCaller(input.caller),
        }));
    }
    async createAgent(target, input) {
        return (await this.requestAgentCall(target, 'agent.create', {
            caller: copyAgentCaller(input.caller),
            ...(input.agent !== undefined ? { agent: input.agent } : {}),
        }));
    }
    requestAgentCall(target, method, payload) {
        const message = {
            type: 'miniapp-request',
            requestId: randomUUID(),
            method,
            payload,
        };
        if (!isMiniAppBrokerRequestMessage(message)) {
            return Promise.reject(miniAppError('invalid_request'));
        }
        return this.dispatch(target, message);
    }
    /** Host-reported side panel change; short request under the ordinary request deadline. */
    async reportAgentPanel(target, method, input) {
        const message = {
            type: 'miniapp-request',
            requestId: randomUUID(),
            method,
            payload: { sessionId: input.sessionId, hostSessionId: input.hostSessionId },
        };
        if (!isMiniAppBrokerRequestMessage(message))
            throw miniAppError('invalid_request');
        await this.dispatch(target, message);
    }
    /**
     * Streams events until the caller cancels (then rejects with an AbortError) or the Utility
     * ends the subscription (resolves). No request deadline.
     */
    async observeAgent(target, input, options) {
        if (options.signal?.aborted)
            throw abortError();
        const message = {
            type: 'miniapp-request',
            requestId: randomUUID(),
            method: 'agent.observe',
            payload: { caller: copyAgentCaller(input.caller), target: copyObserveTarget(input.target) },
        };
        if (!isMiniAppBrokerRequestMessage(message))
            throw miniAppError('invalid_request');
        await this.dispatch(target, message, options.signal, {
            observed: true,
            onEvent: options.onEvent,
        });
    }
    /** Short request under the ordinary request deadline. */
    async listAgentSessions(target, input) {
        const message = {
            type: 'miniapp-request',
            requestId: randomUUID(),
            method: 'agent.sessions',
            payload: { caller: copyAgentCaller(input.caller) },
        };
        if (!isMiniAppBrokerRequestMessage(message))
            throw miniAppError('invalid_request');
        return (await this.dispatch(target, message));
    }
    /** Short request under the ordinary request deadline. */
    async getAgentSession(target, input) {
        const message = {
            type: 'miniapp-request',
            requestId: randomUUID(),
            method: 'agent.session',
            payload: {
                caller: copyAgentCaller(input.caller),
                ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
            },
        };
        if (!isMiniAppBrokerRequestMessage(message))
            throw miniAppError('invalid_request');
        return (await this.dispatch(target, message)).session;
    }
    dispatchAgentTurn(target, message, options) {
        const { signal, onEvent } = options;
        if (signal?.aborted)
            return Promise.reject(abortError());
        if (!isMiniAppBrokerRequestMessage(message)) {
            return Promise.reject(miniAppError('invalid_request'));
        }
        return this.dispatch(target, message, signal, onEvent ? { observed: false, onEvent } : undefined);
    }
    dispatch(target, message, signal, events) {
        const { requestId, method } = message;
        return new Promise((resolve, reject) => {
            const timeout = isAgentStreamMethod(method)
                ? undefined
                : setTimeout(() => {
                    this.cancelRequest(requestId, target, 'deadline');
                }, REQUEST_TIMEOUT_MS);
            const pending = {
                target,
                method,
                resolve,
                reject,
                ...(timeout ? { timeout } : {}),
                ...(signal ? { signal } : {}),
                ...(events ? { events } : {}),
                requestPosted: false,
            };
            if (signal) {
                pending.abortListener = () => this.abortRequest(requestId, target);
                signal.addEventListener('abort', pending.abortListener, { once: true });
            }
            this.pending.set(requestId, pending);
            if (signal?.aborted) {
                this.abortRequest(requestId, target);
                return;
            }
            pending.requestPosted = true;
            try {
                target.postMessage(message);
            }
            catch {
                this.reject(requestId, target, miniAppError('runtime_unavailable'));
            }
        });
    }
    handleMessage(target, value) {
        if (!isRecord(value))
            return false;
        if (value.type === 'miniapp-event') {
            this.forwardEvent(target, value);
            return true;
        }
        if (value.type !== 'miniapp-result' && value.type !== 'miniapp-error')
            return false;
        const requestId = value.requestId;
        if (!isSafeBrokerRequestId(requestId))
            return true;
        const pending = this.take(requestId, target);
        if (!pending)
            return true;
        const diagnostic = parseBrokerErrorDiagnostic(readDataProperty(value, 'diagnostic'));
        const result = readBrokerResultMessage(value, pending.method);
        if (result) {
            pending.resolve(result);
        }
        else if (isMiniAppBrokerErrorMessage(value, diagnostic, pending.method)) {
            const unknownAfterCancel = isAgentTurnMethod(pending.method) && value.code === 'result_unknown';
            if (pending.cancellation === 'caller' && !unknownAfterCancel) {
                pending.reject(abortError());
            }
            else {
                const error = miniAppError(value.code, value.busyReason);
                brokerFailureDiagnostics.set(error, Object.freeze({
                    brokerRequestId: value.requestId,
                    ...diagnostic,
                }));
                pending.reject(error);
            }
        }
        else {
            pending.reject(unreadableSettlementError(pending));
        }
        return true;
    }
    releaseTarget(target) {
        for (const [requestId, pending] of this.pending) {
            if (pending.target !== target)
                continue;
            // A submitted Agent request may still have applied; never let the page retry it implicitly.
            this.reject(requestId, target, miniAppError(lostAgentSettlementCode(pending.method) ?? 'runtime_unavailable'));
        }
    }
    forwardEvent(target, value) {
        if (!hasOnlyKeys(value, ['type', 'requestId', 'event']))
            return;
        if (!isSafeBrokerRequestId(value.requestId))
            return;
        const pending = this.pending.get(value.requestId);
        if (!pending || pending.target !== target || !isAgentStreamMethod(pending.method))
            return;
        const { events } = pending;
        try {
            if (events?.observed) {
                const event = readMiniAppAgentObservedEvent(value.event);
                if (event)
                    events.onEvent(event);
            }
            else if (events) {
                const event = readMiniAppAgentRunEvent(value.event);
                if (event)
                    events.onEvent(event);
            }
        }
        catch {
            // Event delivery is best-effort and never settles the run.
        }
    }
    pendingCount() {
        return this.pending.size;
    }
    take(requestId, target) {
        const pending = this.pending.get(requestId);
        if (!pending || pending.target !== target)
            return undefined;
        if (pending.timeout)
            clearTimeout(pending.timeout);
        if (pending.settlementWatchdog)
            clearTimeout(pending.settlementWatchdog);
        if (pending.signal && pending.abortListener) {
            pending.signal.removeEventListener('abort', pending.abortListener);
        }
        this.pending.delete(requestId);
        return pending;
    }
    abortRequest(requestId, target) {
        const current = this.pending.get(requestId);
        if (!current || current.target !== target)
            return;
        if ((current.method === 'stop' ||
            current.method === 'applyUpdate' ||
            isAgentTurnMethod(current.method)) &&
            current.requestPosted) {
            this.cancelRequest(requestId, target, 'caller');
            return;
        }
        const pending = this.take(requestId, target);
        if (!pending)
            return;
        if (pending.requestPosted)
            this.postCancel(target, requestId);
        pending.reject(abortError());
    }
    cancelRequest(requestId, target, cancellation) {
        const pending = this.pending.get(requestId);
        if (!pending || pending.target !== target || pending.cancellation)
            return;
        const awaitAuthoritativeSettlement = pending.requestPosted &&
            (pending.method === 'stop' ||
                pending.method === 'applyUpdate' ||
                isAgentTurnMethod(pending.method) ||
                (pending.method === 'open' && cancellation === 'deadline'));
        if (!awaitAuthoritativeSettlement) {
            const taken = this.take(requestId, target);
            if (!taken)
                return;
            if (taken.requestPosted)
                this.postCancel(target, requestId);
            taken.reject(cancellation === 'caller'
                ? abortError()
                : // A reply past its deadline may still have been applied.
                    miniAppError(taken.method === 'agent.reply' ? 'result_unknown' : 'runtime_unavailable'));
            return;
        }
        pending.cancellation = cancellation;
        this.postCancel(target, requestId);
        if (this.pending.get(requestId) !== pending)
            return;
        pending.settlementWatchdog = setTimeout(() => {
            const unsettled = this.take(requestId, target);
            if (!unsettled)
                return;
            // An agent turn that never confirmed its abort may still have run.
            if (isAgentTurnMethod(unsettled.method)) {
                unsettled.reject(miniAppError('result_unknown'));
                return;
            }
            unsettled.reject(cancellation === 'caller' ? abortError() : miniAppError('runtime_unavailable'));
        }, REQUEST_SETTLEMENT_TIMEOUT_MS);
        pending.settlementWatchdog.unref?.();
    }
    postCancel(target, requestId) {
        try {
            target.postMessage({
                type: 'miniapp-cancel',
                requestId,
            });
        }
        catch {
            // Target loss is settled by the watchdog or releaseTarget.
        }
    }
    reject(requestId, target, error) {
        const pending = this.take(requestId, target);
        pending?.reject(error);
    }
}

export class UtilityMiniAppBrokerServer {
    constructor(target, logger = UTILITY_CONSOLE_LOGGER) {
        this.target = target;
        this.logger = logger;
        this.pending = new Map();
    }
    bind(application, agent) {
        this.application = application;
        this.agent = agent;
    }
    handleMessage(value) {
        if (!isRecord(value))
            return false;
        if (value.type === 'miniapp-cancel') {
            if (!isMiniAppBrokerCancelMessage(value))
                return true;
            this.cancelRequest(value.requestId);
            return true;
        }
        if (value.type !== 'miniapp-request')
            return false;
        const requestId = value.requestId;
        if (!isSafeBrokerRequestId(requestId))
            return true;
        if (!isMiniAppBrokerRequestMessage(value)) {
            this.postError(requestId, 'invalid_request');
            return true;
        }
        if (this.pending.has(requestId)) {
            this.postError(requestId, 'busy');
            return true;
        }
        if (isAgentRequestMessage(value)) {
            this.handleAgentRequest(value);
            return true;
        }
        const application = this.application;
        if (!application) {
            this.postError(requestId, 'runtime_unavailable');
            return true;
        }
        const controller = new AbortController();
        const pending = { controller, method: value.method };
        this.pending.set(requestId, pending);
        void execute(application, value, controller.signal).then((result) => {
            if (!this.takePending(requestId, pending))
                return;
            if (!isMiniAppBrokerResult(result)) {
                this.postError(requestId, isPermissionMethod(value.method) ? 'permission_failed' : 'start_failed');
                return;
            }
            this.postResult(requestId, value.method, result);
        }, (error) => {
            if (!this.takePending(requestId, pending))
                return;
            const code = normalizeErrorCode(error, value.method);
            this.postError(requestId, code, code === 'busy' ? normalizeBusyReason(error) : undefined, value.method === 'stop'
                ? readStopErrorDiagnostic(error)
                : value.method === 'open'
                    ? readBrokerErrorDiagnostic(error)
                    : undefined);
        });
        return true;
    }
    close() {
        this.application = undefined;
        this.agent = undefined;
        for (const pending of this.pending.values()) {
            if (pending.settlementWatchdog)
                clearTimeout(pending.settlementWatchdog);
            pending.controller.abort();
        }
        this.pending.clear();
    }
    pendingCount() {
        return this.pending.size;
    }
    handleAgentRequest(request) {
        const { requestId } = request;
        const agent = this.agent;
        if (!agent) {
            this.postError(requestId, 'runtime_unavailable');
            return;
        }
        const controller = new AbortController();
        const pending = { controller, method: request.method };
        this.pending.set(requestId, pending);
        if (request.method === 'agent.reply') {
            void Promise.resolve()
                .then(() => agent.reply(request.payload))
                .then(() => {
                if (!this.takePending(requestId, pending))
                    return;
                this.postResult(requestId, request.method, { replied: true });
            }, (error) => {
                if (!this.takePending(requestId, pending))
                    return;
                this.postAgentError(requestId, error);
            });
            return;
        }
        if (isAgentCatalogRequest(request)) {
            this.handleAgentCatalogRequest(request, agent, pending);
            return;
        }
        if (request.method === 'agent.panelOpened' || request.method === 'agent.panelClosed') {
            const { method, payload } = request;
            void Promise.resolve()
                .then(() => method === 'agent.panelOpened' ? agent.panelOpened(payload) : agent.panelClosed(payload))
                .then(() => {
                if (!this.takePending(requestId, pending))
                    return;
                this.postResult(requestId, method, { acknowledged: true });
            }, (error) => {
                if (!this.takePending(requestId, pending))
                    return;
                this.postAgentError(requestId, error);
            });
            return;
        }
        if (request.method === 'agent.observe') {
            this.observeAgent(agent, request, pending);
            return;
        }
        if (request.method === 'agent.sessions' || request.method === 'agent.session') {
            this.readAgentSessions(agent, request, pending);
            return;
        }
        if (request.method === 'agent.open') {
            void Promise.resolve()
                .then(() => agent.open(request.payload))
                .then((value) => {
                if (!this.takePending(requestId, pending))
                    return;
                // Only the contract fields cross the port; anything else stays in the Utility.
                const result = isRecord(value)
                    ? readAgentOpenResult({
                        sessionId: value.sessionId,
                        hostSessionId: value.hostSessionId,
                    })
                    : undefined;
                if (!result) {
                    this.postError(requestId, 'result_unknown');
                    return;
                }
                this.postResult(requestId, request.method, result);
            }, (error) => {
                if (!this.takePending(requestId, pending))
                    return;
                this.postAgentError(requestId, error);
            });
            return;
        }
        const onEvent = (value) => {
            if (this.pending.get(requestId) !== pending)
                return;
            this.postEvent(requestId, readMiniAppAgentRunEvent(value));
        };
        // Only a page that registered `onEvent` is a listener the runtime may wait on.
        const options = {
            signal: controller.signal,
            ...(request.payload.observe === true ? { onEvent } : {}),
        };
        void Promise.resolve()
            .then(() => {
            if (request.method === 'agent.run') {
                const { payload } = request;
                return agent.run({
                    caller: payload.caller,
                    text: payload.text,
                    ...(payload.sessionId !== undefined ? { sessionId: payload.sessionId } : {}),
                    ...(payload.model ? { model: payload.model } : {}),
                    ...(payload.agent !== undefined ? { agent: payload.agent } : {}),
                    ...(payload.whenBusy !== undefined ? { whenBusy: payload.whenBusy } : {}),
                    ...options,
                });
            }
            const { payload } = request;
            return agent.answer({
                caller: payload.caller,
                sessionId: payload.sessionId,
                requestId: payload.questionId,
                answers: payload.answers,
                ...(payload.model ? { model: payload.model } : {}),
                ...options,
            });
        })
            .then((value) => {
            if (!this.takePending(requestId, pending))
                return;
            const result = readMiniAppAgentRunResult(value);
            if (!result) {
                this.postError(requestId, 'result_unknown');
                return;
            }
            this.postResult(requestId, request.method, result);
        }, (error) => {
            if (!this.takePending(requestId, pending))
                return;
            this.postAgentError(requestId, error);
        });
    }
    /**
     * `models` / `agents` / `create`: only the contract fields cross the port, validated with the
     * shared readers; anything else stays in the Utility.
     */
    handleAgentCatalogRequest(request, agent, pending) {
        const { requestId, method } = request;
        void Promise.resolve()
            .then(() => {
            if (request.method === 'agent.models')
                return agent.models(request.payload);
            if (request.method === 'agent.agents')
                return agent.agents(request.payload);
            return agent.create(request.payload);
        })
            .then((value) => {
            if (!this.takePending(requestId, pending))
                return;
            const result = readAgentCatalogResult(method, value);
            if (!result) {
                this.postError(requestId, 'result_unknown');
                return;
            }
            this.postResult(requestId, method, result);
        }, (error) => {
            if (!this.takePending(requestId, pending))
                return;
            this.postAgentError(requestId, error);
        });
    }
    /** Events flow until the subscription ends; a cancel just aborts it (nothing to confirm). */
    observeAgent(agent, request, pending) {
        const { requestId, payload } = request;
        const onEvent = (value) => {
            if (this.pending.get(requestId) !== pending)
                return;
            this.postEvent(requestId, readMiniAppAgentObservedEvent(value));
        };
        void Promise.resolve()
            .then(() => agent.observe({
            caller: payload.caller,
            target: payload.target,
            signal: pending.controller.signal,
            onEvent,
        }))
            .then(() => {
            if (!this.takePending(requestId, pending))
                return;
            this.postResult(requestId, request.method, { ended: true });
        }, (error) => {
            if (!this.takePending(requestId, pending))
                return;
            this.postError(requestId, normalizeAgentReadErrorCode(error));
        });
    }
    /** Only contract fields cross the port; a read changes nothing, so a malformed value is retryable. */
    readAgentSessions(agent, request, pending) {
        const { requestId } = request;
        void Promise.resolve()
            .then(async () => request.method === 'agent.sessions'
            ? readAgentSessionsResult(await agent.sessions(request.payload))
            : readAgentSessionResult(sessionResult(await agent.session(request.payload))))
            .then((result) => {
            if (!this.takePending(requestId, pending))
                return;
            if (!result) {
                this.postError(requestId, 'runtime_unavailable');
                return;
            }
            this.postResult(requestId, request.method, result);
        }, (error) => {
            if (!this.takePending(requestId, pending))
                return;
            this.postError(requestId, normalizeAgentReadErrorCode(error));
        });
    }
    /** `event` is the allowlist copy of what the runtime emitted; null drops it. */
    postEvent(requestId, event) {
        if (!event)
            return;
        try {
            this.target.postMessage({
                type: 'miniapp-event',
                requestId,
                event,
            });
        }
        catch {
            // Uncloneable frame data or a closing port drops this event only.
        }
    }
    cancelRequest(requestId) {
        const pending = this.pending.get(requestId);
        if (!pending || pending.controller.signal.aborted)
            return;
        if (pending.method !== 'open' &&
            pending.method !== 'stop' &&
            pending.method !== 'applyUpdate' &&
            !isAgentTurnMethod(pending.method)) {
            this.pending.delete(requestId);
            pending.controller.abort();
            return;
        }
        pending.settlementWatchdog = setTimeout(() => {
            if (!this.takePending(requestId, pending))
                return;
            // An agent turn that never confirmed its abort may still have run; never
            // report it as cleanly cancelled.
            this.postError(requestId, isAgentTurnMethod(pending.method) ? 'result_unknown' : 'runtime_unavailable');
        }, REQUEST_SETTLEMENT_TIMEOUT_MS);
        pending.settlementWatchdog.unref?.();
        // Keep open/stop registered until the operation reports whether a native
        // tab was committed or a direct root was actually stopped. The watchdog
        // is only cleanup; it never invents either success result.
        pending.controller.abort();
    }
    takePending(requestId, expected) {
        const pending = this.pending.get(requestId);
        if (pending !== expected)
            return false;
        this.pending.delete(requestId);
        if (pending.settlementWatchdog)
            clearTimeout(pending.settlementWatchdog);
        return true;
    }
    /**
     * A result that cannot cross the port is reported as unknown: the operation already ran. Main's
     * `releaseTarget` / deadline still settles the request if the fallback error is lost too.
     */
    postResult(requestId, method, result) {
        try {
            this.target.postMessage({ type: 'miniapp-result', requestId, result });
        }
        catch (error) {
            this.logger.warn('miniapp broker result delivery failed', {
                requestId,
                method,
                errorName: readErrorName(error),
            });
            // Surface requests have no `result_unknown`; their callers treat target loss the same way.
            this.postError(requestId, lostAgentSettlementCode(method) ?? 'runtime_unavailable');
        }
    }
    postAgentError(requestId, error) {
        const code = normalizeAgentErrorCode(error);
        this.postError(requestId, code, code === 'busy' ? normalizeAgentBusyReason(error) : undefined);
    }
    postError(requestId, code, busyReason, diagnostic) {
        try {
            this.target.postMessage({
                type: 'miniapp-error',
                requestId,
                code,
                message: MINIAPP_ERROR_MESSAGES[code],
                ...(code === 'busy' && busyReason ? { busyReason } : {}),
                ...(diagnostic ? { diagnostic } : {}),
            });
        }
        catch (error) {
            // Main settles the request through `releaseTarget` or its deadline.
            this.logger.warn('miniapp broker error delivery failed', {
                requestId,
                code,
                errorName: readErrorName(error),
            });
        }
    }
}

/** Reads only the private, bounded diagnostic attached by the Main-side broker client. */
export function readMiniAppBrokerFailureDiagnostic(error) {
    return error instanceof Error ? brokerFailureDiagnostics.get(error) : undefined;
}
async function execute(application, request, signal) {
    if (request.method === 'list')
        return application.list();
    if (request.method === 'permissions.set') {
        return { permissions: await application.setPermission(request.payload) };
    }
    const pluginId = request.pluginId;
    if (!pluginId)
        throw miniAppError('invalid_request');
    if (request.method === 'open')
        return application.open({ pluginId, signal });
    if (request.method === 'credential')
        return application.credential({ pluginId, signal });
    if (request.method === 'applyUpdate')
        return application.applyUpdate({ pluginId, signal });
    if (request.method === 'permissions.list') {
        return { permissions: await application.listPermissions({ pluginId }) };
    }
    await application.stop({ pluginId, signal });
    return { stopped: true };
}
function normalizeAgentErrorCode(error) {
    if (error instanceof Error && error.name === 'AbortError')
        return 'cancelled';
    const code = error && typeof error === 'object' && 'code' in error
        ? error.code
        : undefined;
    // An unrecognised failure may follow a submitted turn, so it is not retryable.
    return toMiniAppAgentFailureCode(code) ?? 'result_unknown';
}
/** The runtime's `MiniAppAgentError.reason` of a `BUSY`. */
function normalizeAgentBusyReason(error) {
    const reason = error && typeof error === 'object' && 'reason' in error
        ? error.reason
        : undefined;
    return isMiniAppAgentBusyReason(reason) ? reason : undefined;
}
/** Reads and observers change nothing: an unrecognised failure is retryable, never unknown. */
function normalizeAgentReadErrorCode(error) {
    const code = normalizeAgentErrorCode(error);
    return code === 'result_unknown' ? 'runtime_unavailable' : code;
}
function normalizeErrorCode(error, method) {
    if (error instanceof Error && error.name === 'AbortError') {
        return 'runtime_unavailable';
    }
    const code = error && typeof error === 'object' && 'code' in error
        ? error.code
        : undefined;
    if (code === 'NOT_FOUND' || code === 'PLUGIN_NOT_FOUND' || code === 'PLUGIN_NOT_ENABLED') {
        return 'not_found';
    }
    if (code === 'MINIAPP_NO_UPDATE')
        return 'no_update';
    if (code === 'BUSY' || code === 'PUBLICATION_SUPERSEDED')
        return 'busy';
    if (code === 'RUNTIME_UNAVAILABLE')
        return 'runtime_unavailable';
    if (code === 'INVALID_REQUEST')
        return 'invalid_request';
    if (isPermissionMethod(method)) {
        return code === 'PERMISSION_UNKNOWN' ? 'permission_unknown' : 'permission_failed';
    }
    if (method === 'stop')
        return 'stop_failed';
    if (method === 'applyUpdate')
        return 'update_failed';
    return 'start_failed';
}
function normalizeBusyReason(error) {
    const busyReason = error && typeof error === 'object' && 'busyReason' in error
        ? error.busyReason
        : undefined;
    return busyReason === 'capacity_busy' || busyReason === 'operation_busy' ? busyReason : undefined;
}
function miniAppError(code, busyReason) {
    return Object.assign(new Error(MINIAPP_ERROR_MESSAGES[code]), {
        code,
        ...(code === 'busy' && busyReason ? { busyReason } : {}),
    });
}
function abortError() {
    return Object.assign(new Error('Mini App request was cancelled'), { name: 'AbortError' });
}
/**
 * A settlement frame Main cannot read. A submitted Agent request may already have applied, so
 * the caller must not conclude its parameters were wrong and resend; a session read or observer
 * changed nothing and is simply retryable.
 */
function unreadableSettlementError(pending) {
    const lost = lostAgentSettlementCode(pending.method);
    if (lost)
        return miniAppError(lost);
    return pending.cancellation === 'caller' ? abortError() : miniAppError('invalid_request');
}
function readErrorName(error) {
    return error instanceof Error ? error.name : typeof error;
}
function readBrokerErrorDiagnostic(error, dataOnly = false) {
    const fields = dataOnly
        ? {
            code: readDataProperty(error, 'code', true),
            reasonCode: readDataProperty(error, 'reasonCode', true),
        }
        : error;
    const hostCode = readAllowedErrorToken(fields, 'code', MINIAPP_BROKER_HOST_CODE_SET);
    const reasonCode = readAllowedErrorToken(fields, 'reasonCode', MINIAPP_BROKER_REASON_CODE_SET);
    return hostCode || reasonCode
        ? {
            ...(hostCode ? { hostCode: hostCode } : {}),
            ...(reasonCode ? { reasonCode: reasonCode } : {}),
        }
        : undefined;
}
function readAllowedErrorToken(error, key, allowed) {
    if (!isRecord(error))
        return undefined;
    try {
        const value = error[key];
        return typeof value === 'string' && allowed.has(value) ? value : undefined;
    }
    catch {
        return undefined;
    }
}
/** Diagnostics read data properties only; getters must not run during failure reporting. */
function readDataProperty(value, key, inherited = false) {
    try {
        let current = value;
        for (let depth = 0; depth < MAX_STOP_FAILURE_DEPTH; depth += 1) {
            if (!current || typeof current !== 'object')
                return undefined;
            const descriptor = Object.getOwnPropertyDescriptor(current, key);
            if (descriptor)
                return 'value' in descriptor ? descriptor.value : undefined;
            if (!inherited)
                return undefined;
            current = Object.getPrototypeOf(current);
        }
    }
    catch {
        // Hostile properties cannot replace the original operation result.
    }
    return undefined;
}
function readStopErrorDiagnostic(error) {
    const failureChain = [];
    const seen = new Set();
    let current = error;
    while (failureChain.length < MAX_STOP_FAILURE_DEPTH && !seen.has(current)) {
        seen.add(current);
        const name = readDataProperty(current, 'name', true);
        const errorType = MINIAPP_STOP_ERROR_TYPES.find((type) => type === name) ?? 'unknown';
        failureChain.push({
            errorType,
            ...readBrokerErrorDiagnostic(current, true),
        });
        const cause = readDataProperty(current, 'cause');
        if (cause === undefined)
            break;
        current = cause;
    }
    return { ...readBrokerErrorDiagnostic(error, true), failureChain };
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function hasOnlyKeys(value, allowed) {
    return Object.keys(value).every((key) => allowed.includes(key));
}
function isSafePluginId(value) {
    return (typeof value === 'string' &&
        value.length > 0 &&
        value.length <= 256 &&
        value.trim() === value &&
        !/[\u0000-\u001f\u007f]/u.test(value));
}
const AGENT_PAYLOAD_VALIDATORS = {
    'agent.run': isAgentRunPayload,
    'agent.models': isAgentCatalogPayload,
    'agent.agents': isAgentCatalogPayload,
    'agent.create': isAgentCreatePayload,
    'agent.reply': isAgentReplyPayload,
    'agent.answer': isAgentAnswerPayload,
    'agent.open': isAgentOpenPayload,
    'agent.panelOpened': isAgentPanelPayload,
    'agent.panelClosed': isAgentPanelPayload,
    'agent.observe': isAgentObservePayload,
    'agent.sessions': isAgentSessionsPayload,
    'agent.session': isAgentSessionReadPayload,
};
function isMiniAppBrokerRequestMessage(value) {
    if (!isRecord(value) || value.type !== 'miniapp-request')
        return false;
    if (isAgentMethod(value.method)) {
        return (hasOnlyKeys(value, ['type', 'requestId', 'method', 'payload']) &&
            isSafeBrokerRequestId(value.requestId) &&
            AGENT_PAYLOAD_VALIDATORS[value.method](value.payload));
    }
    if (value.method === 'permissions.set') {
        return (hasOnlyKeys(value, ['type', 'requestId', 'method', 'payload']) &&
            isSafeBrokerRequestId(value.requestId) &&
            isPermissionSetPayload(value.payload));
    }
    if (!hasOnlyKeys(value, ['type', 'requestId', 'method', 'pluginId']))
        return false;
    if (!isSafeBrokerRequestId(value.requestId))
        return false;
    if (value.method !== 'list' &&
        value.method !== 'open' &&
        value.method !== 'stop' &&
        value.method !== 'credential' &&
        value.method !== 'applyUpdate' &&
        value.method !== 'permissions.list') {
        return false;
    }
    return value.method === 'list' ? value.pluginId === undefined : isSafePluginId(value.pluginId);
}
function isPermissionMethod(method) {
    return method === 'permissions.list' || method === 'permissions.set';
}
function isPermissionSetPayload(value) {
    return (isRecord(value) &&
        hasOnlyKeys(value, ['pluginId', 'permission', 'enabled']) &&
        isSafePluginId(value.pluginId) &&
        parseMiniAppPermissionId(value.permission) !== null &&
        typeof value.enabled === 'boolean');
}
function isAgentCaller(caller) {
    return (isRecord(caller) &&
        hasOnlyKeys(caller, ['pluginId', 'runId', 'hostSessionId']) &&
        isSafePluginId(caller.pluginId) &&
        isSafeLabel(caller.runId) &&
        (caller.hostSessionId === undefined || isSafeLabel(caller.hostSessionId)));
}
function copyAgentCaller(caller) {
    return {
        pluginId: caller.pluginId,
        runId: caller.runId,
        ...(caller.hostSessionId !== undefined ? { hostSessionId: caller.hostSessionId } : {}),
    };
}
function copyAgentModel(model) {
    // A malformed model is passed on as is, so the request check rejects it as `invalid_request`.
    return model === undefined ? {} : { model: readMiniAppAgentModelSelection(model) ?? model };
}
function isOptionalModel(value) {
    return value === undefined || readMiniAppAgentModelSelection(value) !== null;
}
function isOptionalSafeLabel(value) {
    return value === undefined || isSafeLabel(value);
}
function isAgentRunPayload(value) {
    if (!isRecord(value) ||
        !hasOnlyKeys(value, ['caller', 'text', 'sessionId', 'model', 'agent', 'whenBusy', 'observe'])) {
        return false;
    }
    return (isAgentCaller(value.caller) &&
        typeof value.text === 'string' &&
        value.text.length <= MINIAPP_AGENT_MAX_TEXT_LENGTH &&
        isOptionalSafeLabel(value.sessionId) &&
        isOptionalModel(value.model) &&
        isOptionalSafeLabel(value.agent) &&
        (value.whenBusy === undefined || isMiniAppAgentWhenBusy(value.whenBusy)) &&
        isOptionalBoolean(value.observe));
}
function isAgentCatalogPayload(value) {
    return isRecord(value) && hasOnlyKeys(value, ['caller']) && isAgentCaller(value.caller);
}
function isAgentCreatePayload(value) {
    return (isRecord(value) &&
        hasOnlyKeys(value, ['caller', 'agent']) &&
        isAgentCaller(value.caller) &&
        isOptionalSafeLabel(value.agent));
}
function isOptionalBoolean(value) {
    return value === undefined || typeof value === 'boolean';
}
function isAgentReplyPayload(value) {
    if (!isRecord(value) || !hasOnlyKeys(value, ['caller', 'sessionId', 'requestId', 'decision'])) {
        return false;
    }
    return (isAgentCaller(value.caller) &&
        isSafeLabel(value.sessionId) &&
        isSafeLabel(value.requestId) &&
        isMiniAppAgentPermissionDecision(value.decision));
}
function isAgentAnswerPayload(value) {
    if (!isRecord(value) ||
        !hasOnlyKeys(value, ['caller', 'sessionId', 'questionId', 'answers', 'model', 'observe'])) {
        return false;
    }
    return (isAgentCaller(value.caller) &&
        isSafeLabel(value.sessionId) &&
        isSafeLabel(value.questionId) &&
        readMiniAppAgentAnswers(value.answers) !== null &&
        isOptionalModel(value.model) &&
        isOptionalBoolean(value.observe));
}
function isAgentOpenPayload(value) {
    return isAgentSessionReadPayload(value) && value.sessionId !== undefined;
}
/** `{ caller, sessionId? }`: a call about one session (`agent.open` needs the id). */
function isAgentSessionReadPayload(value) {
    return (isRecord(value) &&
        hasOnlyKeys(value, ['caller', 'sessionId']) &&
        isAgentCaller(value.caller) &&
        (value.sessionId === undefined || isSafeLabel(value.sessionId)));
}
function isAgentObservePayload(value) {
    return (isRecord(value) &&
        hasOnlyKeys(value, ['caller', 'target']) &&
        isAgentCaller(value.caller) &&
        isObserveTarget(value.target));
}
/** Exactly `{ sessionId }` or `{ all: true }`. */
function isObserveTarget(value) {
    const target = readMiniAppAgentObserveTarget(value);
    if (!target || !isRecord(value))
        return false;
    return 'sessionId' in target
        ? hasOnlyKeys(value, ['sessionId']) && isSafeLabel(target.sessionId)
        : hasOnlyKeys(value, ['all']);
}
function copyObserveTarget(target) {
    return 'sessionId' in target ? { sessionId: target.sessionId } : { all: true };
}
function isAgentSessionsPayload(value) {
    return isRecord(value) && hasOnlyKeys(value, ['caller']) && isAgentCaller(value.caller);
}
function readAgentSessionsResult(value) {
    if (!isRecord(value) || !hasOnlyKeys(value, ['sessions']))
        return undefined;
    const sessions = readMiniAppAgentSessionList(value.sessions);
    return sessions ? { sessions } : undefined;
}
function sessionResult(session) {
    return session === undefined ? {} : { session };
}
function readAgentSessionResult(value) {
    if (!isRecord(value) || !hasOnlyKeys(value, ['session']))
        return undefined;
    if (value.session === undefined)
        return {};
    const session = readMiniAppAgentSessionDetail(value.session);
    return session ? { session } : undefined;
}
function isAgentPanelPayload(value) {
    return (isRecord(value) &&
        hasOnlyKeys(value, ['sessionId', 'hostSessionId']) &&
        isSafeLabel(value.sessionId) &&
        isSafeLabel(value.hostSessionId));
}
function readAgentOpenResult(value) {
    return isRecord(value) &&
        hasOnlyKeys(value, ['sessionId', 'hostSessionId']) &&
        isSafeLabel(value.sessionId) &&
        isSafeLabel(value.hostSessionId)
        ? { sessionId: value.sessionId, hostSessionId: value.hostSessionId }
        : undefined;
}
function readAgentCatalogResult(method, value) {
    if (method === 'agent.models')
        return readMiniAppAgentModels(value);
    if (method === 'agent.agents')
        return readMiniAppAgentAgents(value);
    return readMiniAppAgentCreateResponse(value);
}
function isMiniAppBrokerCancelMessage(value) {
    return (isRecord(value) &&
        value.type === 'miniapp-cancel' &&
        hasOnlyKeys(value, ['type', 'requestId']) &&
        isSafeBrokerRequestId(value.requestId));
}
function isMiniAppSurfaceSummary(value) {
    if (!isRecord(value))
        return false;
    if (!hasOnlyKeys(value, ['pluginId', 'displayName', 'description', 'iconUrl', 'runtime', 'update'])) {
        return false;
    }
    if (!isSafePluginId(value.pluginId))
        return false;
    if ((value.displayName !== undefined && !isSafeLabel(value.displayName)) ||
        (value.description !== undefined && !isSafeDescription(value.description)) ||
        (value.iconUrl !== undefined && !isSafeIconUrl(value.iconUrl))) {
        return false;
    }
    if (!isRecord(value.runtime))
        return false;
    if (!hasOnlyKeys(value.runtime, ['kind', 'status', 'errorCode']))
        return false;
    if (value.runtime.kind !== 'process')
        return false;
    if (value.runtime.status !== 'stopped' &&
        value.runtime.status !== 'starting' &&
        value.runtime.status !== 'running' &&
        value.runtime.status !== 'stopping' &&
        value.runtime.status !== 'failed') {
        return false;
    }
    if (value.update !== undefined && !isMiniAppSurfaceUpdate(value.update))
        return false;
    return value.runtime.errorCode === undefined || isSafeLabel(value.runtime.errorCode);
}
function isMiniAppSurfaceUpdate(value) {
    if (!isRecord(value))
        return false;
    if (!hasOnlyKeys(value, ['state', 'currentVersion', 'version']))
        return false;
    if (value.state !== 'available' && value.state !== 'applying')
        return false;
    return ((value.currentVersion === undefined || isSafeLabel(value.currentVersion)) &&
        (value.version === undefined || isSafeLabel(value.version)));
}
function isSafeLabel(value) {
    return (typeof value === 'string' &&
        value.length > 0 &&
        value.length <= 256 &&
        !/[\u0000-\u001f\u007f]/u.test(value));
}
function isSafeDescription(value) {
    return (typeof value === 'string' &&
        value.length <= 2048 &&
        !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value));
}
function isSafeIconUrl(value) {
    return (typeof value === 'string' &&
        value.length <= 4096 &&
        value.startsWith('/mavis/api/file/preview?path=') &&
        !/[\u0000-\u001f\u007f]/u.test(value));
}
// Defence in depth: this broker still calls the shared parser itself rather
// than trusting an upstream check, but no longer re-derives the parse rules.
function isSafeLoopbackOrigin(value) {
    return parseMiniAppLoopbackOrigin(value) !== null;
}
function isSafeSurfacePath(value) {
    return (typeof value === 'string' &&
        value.startsWith('/') &&
        !value.startsWith('//') &&
        value.length <= 2048 &&
        !/[\u0000-\u001f\u007f]/u.test(value));
}
function isSafeLoopbackToken(value) {
    return typeof value === 'string' && /^[A-Za-z0-9_-]{16,256}$/u.test(value);
}
/** The broker does not trust the Utility side; re-validates the shared `surface.window` rules. */
function isSafeMiniAppWindow(value) {
    return validateMiniAppSurfaceWindow(value).ok;
}
function isMiniAppBrokerResult(value) {
    if (!isRecord(value))
        return false;
    if ('stopped' in value)
        return hasOnlyKeys(value, ['stopped']) && value.stopped === true;
    if ('running' in value)
        return hasOnlyKeys(value, ['running']) && value.running === false;
    if ('permissions' in value) {
        return (hasOnlyKeys(value, ['permissions']) && parseMiniAppPermissionList(value.permissions) !== null);
    }
    if ('credential' in value) {
        return (hasOnlyKeys(value, ['credential']) &&
            isRecord(value.credential) &&
            hasOnlyKeys(value.credential, ['origin', 'runId', 'loopbackToken']) &&
            isSafeLoopbackOrigin(value.credential.origin) &&
            isSafeLabel(value.credential.runId) &&
            isSafeLoopbackToken(value.credential.loopbackToken));
    }
    if ('miniApps' in value) {
        return (hasOnlyKeys(value, ['miniApps']) &&
            Array.isArray(value.miniApps) &&
            value.miniApps.length <= 256 &&
            value.miniApps.every(isMiniAppSurfaceSummary));
    }
    return (hasOnlyKeys(value, ['miniApp', 'launch']) &&
        isMiniAppSurfaceSummary(value.miniApp) &&
        isRecord(value.launch) &&
        hasOnlyKeys(value.launch, ['origin', 'surfacePath', 'runId', 'loopbackToken', 'window']) &&
        isSafeLoopbackOrigin(value.launch.origin) &&
        isSafeSurfacePath(value.launch.surfacePath) &&
        isSafeLabel(value.launch.runId) &&
        isSafeLoopbackToken(value.launch.loopbackToken) &&
        (value.launch.window === undefined || isSafeMiniAppWindow(value.launch.window)));
}
function readBrokerResultMessage(value, method) {
    if (!isRecord(value) ||
        value.type !== 'miniapp-result' ||
        !hasOnlyKeys(value, ['type', 'requestId', 'result']) ||
        !isSafeBrokerRequestId(value.requestId)) {
        return undefined;
    }
    if (isAgentTurnMethod(method))
        return readMiniAppAgentRunResult(value.result) ?? undefined;
    if (method === 'agent.reply') {
        return isRecord(value.result) &&
            hasOnlyKeys(value.result, ['replied']) &&
            value.result.replied === true
            ? { replied: true }
            : undefined;
    }
    if (method === 'agent.open')
        return readAgentOpenResult(value.result);
    if (isAgentCatalogMethod(method))
        return readAgentCatalogResult(method, value.result) ?? undefined;
    if (method === 'agent.observe') {
        return isRecord(value.result) &&
            hasOnlyKeys(value.result, ['ended']) &&
            value.result.ended === true
            ? { ended: true }
            : undefined;
    }
    if (method === 'agent.sessions')
        return readAgentSessionsResult(value.result);
    if (method === 'agent.session')
        return readAgentSessionResult(value.result);
    if (isAgentPanelMethod(method)) {
        return isRecord(value.result) &&
            hasOnlyKeys(value.result, ['acknowledged']) &&
            value.result.acknowledged === true
            ? { acknowledged: true }
            : undefined;
    }
    return isMiniAppBrokerResult(value.result) ? value.result : undefined;
}
function isMiniAppBrokerErrorMessage(value, diagnostic, method) {
    if (!isRecord(value) || value.type !== 'miniapp-error')
        return false;
    if (!hasOnlyKeys(value, ['type', 'requestId', 'code', 'message', 'busyReason', 'diagnostic'])) {
        return false;
    }
    if (!isSafeBrokerRequestId(value.requestId))
        return false;
    const allowedCodes = isAgentMethod(method)
        ? MINIAPP_AGENT_FAILURE_CODE_SET
        : MINIAPP_SURFACE_ERROR_CODE_SET;
    if (typeof value.code !== 'string' || !allowedCodes.has(value.code))
        return false;
    if (value.message !== MINIAPP_ERROR_MESSAGES[value.code])
        return false;
    if (Object.prototype.hasOwnProperty.call(value, 'busyReason') &&
        !(value.code === 'busy' && isBusyReasonFor(method, value.busyReason))) {
        return false;
    }
    return !Object.prototype.hasOwnProperty.call(value, 'diagnostic') || diagnostic !== undefined;
}
function isBusyReasonFor(method, value) {
    if (isAgentMethod(method))
        return isMiniAppAgentBusyReason(value);
    return value === 'capacity_busy' || value === 'operation_busy';
}
function parseBrokerErrorDiagnostic(value) {
    const fields = readDataRecord(value, ['hostCode', 'reasonCode', 'failureChain']);
    if (!fields || Object.keys(fields).length === 0 || !hasValidFailureCodes(fields))
        return undefined;
    const failureChain = [];
    if ('failureChain' in fields) {
        const entries = readDataRecord(fields.failureChain, ['length', '0', '1', '2', '3']);
        if (!entries ||
            !Array.isArray(fields.failureChain) ||
            !Number.isInteger(entries.length) ||
            Number(entries.length) < 1 ||
            Number(entries.length) > MAX_STOP_FAILURE_DEPTH)
            return undefined;
        for (let index = 0; index < Number(entries.length); index += 1) {
            const entry = parseStopFailureFrame(entries[String(index)]);
            if (!entry)
                return undefined;
            failureChain.push(entry);
        }
    }
    return Object.freeze({
        ...(fields.hostCode ? { hostCode: fields.hostCode } : {}),
        ...(fields.reasonCode ? { reasonCode: fields.reasonCode } : {}),
        ...(failureChain.length ? { failureChain: Object.freeze(failureChain) } : {}),
    });
}
function parseStopFailureFrame(value) {
    const fields = readDataRecord(value, ['errorType', 'hostCode', 'reasonCode']);
    if (!fields || !hasValidFailureCodes(fields))
        return undefined;
    const errorType = MINIAPP_STOP_ERROR_TYPES.find((type) => type === fields.errorType);
    if (!errorType)
        return undefined;
    return Object.freeze({
        errorType,
        ...(fields.hostCode ? { hostCode: fields.hostCode } : {}),
        ...(fields.reasonCode ? { reasonCode: fields.reasonCode } : {}),
    });
}
function hasValidFailureCodes(fields) {
    return ((!('hostCode' in fields) ||
        (typeof fields.hostCode === 'string' && MINIAPP_BROKER_HOST_CODE_SET.has(fields.hostCode))) &&
        (!('reasonCode' in fields) ||
            (typeof fields.reasonCode === 'string' &&
                MINIAPP_BROKER_REASON_CODE_SET.has(fields.reasonCode))));
}
function readDataRecord(value, allowed) {
    try {
        if (!value || typeof value !== 'object')
            return undefined;
        const fields = Object.create(null);
        for (const key of Reflect.ownKeys(value)) {
            if (typeof key !== 'string' || !allowed.includes(key))
                return undefined;
            const descriptor = Object.getOwnPropertyDescriptor(value, key);
            if (!descriptor || !('value' in descriptor))
                return undefined;
            fields[key] = descriptor.value;
        }
        return fields;
    }
    catch {
        return undefined;
    }
}
