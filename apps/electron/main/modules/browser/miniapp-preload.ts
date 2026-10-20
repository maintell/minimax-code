require("./preload.js");
import { ipcRenderer, contextBridge } from "electron";
import { readMiniAppAgentRunEvent, parseMiniAppAgentRunResult, MINIAPP_SURFACE_ID_ARGUMENT_PREFIX, MINIAPP_COMPOSER_MAX_TEXT_LENGTH, parseMiniAppComposerAppendResult, readMiniAppAgentRunRequest, readMiniAppAgentReplyRequest, parseMiniAppAgentReplyResult, readMiniAppAgentAnswerRequest, readMiniAppAgentOpenRequest, parseMiniAppAgentOpenResult, parseMiniAppAgentModelsResult, parseMiniAppAgentAgentsResult, readMiniAppAgentCreateRequest, parseMiniAppAgentCreateResult, parseMiniAppWindowResult, parseMiniAppWindowPatch } from "@mavis/shared/miniapp-surface";
const MINIAPP_COMPOSER_APPEND = 'miniapp:composer-append';
const MINIAPP_AGENT_RUN = 'miniapp:agent-run';
const MINIAPP_AGENT_CANCEL = 'miniapp:agent-cancel';
const MINIAPP_AGENT_EVENT = 'miniapp:agent-event';
const MINIAPP_AGENT_REPLY = 'miniapp:agent-reply';
const MINIAPP_AGENT_ANSWER = 'miniapp:agent-answer';
const MINIAPP_AGENT_OPEN = 'miniapp:agent-open';
const MINIAPP_AGENT_MODELS = 'miniapp:agent-models';
const MINIAPP_AGENT_AGENTS = 'miniapp:agent-agents';
const MINIAPP_AGENT_CREATE = 'miniapp:agent-create';
const agentRequestPrefix = Math.random().toString(36).slice(2, 10);
let agentRequestSequence = 0;
const inFlightAgentRequests = new Set();
/**
 * One turn-following request (`run` or `answer`): forwards only this request's events and
 * keeps `requestId` cancellable until Main settles it.
 */
async function invokeAgentTurn(channel, requestId, payload, options) {
    // Two turns sharing one id would also share its event stream.
    if (inFlightAgentRequests.has(requestId))
        throw new Error('busy');
    const onEvent = typeof options?.onEvent === 'function' ? options.onEvent : undefined;
    const listener = (_event, message) => {
        if (!onEvent || !message || typeof message !== 'object')
            return;
        const envelope = message;
        if (envelope.requestId !== requestId)
            return;
        const event = readMiniAppAgentRunEvent(envelope.event);
        if (!event)
            return;
        try {
            onEvent(event);
        }
        catch (error) {
            // A page callback failure must not end the run or the event stream, but its author
            // should still see it in DevTools.
            console.error('[miniapp] agent onEvent handler threw', error);
        }
    };
    inFlightAgentRequests.add(requestId);
    // Without `onEvent` Main does not subscribe the run, so the runtime does not count this
    // page as able to answer the run's asks.
    const observe = onEvent !== undefined;
    if (observe)
        ipcRenderer.on(MINIAPP_AGENT_EVENT, listener);
    let response;
    try {
        response = await ipcRenderer.invoke(channel, { requestId, ...payload, observe });
    }
    catch {
        // The turn may already have been submitted; never retry implicitly.
        throw new Error('result_unknown');
    }
    finally {
        if (observe)
            ipcRenderer.removeListener(MINIAPP_AGENT_EVENT, listener);
        inFlightAgentRequests.delete(requestId);
    }
    const result = parseMiniAppAgentRunResult(response);
    if (!result.ok)
        throw agentFailureError(result);
    return result.result;
}
/**
 * `message` is the failure code; a `busy` also carries `reason`. Note that contextBridge copies
 * only an Error's `message` into the page world (electron/electron#25596), so `reason` does not
 * reach page code through this rejection.
 */
function agentFailureError(failure) {
    const error = new Error(failure.code);
    return failure.reason ? Object.assign(error, { reason: failure.reason }) : error;
}
/**
 * One request/response call of the catalog family (`models`, `agents`, `create`). A transport
 * failure is `result_unknown`: `create` may already have applied, so nothing retries.
 */
async function invokeAgentCall(channel, payload, parse) {
    let response;
    try {
        response = await ipcRenderer.invoke(channel, payload);
    }
    catch {
        throw new Error('result_unknown');
    }
    const result = parse(response);
    if (!result.ok)
        throw agentFailureError(result);
    return result.result;
}
const MINIAPP_WINDOW_GET_STATE = 'miniapp:window-get-state';
const MINIAPP_WINDOW_UPDATE = 'miniapp:window-update';
const MINIAPP_WINDOW_FOCUS = 'miniapp:window-focus';
const WINDOW_STATE_POLL_INTERVAL_MS = 1000;
const WINDOW_UPDATE_FRAME_FALLBACK_MS = 16;
// Chromium never runs `requestAnimationFrame` for a hidden, minimized, or
// occluded page, so this timer races it: whichever fires first flushes and
// cancels the other.
const WINDOW_UPDATE_HIDDEN_FALLBACK_MS = 50;
const windowGlobal = globalThis;
if (process.isMainFrame) {
    // A packaged bundle can run in a sandbox whose `process` has no `argv` at
    // all (see `build-miniapp-preload.test.ts`); this must never throw at load.
    const argv = Array.isArray(process.argv) ? process.argv : undefined;
    const surfaceIdArgument = argv?.find((argument) => argument.startsWith(MINIAPP_SURFACE_ID_ARGUMENT_PREFIX));
    const surfaceId = surfaceIdArgument
        ? surfaceIdArgument.slice(MINIAPP_SURFACE_ID_ARGUMENT_PREFIX.length)
        : '';
    contextBridge.exposeInMainWorld('mcode', {
        miniapp: {
            message: {
                // Only an individually confirmed draft append. Sent messages are never writable here.
                async append(text) {
                    if (typeof text !== 'string') {
                        throw new Error('invalid_request');
                    }
                    if (text.length > MINIAPP_COMPOSER_MAX_TEXT_LENGTH) {
                        throw new Error('text_too_large');
                    }
                    let response;
                    try {
                        response = await ipcRenderer.invoke(MINIAPP_COMPOSER_APPEND, { text });
                    }
                    catch {
                        // An invoke failure can race with a committed append. Never retry
                        // implicitly or expose transport errors to the untrusted page.
                        throw new Error('result_unknown');
                    }
                    const result = parseMiniAppComposerAppendResult(response);
                    if (!result)
                        throw new Error('result_unknown');
                    if (!result.success)
                        throw new Error(result.code);
                },
            },
            agent: {
                // Identity is resolved by Main from this tab; the payload carries only text and session.
                async run(input, options) {
                    const request = readMiniAppAgentRunRequest({
                        text: input?.text,
                        sessionId: input?.sessionId,
                        model: input?.model,
                        agent: input?.agent,
                        requestId: input?.requestId ?? `${agentRequestPrefix}-${++agentRequestSequence}`,
                    });
                    if (!request)
                        throw new Error('invalid_request');
                    const { requestId, text, sessionId, model, agent } = request;
                    return invokeAgentTurn(MINIAPP_AGENT_RUN, requestId, {
                        text,
                        ...(sessionId !== undefined ? { sessionId } : {}),
                        ...(model ? { model } : {}),
                        ...(agent !== undefined ? { agent } : {}),
                    }, options);
                },
                // AbortSignal cannot cross contextBridge, so cancellation is an explicit id-based call.
                cancel(requestId) {
                    if (!inFlightAgentRequests.has(requestId))
                        return;
                    ipcRenderer.send(MINIAPP_AGENT_CANCEL, { requestId });
                },
                async reply(input) {
                    const request = readMiniAppAgentReplyRequest(input);
                    if (!request)
                        throw new Error('invalid_request');
                    let response;
                    try {
                        response = await ipcRenderer.invoke(MINIAPP_AGENT_REPLY, request);
                    }
                    catch {
                        // The decision may already have been applied; never retry implicitly.
                        throw new Error('result_unknown');
                    }
                    const result = parseMiniAppAgentReplyResult(response);
                    if (!result.ok)
                        throw new Error(result.code);
                },
                async answer(input, options) {
                    const request = readMiniAppAgentAnswerRequest({
                        sessionId: input?.sessionId,
                        questionId: input?.questionId,
                        answers: input?.answers,
                        model: input?.model,
                        requestId: input?.requestId ?? `${agentRequestPrefix}-${++agentRequestSequence}`,
                    });
                    if (!request)
                        throw new Error('invalid_request');
                    const { requestId, sessionId, questionId, answers, model } = request;
                    return invokeAgentTurn(MINIAPP_AGENT_ANSWER, requestId, { sessionId, questionId, answers, ...(model ? { model } : {}) }, options);
                },
                // Shows one of this plugin's own sessions in the host chat's side panel.
                async open(sessionId) {
                    const request = readMiniAppAgentOpenRequest({ sessionId });
                    if (!request)
                        throw new Error('invalid_request');
                    let response;
                    try {
                        response = await ipcRenderer.invoke(MINIAPP_AGENT_OPEN, request);
                    }
                    catch {
                        throw new Error('result_unknown');
                    }
                    const result = parseMiniAppAgentOpenResult(response);
                    if (!result.ok)
                        throw new Error(result.code);
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
                    if (!request)
                        throw new Error('invalid_request');
                    return invokeAgentCall(MINIAPP_AGENT_CREATE, request, parseMiniAppAgentCreateResult);
                },
            },
            window: createMiniAppWindowHandle(surfaceId),
        },
    });
}
/**
 * `window.mcode.miniapp.window` (proposed — see
 * `.harness/docs/specs/miniapp-runtime.md`, Requirement 页面侧窗口句柄).
 * `surfaceId` is read once from `process.argv` at preload load; when the Host
 * did not pass one, the namespace is still exposed but every method rejects
 * with `result_unknown` instead of reaching IPC.
 */
function createMiniAppWindowHandle(surfaceId) {
    let pendingFrame = null;
    /** Cancels whichever flush triggers are armed for `pendingFrame`. */
    let cancelScheduledFlush = null;
    const listeners = new Set();
    let pollHandle = null;
    // `null` means "no baseline yet". `onDidChangeState` establishes it right
    // away for its first subscriber (see below); the poll's own fallback only
    // covers that initial attempt failing (surface id missing, IPC not ready).
    let lastDeliveredJson = null;
    function hasActiveGesture() {
        return windowGlobal.navigator?.userActivation?.isActive === true;
    }
    /**
     * Coalesces same-frame `update()` calls. A hidden/minimized/occluded page
     * never runs `requestAnimationFrame`, so a `setTimeout` races it: whichever
     * fires first flushes and cancels the other. Falls back to a bare
     * `setTimeout(16)` when `requestAnimationFrame` itself is unavailable
     * (this test harness, or an unusual embedder).
     */
    function scheduleFlush() {
        const raf = windowGlobal.requestAnimationFrame;
        if (typeof raf !== 'function') {
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
    /** Sends the merged, non-`mode` patch queued for the current frame, if any. */
    function flushPendingFrame() {
        if (!pendingFrame)
            return;
        cancelScheduledFlush?.();
        cancelScheduledFlush = null;
        const { patch, waiters, userActivated } = pendingFrame;
        pendingFrame = null;
        dispatchUpdate(patch, userActivated).then((state) => waiters.forEach((waiter) => waiter.resolve(state)), (error) => waiters.forEach((waiter) => waiter.reject(error)));
    }
    function deliverStateChange(state) {
        lastDeliveredJson = JSON.stringify(state);
        for (const listener of listeners) {
            try {
                listener(state);
            }
            catch {
                // A listener that throws must never fail update() or break polling.
            }
        }
    }
    /**
     * One window-handle round trip. Transport failures and malformed replies
     * surface only as `result_unknown`; a Host failure surfaces as its code.
     */
    async function invokeWindowIpc(channel, ...args) {
        let response;
        try {
            response = await ipcRenderer.invoke(channel, ...args);
        }
        catch {
            throw new Error('result_unknown');
        }
        const parsed = parseMiniAppWindowResult(response);
        if (!parsed)
            throw new Error('result_unknown');
        if (!parsed.success)
            throw new Error(parsed.code);
        return parsed.state;
    }
    async function dispatchUpdate(patch, userActivated) {
        const state = await invokeWindowIpc(MINIAPP_WINDOW_UPDATE, { patch, userActivated });
        deliverStateChange(state);
        return state;
    }
    function stopPolling() {
        if (pollHandle === null)
            return;
        clearInterval(pollHandle);
        pollHandle = null;
    }
    function ensurePolling() {
        if (pollHandle !== null)
            return;
        pollHandle = setInterval(() => {
            getState().then((state) => {
                const json = JSON.stringify(state);
                if (lastDeliveredJson === null) {
                    // First observation since the baseline was cleared: record it
                    // silently so an unrelated pre-subscribe change never fires.
                    lastDeliveredJson = json;
                    return;
                }
                if (json !== lastDeliveredJson)
                    deliverStateChange(state);
            }, () => {
                // A transient poll failure must not tear down the subscription or
                // surface an unhandled rejection to the page.
            });
        }, WINDOW_STATE_POLL_INTERVAL_MS);
    }
    async function getState() {
        if (!surfaceId)
            throw new Error('result_unknown');
        return invokeWindowIpc(MINIAPP_WINDOW_GET_STATE);
    }
    async function update(patch) {
        if (!surfaceId)
            throw new Error('result_unknown');
        const parsed = parseMiniAppWindowPatch(patch);
        if (!parsed.ok)
            throw new Error(parsed.code);
        const validated = parsed.patch;
        const activated = hasActiveGesture();
        if (validated.mode !== undefined) {
            // A mode switch never waits for the next frame: coalescing it away
            // could lose the user-gesture window the Host requires to show a window.
            if (!activated)
                throw new Error('not_permitted');
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
        if (!surfaceId)
            throw new Error('result_unknown');
        if (!hasActiveGesture())
            throw new Error('not_permitted');
        await invokeWindowIpc(MINIAPP_WINDOW_FOCUS, { userActivated: true });
    }
    function onDidChangeState(listener) {
        if (typeof listener !== 'function')
            throw new Error('invalid_request');
        const isFirstSubscriber = listeners.size === 0;
        listeners.add(listener);
        if (isFirstSubscriber) {
            // Establish the baseline right away, not at the first poll tick: a
            // change in that gap must still be detected on the next tick, not
            // folded silently into the baseline as if it predated this subscribe.
            getState().then((state) => {
                lastDeliveredJson = JSON.stringify(state);
            }, () => {
                // Leave it null; the poll's own fallback below establishes it instead.
            });
        }
        ensurePolling();
        return {
            dispose() {
                if (listeners.delete(listener) && listeners.size === 0) {
                    stopPolling();
                    // A later re-subscribe must not replay a change that happened
                    // while nobody was listening; it takes its own fresh baseline.
                    lastDeliveredJson = null;
                }
            },
        };
    }
    // The page is going away; do not keep polling a torn-down subscription.
    windowGlobal.addEventListener?.('pagehide', () => {
        stopPolling();
        listeners.clear();
    });
    return { id: surfaceId, getState, update, focus, onDidChangeState };
}
