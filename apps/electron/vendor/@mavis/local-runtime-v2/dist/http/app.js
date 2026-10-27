import { Hono } from 'hono';
import { createControllers } from './controllers/create.js';
import { requestContextMiddleware } from './middleware/request-context.mw.js';
import { accessLogMiddleware } from './middleware/access-log.mw.js';
import { cancelDiscardedBody, errorBoundaryMiddleware } from './middleware/error-boundary.mw.js';
import { mountBindings } from './routing/adapter.js';
import { filterBindings, migratedMethodsForHost, } from './routing/allowlist.js';
import { makeBindings } from './routing/bindings.gen.js';
import { withMcpRequestParseErrorPolicy } from './routing/mcp-request-policy.js';
import { withModelProviderResponsePolicy } from './routing/model-provider-response-policy.js';
import { withPreferenceRequestParseErrorPolicy } from './routing/preference-request-policy.js';
import { mountProviderAuthRoutes } from './routing/provider-auth.js';
import { abortAllComputerUse, snapshotComputerUseState, } from '../service/computer-use/index.js';
import { mountWorkspaceHtmlPreviewRoutes } from './routing/workspace-html-preview.js';
import { mountBrowserTurnContextRoutes } from './routing/browser-turn-context.js';
import { mountChannelCompatRoutes } from './routing/channel-compat.js';
export { createV2AgentRuntimeManagementPort } from './controllers/agent-runtime-port.js';
const CRON_UNAVAILABLE_ERROR = {
    code: 'CRON_UNAVAILABLE',
    message: 'Cron is not available on this runtime host',
};
class CronUnavailableError extends Error {
    code = CRON_UNAVAILABLE_ERROR.code;
    constructor() {
        super(CRON_UNAVAILABLE_ERROR.message);
        this.name = 'CronUnavailableError';
    }
}
const CRON_UNAVAILABLE_SERVICE = new Proxy({}, {
    get() {
        return () => {
            throw new CronUnavailableError();
        };
    },
});
/** 创建完整的 v2 HTTP 前门，并只消费已经 ready 的业务 service。 */
export function createLocalRuntimeV2FrontDoor(deps) {
    const modelProvider = deps.services?.modelSystem && deps.services.modelProviderApplication
        ? {
            application: deps.services.modelProviderApplication,
            providers: deps.services.modelSystem.providers,
            listProviderPresets: deps.services.modelSystem.listProviderPresets,
        }
        : undefined;
    const controllers = createControllers({
        ...(deps.services ?? {}),
        ...(modelProvider ? { modelProvider } : {}),
        cron: deps.services?.cron ?? CRON_UNAVAILABLE_SERVICE,
    });
    const ownerCapabilities = deps.ownerCapabilities ?? inferOwnerCapabilities(deps.services);
    const handleRequest = buildApp(createFrontDoorAppDeps(deps, controllers, ownerCapabilities));
    return { handleRequest };
}
function createFrontDoorAppDeps(deps, controllers, ownerCapabilities) {
    return {
        bindings: filterBindings(withPreferenceRequestParseErrorPolicy(withModelProviderResponsePolicy(withMcpRequestParseErrorPolicy(makeBindings(controllers)))), migratedMethodsForHost(ownerCapabilities)),
        logger: deps.logger,
        metrics: deps.metrics,
        forceLegacy: () => false,
        legacyHandleRequest: deps.legacyHandleRequest,
        rejectLegacyCronWrites: ownerCapabilities.cron === true,
        workspaceHtmlPreview: deps.services?.workspace?.htmlPreview,
        browserUse: deps.services?.browserUse,
        ...(deps.services?.modelSystem?.oauth ? { codexOAuth: deps.services.modelSystem.oauth } : {}),
        ...(deps.services?.agentFavorites ? { agentFavorites: deps.services.agentFavorites } : {}),
        ...(deps.onLegacyFallback ? { onLegacyFallback: deps.onLegacyFallback } : {}),
        ...(deps.computerUseClient ? { computerUseClient: deps.computerUseClient } : {}),
        ...(deps.computerUsePreferences ? { computerUsePreferences: deps.computerUsePreferences } : {}),
        ...(deps.services?.channelSystem
            ? { channelLegacyHttp: deps.services.channelSystem.legacyHttp }
            : {}),
    };
}
/** Projects the assembled service surface into explicit HTTP owner capabilities. */
export function ownerCapabilitiesForServices(services) {
    return {
        agent: Boolean(services?.agent),
        canvas: Boolean(services?.canvas),
        globalEvents: Boolean(services?.globalEvents),
        cron: Boolean(services?.cron),
        // Plugin Marketplace, local MCP registry, and standalone Skill management
        // are claimed by every composed owner, exactly as before the Agent cutover.
        // Keyed on the owner itself rather than on `services.plugin`: v1 has no
        // plugin-system, so an unbound plugin service must still fail closed in v2
        // instead of falling through to v1.
        plugin: Boolean(services),
        session: Boolean(services?.applications || services?.conversation || services?.cronDelivery),
        workspaceGit: Boolean(services?.workspace?.git),
        workspaceFile: Boolean(services?.workspace?.file),
        workspaceLocalActions: Boolean(services?.workspace?.localActions),
        interaction: Boolean(services?.application?.questionnaires && services.application.permissions),
        workspaceIndexing: Boolean(services?.workspace?.indexing),
        modelProvider: Boolean(services?.modelSystem && services.modelProviderApplication),
        sessionApplications: Boolean(services?.applications),
        // Mount the Inspector only where it was actually composed; other hosts keep
        // falling through to the v1 fail-closed stubs.
        llmContextInspector: Boolean(services?.llmContextInspector),
        preference: Boolean(services?.composerSendBehavior),
        agentShell: Boolean(services?.agentShell),
        sandbox: Boolean(services?.sandbox),
        globalInstructions: Boolean(services?.globalInstructions),
        // Channel routes mount only where the channel owner is really assembled
        // (Electron). The same services key also drives the legacy REST compat
        // mount, so both entry views switch together (proposal §7.1).
        channel: Boolean(services?.channelSystem),
        // Memory V2 管理面只在 memory.v2 分支装配出 application 时接管；
        // 其余宿主回落 v1 的 memory-v2-disabled 降级实现。
        memoryV2: Boolean(services?.memoryV2),
        goal: Boolean(services?.goal),
    };
}
function inferOwnerCapabilities(services) {
    return ownerCapabilitiesForServices(services);
}
/**
 * Marker on the quiet-onError placeholder. Lives in statusText, NOT a header:
 * Hono's `set res` merges the OLD response's headers into any replacement
 * (context.js res setter), so a header marker would leak into errorBoundary's
 * structured JSON response; statusText is never merged, so it is only visible
 * when NOTHING replaced the placeholder (the blind-spot escape path).
 */
const ON_ERROR_PLACEHOLDER_STATUS_TEXT = 'v2-onerror-placeholder';
function buildApp(deps) {
    const app = new Hono();
    const handleLegacyRequest = (request) => {
        deps.onLegacyFallback?.({ method: request.method, url: request.url });
        return deps.legacyHandleRequest(request);
    };
    app.onError(createQuietOnError());
    const nowMs = () => Date.now();
    app.use(requestContextMiddleware({
        logger: deps.logger,
        nowMs,
        newRequestId: () => crypto.randomUUID(),
    }));
    app.use(accessLogMiddleware({ nowMs, metrics: deps.metrics }));
    app.use(errorBoundaryMiddleware());
    if (deps.codexOAuth)
        mountProviderAuthRoutes(app, deps.codexOAuth);
    mountWorkspaceHtmlPreviewRoutes(app, deps.workspaceHtmlPreview);
    mountBrowserTurnContextRoutes(app, deps.browserUse);
    if (deps.computerUseClient) {
        mountComputerUseRoutes(app, deps.computerUseClient);
    }
    app.get('/mavis/api/preferences/starred-agents', async (c) => {
        if (!deps.agentFavorites) {
            return c.json({
                code: 503,
                key: 'AGENT_FAVORITES_UNAVAILABLE',
                message: 'Agent favorites are unavailable',
            }, 503);
        }
        return c.json({ agents: await deps.agentFavorites.get() });
    });
    app.put('/mavis/api/preferences/starred-agents', async (c) => {
        if (!deps.agentFavorites) {
            return c.json({
                code: 503,
                key: 'AGENT_FAVORITES_UNAVAILABLE',
                message: 'Agent favorites are unavailable',
            }, 503);
        }
        const body = await readJsonObject(c.req.raw);
        const agents = Array.isArray(body.agents)
            ? body.agents.filter((value) => typeof value === 'string')
            : [];
        return c.json({ agents: await deps.agentFavorites.put(agents) });
    });
    app.all('/mavis/api/preferences/*', (c) => {
        const method = c.req.method.toUpperCase();
        return c.json({
            code: method === 'GET' ? 404 : 501,
            key: method === 'GET' ? 'PREFERENCE_NOT_FOUND' : 'PREFERENCE_RETIRED',
            message: `Preference route is not available: ${new URL(c.req.url).pathname}`,
        }, method === 'GET' ? 404 : 501);
    });
    // Channel legacy REST takeover (MR3): mounted before the generated
    // bindings and the fallthrough so matched channel URLs never reach v1.
    mountChannelCompatRoutes(app, deps.channelLegacyHttp);
    mountBindings(app, deps.bindings);
    // Fallthrough bridge (D5): unmigrated paths get the ORIGINAL Request.
    // v2 ctx + v1 ctx double-construction on fallthrough is accepted by design
    // (D5 unified observability); the body is not consumed by v2 middlewares.
    app.notFound((c) => {
        if (deps.rejectLegacyCronWrites && isRetiredLegacyCronWrite(c.req.raw)) {
            return c.json({
                code: 501,
                key: 'CRON_LEGACY_UNSUPPORTED',
                message: 'Legacy Cron writes are retired; use Cron v2',
            }, 501);
        }
        return handleLegacyRequest(c.req.raw);
    });
    return async function handleRequest(request) {
        if (deps.forceLegacy())
            return handleLegacyRequest(request);
        const res = await app.fetch(request);
        if (res.statusText === ON_ERROR_PLACEHOLDER_STATUS_TEXT) {
            // Blind spot backstop: an error escaped errorBoundary (thrown by an
            // OUTER middleware — requestContext/accessLog — post-next), so nothing
            // replaced the quiet-onError placeholder. Log here (the only observer
            // left; errorBoundary never saw the error so this is not a double log)
            // and return a structured 500 instead of an empty body.
            deps.logger.error({ path: new URL(request.url).pathname }, 'unhandled error escaped the error boundary');
            return new Response(JSON.stringify({ code: 500, key: 'INTERNAL_ERROR', message: 'internal error' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
        }
        return res;
    };
}
function mountComputerUseRoutes(app, client) {
    app.get('/mavis/api/computer-use/state', async (c) => {
        return c.json({
            ok: true,
            ...snapshotComputerUseState(),
        });
    });
    app.put('/mavis/api/computer-use/enabled', (c) => c.json({ ok: false, error: 'computer_use_managed_by_plugin' }, 410));
    app.post('/mavis/api/computer-use/abort', (c) => {
        const aborted = abortAllComputerUse();
        client.release?.();
        return c.json({ ok: true, aborted });
    });
}
async function readJsonObject(request) {
    try {
        const value = await request.json();
        return value && typeof value === 'object' && !Array.isArray(value)
            ? value
            : {};
    }
    catch {
        return {};
    }
}
function isRetiredLegacyCronWrite(request) {
    const method = request.method.toUpperCase();
    const path = new URL(request.url).pathname;
    if (method === 'POST' && path === '/mavis/api/cron/self-reminder')
        return true;
    const parts = path.split('/').filter(Boolean);
    if (!isLegacyCronTaskPath(parts))
        return false;
    const tail = parts.slice(5);
    if (tail.length === 1)
        return method === 'POST' || method === 'PATCH' || method === 'DELETE';
    return method === 'POST' && tail.length === 2 && tail[1] === 'trigger';
}
function isLegacyCronTaskPath(parts) {
    return (parts.length >= 6 &&
        parts[0] === 'mavis' &&
        parts[1] === 'api' &&
        parts[2] === 'agent' &&
        parts[4] === 'cron');
}
/**
 * Quiet replacement for Hono's default onError (Task 6 handoff):
 *
 * 1. No console.error — errorBoundary owns error logging/mapping (it runs
 *    after compose assigns our placeholder and reads c.error). For errors
 *    thrown OUTSIDE errorBoundary (requestContext/accessLog post-next), the
 *    placeholder survives untouched; buildApp's handleRequest detects it via
 *    ON_ERROR_PLACEHOLDER_STATUS_TEXT, logs the escape and swaps in a
 *    structured 500 — so no error path is ever fully silent.
 * 2. Cancels the current c.res body if present — when an inner middleware
 *    throws post-next, compose calls onError while c.res still holds the
 *    original (possibly streaming SSE) response; cancelling here is the only
 *    place the orphaned stream's finally can be triggered (compose's res
 *    setter would silently drop it otherwise).
 * 3. Returns a marked bare placeholder; errorBoundary overwrites it with the
 *    structured JSON body (dropping the statusText marker — a header marker
 *    would leak through Hono's res-setter header merge, statusText does not).
 */
function createQuietOnError() {
    return (_err, c) => {
        cancelDiscardedBody(c.res.body);
        return new Response(null, { status: 500, statusText: ON_ERROR_PLACEHOLDER_STATUS_TEXT });
    };
}
//# sourceMappingURL=app.js.map