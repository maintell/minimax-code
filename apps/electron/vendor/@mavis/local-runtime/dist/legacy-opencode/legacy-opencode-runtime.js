import fs from 'node:fs';
import path from 'node:path';
import { LegacyOpencodeStore } from './legacy-opencode-store.js';
const JSON_HEADERS = { 'Content-Type': 'application/json' };
const SSE_HEADERS = {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
};
export class LegacyOpencodeRuntime {
    dataDir;
    enabled;
    available;
    explicitBaseUrl;
    ensureBaseUrl;
    fetchImpl;
    telemetry;
    store;
    constructor(options) {
        this.dataDir = options.dataDir;
        this.enabled = options.enabled ?? readLegacyOpencodeEnabled();
        this.available = options.available ?? true;
        this.explicitBaseUrl = options.baseUrl;
        this.ensureBaseUrl = options.ensureBaseUrl;
        this.fetchImpl = options.fetchImpl ?? fetch;
        this.telemetry = options.telemetry;
        this.store = options.store ?? new LegacyOpencodeStore({ dataDir: options.dataDir });
    }
    isEnabled() {
        return this.enabled && this.available;
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
    async openMessageStream(request, session) {
        return this.proxyStreamRequest(request, session, 'message');
    }
    async openResumeStream(request, session) {
        return this.proxyStreamRequest(request, session, 'resume');
    }
    async proxySessionJsonRequest(request, session, operation) {
        if (!this.enabled) {
            this.telemetry?.({
                runtime: 'opencode',
                sessionId: session.sessionId,
                phase: 'disabled',
                message: 'legacy_opencode_disabled',
            });
            return legacyJson({ error: `Legacy opencode runtime is disabled for session ${session.sessionId}.` }, { status: 403 });
        }
        const baseUrl = await this.resolveBaseUrl();
        if (!baseUrl) {
            this.telemetry?.({
                runtime: 'opencode',
                sessionId: session.sessionId,
                phase: 'failure',
                message: 'legacy_opencode_runtime_unavailable',
            });
            return legacyJson({
                error: 'Legacy opencode runtime is unavailable. Start the legacy daemon or disable the legacy flag.',
            }, { status: 503 });
        }
        this.telemetry?.({
            runtime: 'opencode',
            sessionId: session.sessionId,
            phase: 'start',
        });
        try {
            const suffix = operation ? `/${operation}` : '';
            const response = await this.fetchImpl(`${baseUrl}/api/session/${encodeURIComponent(session.sessionId)}${suffix}`, toProxyInit(request));
            this.telemetry?.({
                runtime: 'opencode',
                sessionId: session.sessionId,
                phase: response.ok ? 'success' : 'failure',
                message: response.ok ? undefined : `http_${response.status}`,
            });
            return response;
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.telemetry?.({
                runtime: 'opencode',
                sessionId: session.sessionId,
                phase: 'failure',
                message,
            });
            return legacyJson({ error: `Legacy opencode runtime failed: ${message}` }, { status: 502 });
        }
    }
    async proxyDaemonApiRequest(request, apiPath) {
        if (!this.enabled) {
            return legacyJson({
                error: `Legacy daemon API is disabled: ${normalizeDaemonApiPath(apiPath)}`,
                code: 'LEGACY_DAEMON_DISABLED',
            }, { status: 403 });
        }
        const baseUrl = await this.resolveBaseUrl();
        if (!baseUrl) {
            return legacyJson({
                error: 'Legacy opencode runtime is unavailable. Start the legacy daemon or disable the legacy flag.',
                code: 'LEGACY_DAEMON_UNAVAILABLE',
            }, { status: 503 });
        }
        try {
            return await this.fetchImpl(`${baseUrl}${normalizeDaemonApiPath(apiPath)}`, toProxyInit(request));
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return legacyJson({ error: `Legacy opencode runtime failed: ${message}` }, { status: 502 });
        }
    }
    async proxyStreamRequest(request, session, operation) {
        if (!this.enabled) {
            this.telemetry?.({
                runtime: 'opencode',
                sessionId: session.sessionId,
                phase: 'disabled',
                message: 'legacy_opencode_disabled',
            });
            return legacyErrorStream(`Legacy opencode runtime is disabled for session ${session.sessionId}.`);
        }
        const baseUrl = await this.resolveBaseUrl();
        if (!baseUrl) {
            this.telemetry?.({
                runtime: 'opencode',
                sessionId: session.sessionId,
                phase: 'failure',
                message: 'legacy_opencode_runtime_unavailable',
            });
            return legacyErrorStream('Legacy opencode runtime is unavailable. Start the legacy daemon or disable the legacy flag.');
        }
        this.telemetry?.({
            runtime: 'opencode',
            sessionId: session.sessionId,
            phase: 'start',
        });
        try {
            const response = await this.fetchImpl(`${baseUrl}/api/session/${encodeURIComponent(session.sessionId)}/${operation}`, toProxyInit(request));
            this.telemetry?.({
                runtime: 'opencode',
                sessionId: session.sessionId,
                phase: response.ok ? 'success' : 'failure',
                message: response.ok ? undefined : `http_${response.status}`,
            });
            if (!response.ok) {
                const text = await response.text().catch(() => '');
                return legacyErrorStream(text || `Legacy opencode runtime returned HTTP ${response.status}.`);
            }
            return response;
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.telemetry?.({
                runtime: 'opencode',
                sessionId: session.sessionId,
                phase: 'failure',
                message,
            });
            return legacyErrorStream(`Legacy opencode runtime failed: ${message}`);
        }
    }
    async resolveBaseUrl() {
        const explicit = this.explicitBaseUrl ?? process.env.MAVIS_LEGACY_OPENCODE_BASE_URL?.trim();
        if (explicit)
            return normalizeMavisBaseUrl(explicit);
        const existing = await this.resolveExistingDaemonBaseUrl();
        if (existing)
            return existing;
        const ensured = await this.ensureBaseUrl?.();
        if (!ensured)
            return undefined;
        const ensuredBaseUrl = normalizeMavisBaseUrl(ensured);
        return (await isHealthy(this.fetchImpl, ensuredBaseUrl)) ? ensuredBaseUrl : undefined;
    }
    async resolveExistingDaemonBaseUrl() {
        if (!isPidAliveIfPresent(path.join(this.dataDir, 'daemon.pid')))
            return undefined;
        const port = readPortFile(path.join(this.dataDir, 'daemon.port'));
        if (!port)
            return undefined;
        const baseUrl = `http://127.0.0.1:${port}/mavis`;
        return (await isHealthy(this.fetchImpl, baseUrl)) ? baseUrl : undefined;
    }
}
function readLegacyOpencodeEnabled() {
    const raw = process.env.MAVIS_LEGACY_OPENCODE_ENABLED ??
        process.env.legacyOpencodeEnabled ??
        process.env.LEGACY_OPENCODE_ENABLED;
    return raw !== '0' && raw !== 'false';
}
function normalizeMavisBaseUrl(input) {
    const trimmed = input.replace(/\/$/, '');
    return trimmed.endsWith('/mavis') ? trimmed : `${trimmed}/mavis`;
}
function normalizeDaemonApiPath(apiPath) {
    const normalizedPath = apiPath.startsWith('/') ? apiPath : `/${apiPath}`;
    if (normalizedPath === '/api' || normalizedPath.startsWith('/api/'))
        return normalizedPath;
    return `/api${normalizedPath}`;
}
function readPortFile(portFile) {
    try {
        const raw = fs.readFileSync(portFile, 'utf-8').trim();
        const port = Number(raw);
        return Number.isInteger(port) && port > 0 ? port : undefined;
    }
    catch {
        return undefined;
    }
}
function isPidAliveIfPresent(pidFile) {
    let raw;
    try {
        raw = fs.readFileSync(pidFile, 'utf-8').trim();
    }
    catch {
        return true;
    }
    const pid = parsePid(raw);
    if (!pid)
        return false;
    try {
        process.kill(pid, 0);
        return true;
    }
    catch {
        return false;
    }
}
function parsePid(raw) {
    try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
            const pid = parsed.pid;
            const value = typeof pid === 'number' ? pid : Number.parseInt(String(pid), 10);
            return Number.isInteger(value) && value > 0 ? value : undefined;
        }
    }
    catch {
        // Plain pid file.
    }
    const value = Number.parseInt(raw, 10);
    return Number.isInteger(value) && value > 0 ? value : undefined;
}
async function isHealthy(fetchImpl, baseUrl) {
    try {
        const response = await fetchImpl(`${baseUrl}/health`, {
            signal: AbortSignal.timeout(500),
        });
        return response.ok;
    }
    catch {
        return false;
    }
}
function toProxyInit(request) {
    const method = request.method.toUpperCase();
    const init = {
        method,
        headers: request.headers,
        signal: request.signal,
    };
    if (method !== 'GET' && method !== 'HEAD') {
        init.body = request.body;
        init.duplex = 'half';
    }
    return init;
}
function legacyErrorStream(message) {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
        start(controller) {
            controller.enqueue(encoder.encode(encodeSSEData(JSON.stringify({ type: 'error', error: message }))));
            controller.enqueue(encoder.encode(encodeSSEData('[DONE]')));
            controller.close();
        },
    });
    return new Response(stream, { headers: SSE_HEADERS });
}
function encodeSSEData(data) {
    return `data: ${data.replace(/\r\n|\r|\n/g, '\ndata: ')}\n\n`;
}
export function legacyJson(data, init) {
    return new Response(JSON.stringify(data), {
        status: init?.status ?? 200,
        statusText: init?.statusText,
        headers: { ...JSON_HEADERS, ...(init?.headers ?? {}) },
    });
}
//# sourceMappingURL=legacy-opencode-runtime.js.map