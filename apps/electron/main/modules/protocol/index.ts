/**
 * 自定义协议处理模块
 * 用于在生产模式下加载 Next.js 静态导出的资源
 *
 * 这是 Electron + Next.js 静态导出的标准做法
 * 类似于 electron-serve 库的实现
 *
 * 热更新支持：
 * - 静态资源只从启动时决定的渲染根目录读取（安装包 out/ 或某个完整的热更新版本目录），
 *   进程生命周期内不变，不做逐文件回退。
 */
import * as path from "path";
import * as fs from "fs";
import { protocol, app, session, net } from "electron";
import { getHotUpdateBootRenderer } from "../hotUpdate";
import { handleLocalRuntimeRequest } from "../local-runtime";
import { createDocumentPreviewArtifactRequestGuard, createDocumentPreviewProtocolHandler } from "../document-preview/artifact-protocol";
import { sharedDocumentPreviewArtifactStore } from "../document-preview/artifact-store";
import { enqueueElectronObservabilityEvent } from "../observability/outbox";
import * as logger_1 from "../../utils/logger";
import { PREVIEW_ARTIFACT_PROTOCOL_NAME_V1 } from "@mavis/shared/document-preview";
import { createPptxCoreRuntimeProtocolHandler } from "../document-preview/pptx-core/runtime-protocol";
import { DOMAIN_URL } from "../../config/constants";
import { routeProjectRuntimeMediaRequest } from "./project-runtime-media";
import { isDeveloperBuildEligible } from "../../config/developer-build-policy";
import { isDev, isTest, isStaging, isInternalBuild, isInsideBuild } from "../../config/env";
/**
 * 注册自定义协议 scheme
 * 必须在 app ready 之前调用
 */
export function registerProtocolScheme() {
    protocol.registerSchemesAsPrivileged([
        {
            scheme: 'app',
            privileges: {
                standard: true,
                secure: true,
                supportFetchAPI: true,
                corsEnabled: true,
                stream: true,
                // Packaged pages use app://; extensions need an explicit scheme grant.
                ...(isDeveloperBuildEligible({
                    isDev: isDev,
                    isTest: isTest,
                    isStaging: isStaging,
                    isInternalBuild: isInternalBuild,
                    isInsideBuild: isInsideBuild,
                })
                    ? { allowExtensions: true }
                    : {}),
            },
        },
        {
            scheme: PREVIEW_ARTIFACT_PROTOCOL_NAME_V1,
            privileges: {
                standard: true,
                secure: true,
                supportFetchAPI: true,
                corsEnabled: false,
                stream: true,
            },
        },
    ]);
}
let documentPreviewProtocolRegistered = false;
/**
 * Window during which repeated guard hits for the same preview collapse into a
 * single report. Matched to the outbox's own pending-ack TTL so an incident
 * never spans more than one reporting window.
 */
const DOCUMENT_PREVIEW_GUARD_HIT_DEDUP_WINDOW_MS = 60000;
/**
 * Ceiling on distinct (previewId, kind) pairs reported per window. Per-preview
 * dedup alone does not bound a renderer that walks distinct preview ids, and
 * the outbox only retains 200 events; this keeps guard telemetry from evicting
 * crash reports even under a deliberate walk.
 */
const DOCUMENT_PREVIEW_GUARD_HIT_MAX_PER_WINDOW = 32;
/**
 * Binds the host-free guard's telemetry seam to the real observability outbox.
 *
 * PDF.js fetches the viewer plus one request per sub-resource, so a single
 * mis-owned preview produces a burst of rejections. Reporting each one would
 * synchronously append hundreds of lines to the outbox, evict `app.crash`
 * records from its 200-event retention window, and fan out one RUM error per
 * request. First hit per `previewId + kind` inside the window fully
 * characterises the incident; the injected category logger still records every
 * single rejection (local logs are rotated).
 *
 * `previewId` is used for de-duplication only - the enqueued payload keeps the
 * bounded `kind` field so the outbox sanitizer's allowlist branch stays intact.
 */
export function createDocumentPreviewGuardHitReporter(enqueue = enqueueElectronObservabilityEvent) {
    const reported = new Set();
    return (kind, context) => {
        // NUL separator: the guard only accepts `[A-Za-z0-9_-]` preview ids and
        // `kind` is a closed union, so distinct pairs can never collide into one key.
        const key = `${context.previewId}\u0000${kind}`;
        if (reported.has(key))
            return;
        if (reported.size >= DOCUMENT_PREVIEW_GUARD_HIT_MAX_PER_WINDOW)
            return;
        reported.add(key);
        const expiry = setTimeout(() => reported.delete(key), DOCUMENT_PREVIEW_GUARD_HIT_DEDUP_WINDOW_MS);
        expiry.unref?.();
        enqueue('office_preview_guard_hit', { kind }, 'error');
    };
}
function defaultDocumentPreviewProtocolOptions() {
    const appPath = app.getAppPath();
    const rendererRoot = getHotUpdateBootRenderer().root;
    const bundledOutPath = path.join(appPath, 'out');
    return {
        store: sharedDocumentPreviewArtifactStore,
        pdfRoots: [
            path.join(rendererRoot, 'pdf'),
            ...(rendererRoot === bundledOutPath ? [] : [path.join(bundledOutPath, 'pdf')]),
            path.join(appPath, 'public', 'pdf'),
        ],
        logger: (0, logger_1.getCategoryLogger)('document-preview'),
    };
}
/**
 * Register the isolated artifact/viewer scheme after Electron is ready.
 * Exposed separately so packaged smoke tests can assert the handler without
 * booting the full renderer.
 */
export function setupDocumentPreviewProtocolHandler(options = defaultDocumentPreviewProtocolOptions()) {
    if (documentPreviewProtocolRegistered)
        return;
    session.defaultSession.webRequest.onBeforeRequest({ urls: [`${PREVIEW_ARTIFACT_PROTOCOL_NAME_V1}://preview/artifact/*`] }, createDocumentPreviewArtifactRequestGuard({
        ...options,
        onGuardHit: createDocumentPreviewGuardHitReporter(),
    }));
    protocol.handle(PREVIEW_ARTIFACT_PROTOCOL_NAME_V1, createDocumentPreviewProtocolHandler(options));
    documentPreviewProtocolRegistered = true;
}
/**
 * 解析请求路径到实际文件路径
 * @param basePaths - 按优先级排序的基础路径数组
 * @param urlPath - URL 路径 (must be already validated against traversal)
 * @returns 解析后的文件路径
 */
function resolveFilePath(basePaths, urlPath) {
    // 遍历所有基础路径，找到第一个存在的文件
    for (const basePath of basePaths) {
        const filePath = path.join(basePath, urlPath);
        // 防止路径穿越：resolved 路径必须在 basePath 内
        if (!filePath.startsWith(basePath))
            continue;
        // 如果有扩展名，检查文件是否存在
        if (path.extname(filePath)) {
            if (fs.existsSync(filePath)) {
                return filePath;
            }
            continue;
        }
        // 检查是否是目录，加载 index.html
        if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
            const indexPath = path.join(filePath, 'index.html');
            if (fs.existsSync(indexPath)) {
                return indexPath;
            }
        }
        // 尝试 .html 扩展名
        const htmlPath = filePath + '.html';
        if (fs.existsSync(htmlPath)) {
            return htmlPath;
        }
        // 尝试目录下的 index.html
        const indexPath = path.join(filePath, 'index.html');
        if (fs.existsSync(indexPath)) {
            return indexPath;
        }
    }
    // 如果都没找到，返回第一个基础路径下的文件（让 net.fetch 处理 404）
    const primaryPath = basePaths[0];
    const filePath = path.join(primaryPath, urlPath);
    if (path.extname(filePath)) {
        return filePath;
    }
    // 默认返回 index.html
    return path.join(primaryPath, urlPath, 'index.html');
}
// ─── Upstream connection tracking ──────────────────────────────────────────
// Electron's protocol.handle does not reliably fire request.signal on
// renderer navigation (Cmd+R). To prevent HTTP/1.1 connection pool
// exhaustion from leaked SSE/streaming connections, we track upstream
// AbortControllers and cancel them when new requests arrive for the
// same streaming endpoint.
/** Active upstream controllers for streaming endpoints (e.g. SSE /events) */
const activeStreams = new Map();
/**
 * Abort ALL active upstream streaming connections.
 * Called from webContents 'did-start-navigation' to kill zombie SSE
 * connections that survive Cmd+R (where request.signal is unreliable).
 */
export function abortAllStreams() {
    if (activeStreams.size === 0)
        return;
    logger_1.default.info(`[Protocol] Aborting all active streams (${activeStreams.size})`);
    for (const [path, controller] of activeStreams) {
        controller.abort();
        logger_1.default.debug(`[Protocol] Aborted stream: ${path}`);
    }
    activeStreams.clear();
}
/**
 * For streaming endpoints, abort any previous upstream connection before
 * creating a new one. This ensures at most one SSE connection per endpoint
 * path, freeing the HTTP connection slot on Cmd+R reload.
 */
function getUpstreamController(urlPath) {
    const prev = activeStreams.get(urlPath);
    if (prev) {
        prev.abort();
        logger_1.default.debug(`[Protocol] Aborted previous stream: ${urlPath}`);
    }
    const controller = new AbortController();
    activeStreams.set(urlPath, controller);
    return controller;
}
/** Streaming endpoint suffixes that hold long-lived SSE connections (POST only) */
const STREAMING_SUFFIXES = ['/message', '/resume'];
function isStreamingRequest(method, urlPath) {
    if (urlPath === '/minimax-desktop/api/v1/events')
        return true;
    if (urlPath === '/archon/api/v1/events')
        return true;
    if (method === 'POST' && urlPath.startsWith('/mavis/api/session/')) {
        return STREAMING_SUFFIXES.some((s) => urlPath.endsWith(s));
    }
    if (method === 'POST' && urlPath.startsWith('/archon/api/v1/session/')) {
        return STREAMING_SUFFIXES.some((s) => urlPath.endsWith(s));
    }
    return false;
}
const MATERIALIZE_MAX_BYTES = 1024 * 1024;
const BINARY_CONTENT_TYPE_PREFIXES = ['image/', 'video/', 'audio/'];
const BINARY_CONTENT_TYPES = new Set([
    'application/octet-stream',
    'application/pdf',
    'application/zip',
    'application/x-zip-compressed',
]);
function sanitizePassthroughHeaders(headers) {
    const sanitized = new Headers(headers);
    sanitized.delete('connection');
    sanitized.delete('keep-alive');
    sanitized.delete('proxy-authenticate');
    sanitized.delete('proxy-authorization');
    sanitized.delete('te');
    sanitized.delete('trailer');
    sanitized.delete('transfer-encoding');
    sanitized.delete('upgrade');
    return sanitized;
}
function sanitizeMaterializedHeaders(headers) {
    const sanitized = sanitizePassthroughHeaders(headers);
    sanitized.delete('content-encoding');
    sanitized.delete('content-length');
    return sanitized;
}
function getContentLength(headers) {
    const raw = headers.get('content-length');
    if (!raw)
        return null;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}
function isBodylessResponse(method, status) {
    return method === 'HEAD' || status === 204 || status === 304;
}
function isLargeOrFileResponsePath(urlPath) {
    if (urlPath === '/mavis/api/file/content' || urlPath === '/mavis/api/file/preview') {
        return true;
    }
    if (/^\/mavis\/api\/agent\/[^/]+\/(?:identity\/)?avatar$/u.test(urlPath)) {
        return true;
    }
    return false;
}
function isBinaryContentType(contentType) {
    const normalized = contentType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
    return (BINARY_CONTENT_TYPES.has(normalized) ||
        BINARY_CONTENT_TYPE_PREFIXES.some((prefix) => normalized.startsWith(prefix)));
}
function shouldMaterializeResponse(method, urlPath, response) {
    if (isBodylessResponse(method, response.status))
        return false;
    if (isLargeOrFileResponsePath(urlPath))
        return false;
    if (response.headers.has('content-disposition'))
        return false;
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('text/event-stream') || isBinaryContentType(contentType))
        return false;
    const contentLength = getContentLength(response.headers);
    return contentLength === null || contentLength <= MATERIALIZE_MAX_BYTES;
}
/**
 * 设置自定义协议处理器
 * 静态资源根目录在启动时确定（内置 out/ 或热更新版本目录），进程内固定
 */
export function setupProtocolHandler(options = {}) {
    const bootRenderer = getHotUpdateBootRenderer();
    const rendererRoot = bootRenderer.root;
    const pptxCoreRuntimeRoot = app.isPackaged
        ? path.join(process.resourcesPath, 'resources', 'pptx-core')
        : (process.env.MAVIS_PPTX_CORE_RUNTIME_ROOT ??
            path.resolve(app.getAppPath(), '..', '..', 'packages', 'pptx-core', 'wasm-dist'));
    // Packaged Electron apps keep the short `r/` physical layout for the
    // PPTX core runtime (Windows MAX_PATH budget); unpackaged dev / hot-update
    // runs read the historical `wasm-dist/<hash>/...` tree. The layout is
    // chosen once at startup and is never probed per request. A missing
    // `runtime.json` only downgrades the response to 503, never the layout.
    const pptxCoreLayout = app.isPackaged ? 'packaged' : 'dev';
    const handlePptxCoreRuntime = createPptxCoreRuntimeProtocolHandler({
        runtimeRoot: fs.existsSync(path.join(pptxCoreRuntimeRoot, 'runtime.json'))
            ? pptxCoreRuntimeRoot
            : null,
        layout: pptxCoreLayout,
    });
    logger_1.default.info(`[Protocol] Renderer root: ${rendererRoot} (source=${bootRenderer.source}, ` +
        `version=${bootRenderer.version ?? 'bundled'})`);
    protocol.handle('app', async (request) => {
        const url = new URL(request.url);
        let urlPath = decodeURIComponent(url.pathname);
        // Development-only Cloud JSON bridge. The composition layer provides the
        // callback exclusively when the effective runtime transport is protocol.
        // Keep the target host/path closed so app:// never becomes an open proxy.
        if (url.hostname === 'cloud') {
            if (!options.cloudJsonFetch ||
                (urlPath !== '/minimax-cloud/api' && !urlPath.startsWith('/minimax-cloud/api/'))) {
                return new Response(JSON.stringify({ error: 'cloud_protocol_unavailable' }), {
                    status: 404,
                    headers: { 'content-type': 'application/json' },
                });
            }
            try {
                const targetUrl = new URL(`${urlPath}${url.search}`, DOMAIN_URL);
                const method = request.method.toUpperCase();
                const cloudRequest = new Request(targetUrl, {
                    method,
                    headers: request.headers,
                    signal: request.signal,
                    ...(method === 'GET' || method === 'HEAD' ? {} : { body: request.body, duplex: 'half' }),
                });
                return await options.cloudJsonFetch(cloudRequest);
            }
            catch (error) {
                logger_1.default.warn(`[Protocol] Cloud JSON proxy failed: ${urlPath} - ${String(error)}`);
                return new Response(JSON.stringify({ error: 'cloud_proxy_failed' }), {
                    status: 502,
                    headers: { 'content-type': 'application/json' },
                });
            }
        }
        if (urlPath.startsWith('/_mavis/pptx-core/')) {
            return handlePptxCoreRuntime(request);
        }
        // ── Local runtime API:
        //    - /mavis/* keeps the local UI contract unchanged.
        //    - /minimax-desktop/api/* serves generated DesktopService methods.
        //    - /archon/api/v1/* is accepted as a short Electron-local alias for
        //      service methods that still use CLOUD_API_BASE constants internally.
        if (urlPath.startsWith('/mavis/') ||
            urlPath.startsWith('/minimax-desktop/api/') ||
            urlPath.startsWith('/archon/api/v1/')) {
            const localUrl = new URL(request.url);
            if (urlPath.startsWith('/archon/api/v1/')) {
                localUrl.pathname = `/mavis/api/${urlPath.slice('/archon/api/v1/'.length)}`;
            }
            logger_1.default.debug(`[Protocol] Local runtime: ${request.url} -> ${localUrl.pathname}${localUrl.search}`);
            const isStreaming = isStreamingRequest(request.method, urlPath);
            const upstream = isStreaming ? getUpstreamController(urlPath) : null;
            let combinedSignal;
            if (upstream) {
                combinedSignal = AbortSignal.any([upstream.signal, request.signal]);
                request.signal.addEventListener('abort', () => {
                    if (activeStreams.get(urlPath) === upstream) {
                        activeStreams.delete(urlPath);
                    }
                }, { once: true });
            }
            else {
                combinedSignal = request.signal;
            }
            try {
                const localRequest = new Request(localUrl.toString(), {
                    method: request.method,
                    headers: request.headers,
                    body: request.body,
                    signal: combinedSignal,
                    duplex: 'half',
                });
                const response = (await routeProjectRuntimeMediaRequest(localRequest)) ??
                    (await handleLocalRuntimeRequest(localRequest));
                if (isStreaming && response.body) {
                    combinedSignal.addEventListener('abort', () => {
                        response.body?.cancel().catch(() => { });
                    }, { once: true });
                }
                if (isStreaming && upstream && !response.body) {
                    if (activeStreams.get(urlPath) === upstream) {
                        activeStreams.delete(urlPath);
                    }
                }
                if (!isStreaming && shouldMaterializeResponse(request.method, urlPath, response)) {
                    const body = await response.arrayBuffer();
                    logger_1.default.debug(`[Protocol] Local runtime materialized: ${localUrl.pathname} status=${response.status} bytes=${body.byteLength}`);
                    return new Response(body, {
                        status: response.status,
                        statusText: response.statusText,
                        headers: sanitizeMaterializedHeaders(response.headers),
                    });
                }
                if (!isStreaming) {
                    logger_1.default.debug(`[Protocol] Local runtime passthrough: ${localUrl.pathname} status=${response.status} bytes=${getContentLength(response.headers) ?? 'unknown'}`);
                    return new Response(response.body, {
                        status: response.status,
                        statusText: response.statusText,
                        headers: sanitizePassthroughHeaders(response.headers),
                    });
                }
                return response;
            }
            catch (err) {
                if (upstream && activeStreams.get(urlPath) === upstream) {
                    activeStreams.delete(urlPath);
                }
                if (err instanceof Error && err.name === 'AbortError') {
                    return new Response(null, { status: 499 });
                }
                logger_1.default.warn(`[Protocol] Local runtime failed: ${localUrl.pathname} - ${String(err)}`);
                return new Response(JSON.stringify({ error: 'local_runtime_unavailable' }), {
                    status: 502,
                    headers: { 'Content-Type': 'application/json' },
                });
            }
        }
        // ── Static files: serve from the boot renderer root ──
        // 处理根路径
        if (urlPath === '/' || urlPath === '') {
            urlPath = '/index.html';
        }
        const filePath = resolveFilePath([rendererRoot], urlPath);
        const response = await net.fetch('file://' + filePath);
        // Only packaged public fonts are readable from the opaque Word iframe.
        // Do not extend CORS access to app pages, local runtime or cloud API routes.
        if (/^\/office\/fonts\/[\w-]+\.(?:woff2?|ttf|otf)$/.test(urlPath)) {
            const headers = new Headers(response.headers);
            headers.set('Access-Control-Allow-Origin', '*');
            headers.set('Cache-Control', 'public, max-age=31536000, immutable');
            return new Response(response.body, {
                status: response.status,
                statusText: response.statusText,
                headers,
            });
        }
        return response;
    });
}
