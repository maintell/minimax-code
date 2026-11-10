import { randomUUID } from "node:crypto";
import { ipcMain } from "electron";
import { isMiniAppAgentBusyReason, readMiniAppAgentOpenSessionReply, readMiniAppAgentRunRequest, readMiniAppAgentAnswerRequest, readMiniAppAgentReplyRequest, readMiniAppAgentObserveRequest, readMiniAppAgentSessionRequest, readMiniAppAgentOpenRequest, readMiniAppAgentOpenSessionRequest, isMiniAppAgentRequestId } from "@mavis/shared/miniapp-surface";
import { IPC_CHANNELS } from "../config/constants.js";
import { getEmbeddedBrowserManager } from "../modules/browser/embedded-browser-manager.js";
import { panelClosedUtilityMiniAppAgent, runUtilityMiniAppAgent, answerUtilityMiniAppAgent, replyUtilityMiniAppAgent, observeUtilityMiniAppAgent, listUtilityMiniAppAgentSessions, getUtilityMiniAppAgentSession, openUtilityMiniAppAgent, panelOpenedUtilityMiniAppAgent } from "../modules/local-runtime/utility";
import { getCategoryLogger } from "../utils/logger";
import { setupMiniAppAgentCatalogIPC } from "./miniAppAgentCatalog.ipc.js";
import { toFailureCode, failure, captureTabCaller } from "./miniAppAgentIpcSupport.js";
import { trustedHost } from "./miniAppComposer.ipc.js";
/** How long Main waits for the Host renderer to report whether it showed the session tab. */
const OPEN_SESSION_REPLY_TIMEOUT_MS = 10000;
/** A `busy` keeps the runtime's reason (carried by the broker error as `busyReason`). */
function toFailure(error, context) {
    const code = toFailureCode(error, context);
    if (code !== 'busy' || !error || typeof error !== 'object')
        return failure(code);
    const reason = error.busyReason;
    return failure(code, isMiniAppAgentBusyReason(reason) ? reason : undefined);
}
/**
 * Main -> Host renderer request/reply for `agent.open` (mirrors the composer channel): the
 * Host preload answers every request with the same `requestId`. Resolves `null` when the Host
 * cannot answer: no reply within the bound, the Host document ended, or the send failed.
 */
function createOpenSessionRequests(manager) {
    const pending = new Map();
    return {
        request(owner, opened) {
            return new Promise((resolve) => {
                const requestId = randomUUID();
                let stopWatching = () => { };
                const settle = (result) => {
                    if (pending.get(requestId) !== entry)
                        return;
                    pending.delete(requestId);
                    clearTimeout(timeout);
                    stopWatching();
                    resolve(result);
                };
                const entry = { owner, settle };
                const timeout = setTimeout(() => settle(null), OPEN_SESSION_REPLY_TIMEOUT_MS);
                pending.set(requestId, entry);
                stopWatching = manager.observeHostDocumentEnd(owner, () => settle(null));
                try {
                    owner.send(IPC_CHANNELS.MINIAPP_AGENT_OPEN_SESSION, {
                        requestId,
                        hostSessionId: opened.hostSessionId,
                        sessionId: opened.sessionId,
                    });
                }
                catch {
                    settle(null);
                }
            });
        },
        /** The caller verified the Host frame; the reply must also come from the requested Host. */
        reply(sender, value) {
            const reply = readMiniAppAgentOpenSessionReply(value);
            const requestId = reply?.requestId ?? value?.requestId;
            if (typeof requestId !== 'string')
                return;
            const entry = pending.get(requestId);
            if (!entry || entry.owner !== sender)
                return;
            entry.settle(reply?.result ?? { ok: false, code: 'result_unknown' });
        },
        dispose() {
            for (const entry of [...pending.values()])
                entry.settle(null);
        },
    };
}
function toOpenFailure(result) {
    if (!result || (!result.ok && result.code === 'target_unavailable')) {
        return 'runtime_unavailable';
    }
    return 'result_unknown';
}
/** Forwards a Host "panel closed" to the runtime; failures are logged, nothing waits on them. */
function reportPanelClosed(request) {
    void panelClosedUtilityMiniAppAgent({
        sessionId: request.sessionId,
        hostSessionId: request.hostSessionId,
    }).catch((error) => {
        const code = error?.code;
        getCategoryLogger('main').warn('miniapp_agent_panel_closed_failed', {
            sessionId: request.sessionId,
            hostSessionId: request.hostSessionId,
            errorName: error instanceof Error ? error.name : typeof error,
            ...(typeof code === 'string' ? { code } : {}),
        });
    });
}
/**
 * Panels the Host confirmed open, per Host document. The renderer's tab store is not persisted,
 * so when the Host document ends (reload, navigation, crash, close) every panel it reported is
 * gone; report them closed so the runtime stops waiting on a tab nobody can see.
 */
function createPanelRegistry(manager) {
    const byOwner = new Map();
    const key = (request) => `${request.hostSessionId}\n${request.sessionId}`;
    const forget = (owner) => {
        byOwner.get(owner)?.stop();
        byOwner.delete(owner);
    };
    return {
        opened(owner, request) {
            let record = byOwner.get(owner);
            if (!record) {
                const panels = new Map();
                const stop = manager.observeHostDocumentEnd(owner, () => {
                    byOwner.delete(owner);
                    for (const panel of panels.values())
                        reportPanelClosed(panel);
                });
                record = { panels, stop };
                byOwner.set(owner, record);
            }
            record.panels.set(key(request), request);
        },
        closed(owner, request) {
            const record = byOwner.get(owner);
            if (!record)
                return;
            record.panels.delete(key(request));
            if (record.panels.size === 0)
                forget(owner);
        },
        has(owner, request) {
            return byOwner.get(owner)?.panels.has(key(request)) === true;
        },
        dispose() {
            for (const owner of [...byOwner.keys()])
                forget(owner);
        },
    };
}
export function setupMiniAppAgentIPC() {
    const manager = getEmbeddedBrowserManager();
    const pages = new Map();
    const openSessions = createOpenSessionRequests(manager);
    const panels = createPanelRegistry(manager);
    const disposeCatalog = setupMiniAppAgentCatalogIPC();
    const endPage = (page) => {
        const runs = pages.get(page);
        if (!runs)
            return;
        pages.delete(page);
        runs.ended = true;
        runs.dispose();
        for (const controller of runs.controllers.values())
            controller.abort();
    };
    const release = (page, requestId, controller) => {
        const runs = pages.get(page);
        if (!runs || runs.controllers.get(requestId) !== controller)
            return;
        runs.controllers.delete(requestId);
        if (runs.controllers.size > 0)
            return;
        pages.delete(page);
        runs.dispose();
    };
    const captureCaller = (event) => captureTabCaller(manager, event);
    /**
     * A subscribed request ends on its event channel: the settlement rides `MINIAPP_AGENT_EVENT`
     * after the request's last event, so the page reads the stream in order. The invoke reply
     * carries the same response, but Electron may deliver it before earlier `send`s.
     */
    const settleOnStream = (page, requestId, settled) => {
        if (page.isDestroyed())
            return;
        try {
            page.send(IPC_CHANNELS.MINIAPP_AGENT_EVENT, { requestId, settled });
        }
        catch {
            // The page can disappear between the check and delivery.
        }
    };
    /** A request the preload could not even parse still ends its stream, when it subscribed. */
    const settleUnparsed = (event, value, subscribed, response) => {
        if (value && typeof value === 'object' && !Array.isArray(value)) {
            const raw = value;
            if (typeof raw.requestId === 'string' && raw.requestId && subscribed(raw)) {
                settleOnStream(event.sender, raw.requestId, response);
            }
        }
        return response;
    };
    /**
     * A streaming request of this page: its `requestId` (page-chosen, or generated by the preload)
     * keys its events and `cancel`, and the page ending aborts it. A failure settles with whatever
     * `settleFailure` maps it to. A `subscribed` request settles on its event channel first.
     */
    const followPageRequest = async (event, request, start, settleFailure) => {
        const { requestId, subscribed } = request;
        const page = event.sender;
        const settle = (response) => {
            if (subscribed)
                settleOnStream(page, requestId, response);
            return response;
        };
        const caller = captureCaller(event);
        if (!caller)
            return settle(failure('not_permitted'));
        let runs = pages.get(page);
        if (runs?.controllers.has(requestId))
            return settle(failure('busy'));
        if (!runs) {
            runs = {
                controllers: new Map(),
                dispose: manager.observeMiniAppPageEnd(page, () => endPage(page)),
                ended: false,
            };
            pages.set(page, runs);
        }
        const controller = new AbortController();
        runs.controllers.set(requestId, controller);
        const pageRuns = runs;
        const onEvent = (agentEvent) => {
            // A page-initiated cancel still receives the turn's terminal event (`turn.finished`
            // is promised last); only a page that ended stops receiving events.
            if (pageRuns.ended || page.isDestroyed())
                return;
            try {
                page.send(IPC_CHANNELS.MINIAPP_AGENT_EVENT, { requestId, event: agentEvent });
            }
            catch {
                // The page can disappear between the check and delivery.
            }
        };
        let response;
        try {
            response = await start(caller, controller.signal, onEvent);
        }
        catch (error) {
            response = settleFailure(error, caller, controller.signal);
        }
        finally {
            release(page, requestId, controller);
        }
        return settle(response);
    };
    /**
     * `run` and `answer` follow a turn. Events are subscribed only when the page passed
     * `onEvent` (`observe`), since the runtime counts a subscribed run as able to answer asks.
     */
    const followTurn = async (event, turn, observe, start) => followPageRequest(event, { ...turn, subscribed: observe }, async (caller, signal, onEvent) => ({
        ok: true,
        result: await start(caller, { signal, ...(observe ? { onEvent } : {}) }),
    }), (error, caller) => toFailure(error, { pluginId: caller.pluginId, method: turn.method }));
    const subscribedTurn = (raw) => raw.observe === true;
    ipcMain.handle(IPC_CHANNELS.MINIAPP_AGENT_RUN, async (event, value) => {
        const request = readMiniAppAgentRunRequest(value);
        if (!request)
            return settleUnparsed(event, value, subscribedTurn, failure('invalid_request'));
        const { requestId, observe, ...turn } = request;
        return followTurn(event, { method: 'agent.run', requestId }, observe, (caller, options) => runUtilityMiniAppAgent({ caller, ...turn }, options));
    });
    ipcMain.handle(IPC_CHANNELS.MINIAPP_AGENT_ANSWER, async (event, value) => {
        const request = readMiniAppAgentAnswerRequest(value);
        if (!request)
            return settleUnparsed(event, value, subscribedTurn, failure('invalid_request'));
        const { requestId, observe, ...answer } = request;
        return followTurn(event, { method: 'agent.answer', requestId }, observe, (caller, options) => answerUtilityMiniAppAgent({ caller, ...answer }, options));
    });
    ipcMain.handle(IPC_CHANNELS.MINIAPP_AGENT_REPLY, async (event, value) => {
        const request = readMiniAppAgentReplyRequest(value);
        if (!request)
            return failure('invalid_request');
        const caller = captureCaller(event);
        if (!caller)
            return failure('not_permitted');
        try {
            await replyUtilityMiniAppAgent({ caller, ...request });
            return { ok: true };
        }
        catch (error) {
            return failure(toFailureCode(error, { pluginId: caller.pluginId, method: 'agent.reply' }));
        }
    });
    // An observer ends normally when the page cancels it or the runtime ends it; the page
    // ending aborts it like a run.
    ipcMain.handle(IPC_CHANNELS.MINIAPP_AGENT_OBSERVE, async (event, value) => {
        const request = readMiniAppAgentObserveRequest(value);
        if (!request)
            return settleUnparsed(event, value, () => true, failure('invalid_request'));
        const { requestId, ...target } = request;
        return followPageRequest(event, { method: 'agent.observe', requestId, subscribed: true }, async (caller, signal, onEvent) => {
            await observeUtilityMiniAppAgent({ caller, target }, { signal, onEvent });
            return { ok: true };
        }, (error, caller, signal) => signal.aborted
            ? { ok: true }
            : toFailure(error, { pluginId: caller.pluginId, method: 'agent.observe' }));
    });
    ipcMain.handle(IPC_CHANNELS.MINIAPP_AGENT_SESSIONS, async (event) => {
        const caller = captureCaller(event);
        if (!caller)
            return failure('not_permitted');
        try {
            const { sessions } = await listUtilityMiniAppAgentSessions({ caller });
            return { ok: true, sessions };
        }
        catch (error) {
            return toFailure(error, { pluginId: caller.pluginId, method: 'agent.sessions' });
        }
    });
    ipcMain.handle(IPC_CHANNELS.MINIAPP_AGENT_SESSION, async (event, value) => {
        const request = readMiniAppAgentSessionRequest(value);
        if (!request)
            return failure('invalid_request');
        const caller = captureCaller(event);
        if (!caller)
            return failure('not_permitted');
        try {
            const session = await getUtilityMiniAppAgentSession({ caller, ...request });
            return session ? { ok: true, session } : { ok: true };
        }
        catch (error) {
            return toFailure(error, { pluginId: caller.pluginId, method: 'agent.session' });
        }
    });
    // The runtime confirms the session is this plugin's (whichever chat it was started from);
    // the Host renderer then shows it in its chat side panel and reports back. Only a shown tab
    // is reported to the runtime as a panel that can answer the session's asks.
    ipcMain.handle(IPC_CHANNELS.MINIAPP_AGENT_OPEN, async (event, value) => {
        const request = readMiniAppAgentOpenRequest(value);
        if (!request)
            return failure('invalid_request');
        const source = manager.captureMiniAppComposerSource(event.sender, event.senderFrame);
        if (!source?.sessionId)
            return failure('not_permitted');
        const caller = {
            pluginId: source.pluginId,
            runId: source.runId,
            hostSessionId: source.sessionId,
        };
        let opened;
        try {
            opened = await openUtilityMiniAppAgent({ caller, sessionId: request.sessionId });
        }
        catch (error) {
            return failure(toFailureCode(error, { pluginId: caller.pluginId, method: 'agent.open' }));
        }
        const owner = source.ownerWebContents;
        if (!owner || owner.isDestroyed())
            return failure('runtime_unavailable');
        const shown = await openSessions.request(owner, opened);
        if (!shown?.ok)
            return failure(toOpenFailure(shown));
        // Register first so the document watch covers the runtime call; if the Host document
        // ends meanwhile, the registry reports the panel closed and the entry disappears.
        panels.opened(owner, opened);
        try {
            await panelOpenedUtilityMiniAppAgent({
                sessionId: opened.sessionId,
                hostSessionId: opened.hostSessionId,
            });
        }
        catch {
            // The tab is shown but the runtime may not know a panel can answer its asks.
            return failure('result_unknown');
        }
        if (!panels.has(owner, opened)) {
            // The Host document ended while the runtime was recording the panel. The registry's
            // own report may have been skipped if the runtime was not ready then; it is ready now.
            reportPanelClosed(opened);
            return failure('runtime_unavailable');
        }
        return { ok: true };
    });
    const openSessionReply = (event, value) => {
        if (trustedHost(event))
            openSessions.reply(event.sender, value);
    };
    ipcMain.on(IPC_CHANNELS.MINIAPP_AGENT_OPEN_SESSION_REPLY, openSessionReply);
    const panelClosed = (event, value) => {
        if (!trustedHost(event))
            return;
        const request = readMiniAppAgentOpenSessionRequest(value);
        if (!request)
            return;
        panels.closed(event.sender, request);
        reportPanelClosed(request);
    };
    ipcMain.on(IPC_CHANNELS.MINIAPP_AGENT_PANEL_CLOSED, panelClosed);
    const cancel = (event, value) => {
        if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame)
            return;
        const requestId = value?.requestId;
        if (!isMiniAppAgentRequestId(requestId))
            return;
        pages.get(event.sender)?.controllers.get(requestId)?.abort();
    };
    ipcMain.on(IPC_CHANNELS.MINIAPP_AGENT_CANCEL, cancel);
    return () => {
        ipcMain.removeHandler(IPC_CHANNELS.MINIAPP_AGENT_RUN);
        ipcMain.removeHandler(IPC_CHANNELS.MINIAPP_AGENT_ANSWER);
        ipcMain.removeHandler(IPC_CHANNELS.MINIAPP_AGENT_REPLY);
        ipcMain.removeHandler(IPC_CHANNELS.MINIAPP_AGENT_OPEN);
        ipcMain.removeHandler(IPC_CHANNELS.MINIAPP_AGENT_OBSERVE);
        ipcMain.removeHandler(IPC_CHANNELS.MINIAPP_AGENT_SESSIONS);
        ipcMain.removeHandler(IPC_CHANNELS.MINIAPP_AGENT_SESSION);
        ipcMain.removeListener(IPC_CHANNELS.MINIAPP_AGENT_CANCEL, cancel);
        ipcMain.removeListener(IPC_CHANNELS.MINIAPP_AGENT_OPEN_SESSION_REPLY, openSessionReply);
        ipcMain.removeListener(IPC_CHANNELS.MINIAPP_AGENT_PANEL_CLOSED, panelClosed);
        disposeCatalog();
        openSessions.dispose();
        panels.dispose();
        for (const page of [...pages.keys()])
            endPage(page);
    };
}
