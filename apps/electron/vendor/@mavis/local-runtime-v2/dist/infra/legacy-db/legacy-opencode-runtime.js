import { LegacyOpencodeStore } from './legacy-opencode-store.js';
/** Historical data access. Execution requests are permanently disabled. */
export class LegacyOpencodeRuntime {
    available;
    telemetry;
    store;
    constructor(options) {
        this.available = options.available ?? true;
        this.telemetry = options.telemetry;
        this.store = options.store ?? new LegacyOpencodeStore({ dataDir: options.dataDir });
    }
    isEnabled() {
        return false;
    }
    async getSession(sessionId) {
        if (!this.available)
            return undefined;
        return this.store.getSession(sessionId);
    }
    async listSessions(agentName) {
        if (!this.available)
            return [];
        return this.store.listSessions(agentName);
    }
    async listMessages(sessionId, limit) {
        if (!this.available)
            return [];
        return this.store.listMessages(sessionId, limit);
    }
    async openMessageStream(_request, session) {
        return this.disabledStream(session);
    }
    async openResumeStream(_request, session) {
        return this.disabledStream(session);
    }
    async proxySessionJsonRequest(_request, session, _operation) {
        this.reportDisabled(session);
        return legacyJson({ error: `Legacy opencode runtime is disabled for session ${session.sessionId}.` }, { status: 403 });
    }
    async proxyDaemonApiRequest(_request, apiPath) {
        const normalizedPath = apiPath.startsWith('/') ? apiPath : `/${apiPath}`;
        const path = normalizedPath === '/api' || normalizedPath.startsWith('/api/')
            ? normalizedPath
            : `/api${normalizedPath}`;
        return legacyJson({ error: `Legacy daemon API is disabled: ${path}`, code: 'LEGACY_DAEMON_DISABLED' }, { status: 403 });
    }
    disabledStream(session) {
        this.reportDisabled(session);
        const error = `Legacy opencode runtime is disabled for session ${session.sessionId}.`;
        return new Response(`data: ${JSON.stringify({ type: 'error', error })}\n\ndata: [DONE]\n\n`, {
            headers: {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                Connection: 'keep-alive',
            },
        });
    }
    reportDisabled(session) {
        this.telemetry?.({
            runtime: 'opencode',
            sessionId: session.sessionId,
            phase: 'disabled',
            message: 'legacy_opencode_disabled',
        });
    }
}
/** @internal Exported only for focused tests. */
export function legacyJson(data, init) {
    return new Response(JSON.stringify(data), {
        status: init?.status ?? 200,
        statusText: init?.statusText,
        headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    });
}
//# sourceMappingURL=legacy-opencode-runtime.js.map