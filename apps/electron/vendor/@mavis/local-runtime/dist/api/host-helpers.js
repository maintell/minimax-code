// Helpers extracted from `api/host.ts` to keep that file under the
// 2000-line block threshold enforced by `scripts/hooks/pre-commit`
// (see boy-scout warning trail on commits f2b4b14a / d7e454fe). Pure
// utilities + small interfaces + the SSE writer wrapper — no `this` dependencies.
import { RespDataType, Role, } from '@mavis/agent-core/protocol/agent-message';
import { logger } from '../common/logger.js';
import { hostDiagnosticsUnavailable, } from '../observability/diagnostics-provider.js';
import { routeDesktopServiceRequest } from '../http/routes.js';
import { routeDesktopServiceWithLegacyMavisApiCompat } from '../http/legacy-mavis-api-compat.js';
export { buildLocalHardDenyReason, buildLocalPermissionRuleContents, localPermissionRuleToolName, } from './host-permission-rules.js';
export async function routeDiagnosticsApi(hostDiagnosticsProvider, request, parts) {
    const method = request.method.toUpperCase();
    if (method === 'POST' && parts[1] === 'upload') {
        return json(hostDiagnosticsProvider?.uploadDiagnosticBundle
            ? await hostDiagnosticsProvider.uploadDiagnosticBundle(await readJsonBody(request))
            : hostDiagnosticsUnavailable('diagnostic-upload'));
    }
    return notFound(`/diagnostics/${parts.slice(1).join('/')}`);
}
// ─── HTTP response header constants ─────────────────────────────────────
export const JSON_HEADERS = { 'Content-Type': 'application/json' };
export const SSE_HEADERS = {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
};
// ─── SSE writer wrapper used by the streaming routes ───────────────────
export class SseWriter {
    controller;
    encoder = new TextEncoder();
    closed = false;
    constructor(controller) {
        this.controller = controller;
    }
    write(data) {
        if (this.closed)
            return;
        try {
            this.controller.enqueue(this.encoder.encode(encodeSSEData(data)));
        }
        catch {
            this.closed = true;
        }
    }
    writeJson(value) {
        this.write(JSON.stringify(value));
    }
    writeEvent(data, options) {
        if (this.closed)
            return;
        try {
            this.controller.enqueue(this.encoder.encode(encodeSSEEvent(data, options)));
        }
        catch {
            this.closed = true;
        }
    }
    close() {
        if (this.closed)
            return;
        this.closed = true;
        try {
            this.controller.close();
        }
        catch {
            // Consumer may have cancelled the stream.
        }
    }
}
// ─── Pure URL/path helpers ─────────────────────────────────────────────
export function splitPath(pathname) {
    return pathname.split('/').filter(Boolean);
}
export function buildLegacyDaemonProxyPath(rawPathname, decodedApiPath, search, root) {
    const rawApiPath = rawPathname.slice('/mavis/api'.length);
    const rawPrefix = `/${root}`;
    if (rawApiPath !== rawPrefix && !rawApiPath.startsWith(`${rawPrefix}/`))
        return undefined;
    if (/%2f|%5c/iu.test(rawApiPath))
        return undefined;
    const decodedParts = splitPath(decodedApiPath);
    if (decodedParts.some((part) => part === '.' || part === '..'))
        return undefined;
    return `${rawApiPath}${search}`;
}
// ─── Response factories ────────────────────────────────────────────────
export function json(data, init) {
    return new Response(JSON.stringify(data), {
        status: init?.status ?? 200,
        statusText: init?.statusText,
        headers: { ...JSON_HEADERS, ...(init?.headers ?? {}) },
    });
}
export function notFound(pathname) {
    return json({ error: `Local runtime route not found: ${pathname}` }, { status: 404 });
}
const DESKTOP_WEBSITE_API_PREFIX = '/minimax-desktop/api/v1';
export async function routeLocalApiHostEntryRequest({ request, pathname, runtimeStartupToken, desktopServiceHandler, }) {
    if (pathname === '/mavis/health') {
        return {
            type: 'response',
            response: json({
                status: 'ok',
                runtime: 'local-runtime',
                ...(runtimeStartupToken ? { startupToken: runtimeStartupToken } : {}),
            }),
        };
    }
    if (pathname === '/mavis/api/version') {
        return {
            type: 'response',
            response: json({
                version: 'local-runtime',
                latestVersion: null,
                updateAvailable: false,
                updateCommand: '',
            }),
        };
    }
    if (pathname === '/mavis/api/update') {
        return { type: 'response', response: json({ ok: true }) };
    }
    if (pathname === `${DESKTOP_WEBSITE_API_PREFIX}/drive` ||
        pathname.startsWith(`${DESKTOP_WEBSITE_API_PREFIX}/drive/`)) {
        // Desktop's public prefix and managed BizGateway's `/mavis/api/v1`
        // prefix are different contract layers. This is only a local-runtime
        // compatibility map: keep the original Request so query, body, method,
        // and the existing website route's strict validation stay unchanged.
        // PV traffic remains the independent website traffic operation below.
        return {
            type: 'api',
            apiPath: pathname.slice(DESKTOP_WEBSITE_API_PREFIX.length),
        };
    }
    const desktopServiceRoute = await routeDesktopServiceWithLegacyMavisApiCompat(request, desktopServiceHandler ?? routeDesktopServiceRequest);
    if (desktopServiceRoute)
        return desktopServiceRoute;
    if (!pathname.startsWith('/mavis/api/')) {
        return { type: 'response', response: notFound(pathname) };
    }
    return { type: 'api', apiPath: pathname.slice('/mavis/api'.length) };
}
export function notImplemented(feature) {
    return json({ success: false, error: `Local runtime route is not implemented: ${feature}` }, { status: 501 });
}
export async function readJsonBody(request) {
    try {
        const data = (await request.json());
        return data && typeof data === 'object' && !Array.isArray(data)
            ? data
            : {};
    }
    catch {
        return {};
    }
}
export async function readResumeRequest(request, url) {
    const body = await readJsonBody(request);
    const msgId = url.searchParams.get('msgId') ??
        readFirstString(body, ['msgId', 'msg_id', 'after_message_id', 'after_msg_id']);
    const afterCursor = url.searchParams.get('afterCursor') ??
        url.searchParams.get('after_cursor') ??
        readFirstString(body, ['afterCursor', 'after_cursor']) ??
        request.headers.get('Last-Event-ID') ??
        undefined;
    const turnId = url.searchParams.get('turnId') ?? readFirstString(body, ['turnId', 'turn_id']);
    const drainQueued = url.searchParams.get('drainQueued') === 'true' ||
        url.searchParams.get('drain_queued') === 'true' ||
        body.drainQueued === true ||
        body.drain_queued === true;
    return {
        ...(msgId ? { msgId } : {}),
        ...(afterCursor ? { afterCursor } : {}),
        ...(turnId ? { turnId } : {}),
        ...(drainQueued ? { drainQueued } : {}),
    };
}
// ─── Field readers ─────────────────────────────────────────────────────
export function readString(data, key) {
    const value = data[key];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}
export function readVisibility(data) {
    const value = data.visibility;
    return value === 'visible' || value === 'hidden' ? value : undefined;
}
export function readPermissionDecision(data) {
    const value = data.decision;
    if (typeof value !== 'string')
        return undefined;
    const aliases = {
        allow: 'allowOnce',
        'allow-always': 'allowAlways',
        'allow-for-agent': 'allowOnce',
        allowForAgent: 'allowOnce',
        allowAlways: 'allowAlways',
        allowOnce: 'allowOnce',
        deny: 'deny',
    };
    return aliases[value];
}
export function readRecord(value) {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value
        : {};
}
export function readRequestedFramework(data) {
    const raw = data.frameworkType ?? data.framework_type ?? data.engine;
    return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}
// ─── Agent name + model id helpers ─────────────────────────────────────
export function buildGeneratedAgentName() {
    const random = globalThis.crypto?.randomUUID?.().replaceAll('-', '').slice(0, 12) ??
        `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`.slice(0, 12);
    return `agent-${random}`;
}
export function isValidLocalAgentName(name) {
    return /^[a-z][a-z0-9_-]*$/.test(name);
}
export function isString(value) {
    return typeof value === 'string';
}
export function splitModelId(model) {
    // Split at the FIRST slash only and keep the remainder as the model id:
    // custom model ids may themselves contain slashes (OpenRouter-style
    // vendor/model). Aligned with parseModelKey / parseSourceQualifiedModelKey;
    // behavior is unchanged for all zero- and one-slash inputs.
    const slash = model.indexOf('/');
    if (slash < 0)
        return [model || undefined, undefined];
    return [model.slice(0, slash) || undefined, model.slice(slash + 1) || undefined];
}
export function readLocalPermissionMode(value) {
    return value === 'default' ||
        value === 'acceptEdits' ||
        value === 'bypassPermissions' ||
        value === 'auto' ||
        value === 'off'
        ? value
        : 'auto';
}
export function readFirstString(data, keys) {
    for (const key of keys) {
        const value = data[key];
        if (typeof value === 'string' && value.length > 0)
            return value;
    }
    return undefined;
}
// ─── RespData parsing + Pi frame helpers ───────────────────────────────
export function parseRespData(raw) {
    try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : undefined;
    }
    catch {
        return undefined;
    }
}
export function toSessionTurnFrameInput(data) {
    const resp = parseRespData(data);
    if (resp?.type === RespDataType.AgentMessage && resp.agent_message) {
        return {
            data,
            messageId: resp.agent_message.msg_id,
            completeMessage: true,
        };
    }
    if (resp?.type === RespDataType.AgentMessageChunk && resp.agent_message_chunk) {
        return {
            data,
            messageId: resp.agent_message_chunk.msg_id,
            ...(typeof resp.agent_message_chunk.chunk_index === 'number'
                ? { chunkIndex: resp.agent_message_chunk.chunk_index }
                : {}),
            completeMessage: false,
        };
    }
    return { data, completeMessage: false };
}
/**
 * Build the in-band SSE terminal `{ type: 'error', ... }` frame the owner-turn
 * writer emits on failure. `errorCode` is included when defined so the UI SSE
 * consumer at `packages/ui/src/services/runtimeProjection.ts` reads it off
 * `raw.errorCode` and code-prefixes the message for downstream biz-status
 * parse (e.g. Token Plan 42212 / 2056 quota family).
 */
export function buildInBandErrorFrame(errorMessage, errorCode) {
    return {
        type: 'error',
        error: errorMessage,
        ...(errorCode !== undefined ? { errorCode } : {}),
    };
}
/**
 * Build the `{ errorMessage, errorCode? }` update fields the owner-turn catch
 * branch (and other terminal-error persistence sites) spread into
 * `controller.updateSession` + `recordMemorySessionFinish` payloads.
 * Extracted so the catch branch stays compact under the layout gate.
 */
export function buildLocalTurnErrorFields(errorMessage, errorCode) {
    return { errorMessage, ...(errorCode !== undefined ? { errorCode } : {}) };
}
export async function persistLocalTurnCatchTerminal(deps) {
    const message = deps.err instanceof Error ? deps.err.message : String(deps.err);
    const classified = deps.classifyLLMErrorToCode(deps.err);
    const errFields = buildLocalTurnErrorFields(classified?.message ?? message, classified?.status_code);
    await deps.controller.updateSession(deps.session.sessionId, { status: 'error', ...errFields });
    await deps.recordMemorySessionFinish({
        session: deps.session,
        turnId: deps.turnId,
        status: 'error',
        ...errFields,
        nowMs: deps.nowMs,
        memoryFacade: deps.memoryFacade,
        emitBusEvent: deps.emitBusEvent,
    });
    deps.writer.writeJson(buildInBandErrorFrame(errFields.errorMessage, errFields.errorCode));
    return errFields;
}
// ─── SSE encoding + ID generation ──────────────────────────────────────
export function encodeSSEData(data) {
    return `data: ${data.replace(/\r\n|\r|\n/g, '\ndata: ')}\n\n`;
}
export function encodeSSEEvent(data, options) {
    const lines = [];
    if (options?.id)
        lines.push(`id: ${options.id}`);
    if (options?.event)
        lines.push(`event: ${options.event}`);
    lines.push(`data: ${data.replace(/\r\n|\r|\n/g, '\ndata: ')}`);
    return `${lines.join('\n')}\n\n`;
}
export function makeId(prefix) {
    const random = globalThis.crypto?.randomUUID?.().replaceAll('-', '') ??
        `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
    return `${prefix}_${random}`;
}
export function serializePermissionRequest(item) {
    return {
        requestId: item.requestId,
        sessionId: item.sessionId,
        turnId: item.turnId,
        agentName: item.agentName,
        toolName: item.toolName,
        ruleContents: item.ruleContents,
        ...(item.toolInput ? { toolInput: item.toolInput } : {}),
        ...(item.toolDescription ? { toolDescription: item.toolDescription } : {}),
        reason: item.reason,
        allowAlwaysSupported: item.ruleContents.length > 0 || item.persistWholeToolRuleOnReply === true,
        createdAt: item.createdAt,
    };
}
export function formatPeekMessage(message) {
    const content = typeof message.msg_content === 'string'
        ? message.msg_content
        : safeJsonStringify(message.msg_content);
    if (!content)
        return undefined;
    const role = message.role === Role.User ? 'user' : message.role === Role.Assistant ? 'assistant' : 'system';
    return `${role}: ${content.slice(0, 2_000)}`;
}
export function isVisibleTreeSession(session) {
    if (session.visibility === 'hidden')
        return false;
    const purpose = session.purpose ?? '';
    return !purpose.startsWith('peek_') && !purpose.startsWith('peek:');
}
export function safeJsonStringify(value) {
    try {
        return JSON.stringify(value);
    }
    catch {
        return undefined;
    }
}
// ─── Config sanitization (mask secrets in API responses) ───────────────
// Generic over the runtime config shape so the helpers compile here
// without importing `LocalRuntimeConfig` (keeps this file dependency-free
// against the host's type surface).
export function sanitizeConfig(config) {
    return {
        ...sanitizeRecord(config),
        provider: sanitizeProviderConfig((config.provider ?? {})),
    };
}
export async function hostCreateRootSession(deps) {
    const { agentName, createSession, replaceRootSession, deleteSession, resolveWorkspaceDir } = deps;
    // Create the transient session as a branch, then let
    // `replaceRootSession` promote it to root (which also demotes the
    // previous root). If the promote
    // fails we must NOT return the branch masquerading as a root —
    // that was the original silent-bail bug that produced
    // `outcome:'ok'` while `sessionType='branch'`. Clean up the
    // transient row and return undefined so the caller surfaces the
    // failure to the user.
    const branch = await createSession({
        agentName,
        workspaceDir: resolveWorkspaceDir(),
        sessionType: 'branch',
        sessionKind: 'conversation',
        title: 'Main',
        parentSessionId: null,
        isDefaultWorkspace: true,
        origin: 'user',
    });
    const promoted = await replaceRootSession(agentName, branch.sessionId);
    if (!promoted) {
        logger.error({
            scope: 'host.createRootSession',
            agentName,
            transientBranchId: branch.sessionId,
        }, 'createRootSession: replaceRootSession returned undefined; cleaning up transient branch');
        try {
            await deleteSession(branch.sessionId);
        }
        catch (err) {
            logger.warn({
                scope: 'host.createRootSession',
                agentName,
                transientBranchId: branch.sessionId,
                err: err instanceof Error ? err.message : String(err),
            }, 'createRootSession: cleanup of transient branch failed (non-fatal)');
        }
        return undefined;
    }
    return promoted;
}
export function sanitizeProviderConfig(provider) {
    return Object.fromEntries(Object.entries(provider).map(([providerId, providerConfig]) => [
        providerId,
        sanitizeRecord(providerConfig),
    ]));
}
export function sanitizeRecord(record) {
    return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, sanitizeConfigValue(key, value)]));
}
export function sanitizeConfigValue(key, value) {
    if (key === 'headers' && value && typeof value === 'object' && !Array.isArray(value)) {
        return Object.fromEntries(Object.entries(value).map(([headerKey, headerValue]) => [
            headerKey,
            typeof headerValue === 'string' ? maskSecret(headerValue) : '****',
        ]));
    }
    if (isSensitiveKey(key)) {
        return typeof value === 'string' ? maskSecret(value) : '****';
    }
    if (typeof value === 'string') {
        return maskUrlCredentials(value);
    }
    if (Array.isArray(value)) {
        return value.map((item) => sanitizeConfigValue(key, item));
    }
    if (value && typeof value === 'object') {
        return sanitizeRecord(value);
    }
    return value;
}
export function isSensitiveKey(key) {
    return /api[-_]?key|token|secret|authorization|password|credential/i.test(key);
}
export function maskSecret(value) {
    return value.length > 8 ? `${value.slice(0, 4)}****${value.slice(-4)}` : '****';
}
export function maskUrlCredentials(value) {
    try {
        const url = new URL(value);
        if (!url.username && !url.password)
            return value;
        if (url.username)
            url.username = '****';
        if (url.password)
            url.password = '****';
        return url.toString();
    }
    catch {
        return value;
    }
}
//# sourceMappingURL=host-helpers.js.map