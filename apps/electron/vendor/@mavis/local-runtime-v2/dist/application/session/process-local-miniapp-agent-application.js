function toGatewayCaller(caller) {
    return {
        pluginId: caller.pluginId,
        processGeneration: caller.runId,
        source: 'page',
        ...(caller.hostSessionId !== undefined ? { hostSessionId: caller.hostSessionId } : {}),
    };
}
/** Page-path entry: the Electron bridge supplies the trusted tab identity, the gateway enforces policy. */
export function createProcessLocalMiniAppAgentApplication(gateway) {
    return {
        run: ({ caller, text, sessionId, agent, model, whenBusy, signal, onEvent }) => gateway.run(toGatewayCaller(caller), {
            text,
            ...(sessionId !== undefined ? { sessionId } : {}),
            ...(agent !== undefined ? { agent } : {}),
            ...(model !== undefined ? { model } : {}),
            ...(whenBusy !== undefined ? { whenBusy } : {}),
        }, { ...(signal ? { signal } : {}), ...(onEvent ? { onEvent } : {}) }),
        models: ({ caller }) => gateway.models(toGatewayCaller(caller)),
        agents: ({ caller }) => gateway.agents(toGatewayCaller(caller)),
        create: ({ caller, agent }) => gateway.create(toGatewayCaller(caller), agent === undefined ? undefined : { agent }),
        reply: ({ caller, sessionId, requestId, decision }) => gateway.reply(toGatewayCaller(caller), { sessionId, requestId, decision }),
        answer: ({ caller, sessionId, requestId, answers, model, signal, onEvent }) => gateway.answer(toGatewayCaller(caller), { sessionId, requestId, answers, ...(model !== undefined ? { model } : {}) }, { ...(signal ? { signal } : {}), ...(onEvent ? { onEvent } : {}) }),
        open: ({ caller, sessionId }) => gateway.open(toGatewayCaller(caller), { sessionId }),
        panelOpened: async ({ sessionId, hostSessionId }) => gateway.panelOpened({ sessionId, hostSessionId }),
        panelClosed: async ({ sessionId, hostSessionId }) => gateway.panelClosed({ sessionId, hostSessionId }),
        observe: ({ caller, target, signal, onEvent }) => gateway.observe(toGatewayCaller(caller), target, { ...(signal ? { signal } : {}), onEvent }),
        sessions: ({ caller }) => gateway.sessions(toGatewayCaller(caller)),
        session: ({ caller, sessionId }) => gateway.session(toGatewayCaller(caller), sessionId === undefined ? undefined : { sessionId }),
    };
}
//# sourceMappingURL=process-local-miniapp-agent-application.js.map