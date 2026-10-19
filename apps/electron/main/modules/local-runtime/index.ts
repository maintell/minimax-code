import { DEFAULT_COLLECTION_POLICY, parseCollectionPolicy } from "@mavis/shared/collection-policy";
import { createCollectionPolicyMatcher } from "@mavis/shared/collection-policy/matcher";
import { resolveSessionClioCaptureEnabled } from "@mavis/shared/session-clio";
import { parseRunawayGuardOverride } from "@mavis/config";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { mkdir, writeFile, rm } from "node:fs/promises";
import * as path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { app, BrowserWindow } from "electron";
import { resetConfig, getConfig, writeLocalRuntimeAuthContext, readLocalRuntimeAuthContext } from "@mavis/config";
import * as ws_1 from "ws";
import logger from "../../utils/logger";
import { DOMAIN_URL, IPC_CHANNELS } from "../../config/constants";
import { resolveDesktopPromptConfigKey } from "../../config/prompt-config-key";
import { buildEmbeddedBrowserToolAdapter } from "../browser/browser-tool-adapter";
import { openManagedMiniAppSurface, closeManagedMiniAppSurface } from "../browser/miniapp-surface";
import { resolveLocalRuntimeDataDir, LOCAL_RUNTIME_DATA_DIR_SOURCE_ENV } from "./data-dir";
import { bootstrapLoginShellEnv } from "./login-shell-env";
import { resolveElectronNetFetch } from "./electron-net-fetch";
import { prepareLocalRuntimeTestDataIsolation } from "./test-data-clone";
import { resolveLocalRuntimeLaunchPlan } from "./test-data-isolation";
import { pcm16LeToWav, consumeAmadeusAsrSse } from "./amadeus-asr";
import { resolveAmadeusProxyBaseURL, issueAmadeusProxySessionToken, postAmadeusProxyWav } from "./asr-proxy-http";
import { setUtilityRuntimeRoutingContext, ensureUtilityRuntimeStarted, getUtilityRuntimeStartupToken, stopUtilityRuntime, isUtilityRuntimeReady, getUtilityRuntimeTerminalFailure, getUtilityRuntimeFailReason, fetchViaUtilityRuntime, setUtilityRuntimeAuthContext, setUtilityRuntimeContextWindowUsageEnabled, setUtilityRuntimeRunawayGuardConfig, setUtilityRuntimeToolResultCompactionConfig, setUtilityRuntimeCollectionPolicy, registerUtilityRuntimeMainHooks } from "./utility";
export { ensureComputerUseUtilityStarted } from "./utility";

export { releaseComputerUseLease } from "./utility";

let localRuntimeModulePromise = null;
let httpServer = null;
let httpPort = null;
let localRuntimeStartupToken = null;
let localRuntimeSidecarFailReason = null;
let localAsrWebSocketServer = null;
let authContext = { authState: 'logged_out' };
let authContextRevision = 0;
let activeLocalRuntimeDataDir = null;
let sourceLocalRuntimeDataDir = null;
let previousMinimaxDataDir;
let previousLocalRuntimeDataDirSource;
let minimaxDataDirOverridden = false;
let localRuntimeDataDirSourceOverridden = false;
let deferredAuthContextPersistencePending = false;
let authContextPersistence = 'persistent';
let startupExecutionPolicy = 'enabled';
let swimLaneListenerRegistered = false;
let contextWindowUsageEnabled = true;
let runawayGuardConfig = {};
let toolResultCompactionConfig = {};
/**
 * Effective collection policy. Seeded from the built-in policy, restored from
 * the persisted last-valid document on cold start, and only replaced by an
 * Apollo payload that parses. A rejected payload or a failed config fetch can
 * therefore never widen collection back to "no excludes".
 */
let collectionPolicy = DEFAULT_COLLECTION_POLICY;
/** Deterministic identity of {@link collectionPolicy}; computed on first use. */
let collectionPolicyVersion;
/** True once this process adopted a policy from disk or from Apollo. */
let collectionPolicyRestored = false;
let managedRoutingContext;
let localRuntimeAuthRecovery;
const activeHttpAbortControllers = new Set();
const activeHttpSockets = new Set();
const activeAsrUpgradeSockets = new Set();
const ASR_API_PREFIX = '/mavis/api/audio/asr/';
const ASR_API_ROOT = '/mavis/api/audio/asr';
const ASR_STREAM_PATH = `${ASR_API_ROOT}/stream`;
const BROWSER_ASR_WS_SUBPROTOCOL = 'asr.browser.v1';
// Legacy opaque/WS credential keys. Amadeus uses a gateway-issued short JWT
// over HTTP+SSE instead, so these values must still be stripped on startup.
const LEGACY_ASR_PROXY_TOKEN_ENV = 'ASR_PROXY_TOKEN';
const LEGACY_ASR_PROXY_JWT_SECRET_ENV = 'ASR_PROXY_JWT_SECRET';
const LEGACY_ASR_TENANT_ID_ENV = 'ASR_TENANT_ID';
const DESKTOP_SERVICE_API_PREFIX = '/minimax-desktop/api';
/**
 * Capture defaults on for CN builds and off for EN builds: the overseas
 * ingest chain (session_clio server config + clio worker) is not deployed,
 * so a default-on EN client would only feed the outbox permanent rejections.
 * An explicit MAVIS_SESSION_CLIO_ENABLED override still flips either
 * default. Resolved lazily (not as a module constant) because
 * bootstrapManagedRuntimeEnv derives MAVIS_REGION from the build locale
 * after this module is imported. The utility process still applies the
 * user's dataContribution setting.
 */
function desktopSessionClioEnabled() {
    return resolveSessionClioCaptureEnabled(process.env.MAVIS_SESSION_CLIO_ENABLED, runtimeRegion() === 'cn');
}
const BUILD_ENV_TO_MAVIS = {
    dev: 'test',
    development: 'test',
    test: 'test',
    staging: 'staging',
    prod: 'prod',
    production: 'prod',
};
async function bootstrapManagedRuntimeEnv() {
    const storage = await import('../../ipc/storage.ipc');
    const desktopConfig = storage.getDesktopConfig();
    const { language, swimLaneName } = desktopConfig;
    contextWindowUsageEnabled = desktopConfig.contextWindowUsageEnabled !== false;
    restorePersistedCollectionPolicy(desktopConfig.collectionPolicy);
    if (language === 'en' || language === 'zh') {
        process.env.MAVIS_ELECTRON_LOCALE = language;
    }
    const pluginCloudLane = swimLaneName?.trim();
    if (pluginCloudLane)
        process.env.MAVIS_PLUGIN_CLOUD_LANE = pluginCloudLane;
    else
        delete process.env.MAVIS_PLUGIN_CLOUD_LANE;
    // ── Fix app-derived Mavis env BEFORE login shell bootstrap so that
    //    stale MAVIS_* values from the user's shell profile cannot override
    //    the build-time configuration (region / build-env / CA). ──
    if (!process.env.MAVIS_REGION) {
        const locale = process.env.NEXT_PUBLIC_LOCALE || 'en';
        process.env.MAVIS_REGION = locale === 'zh' ? 'cn' : 'en';
    }
    if (!process.env.MAVIS_BUILD_ENV) {
        const buildEnv = process.env.NEXT_PUBLIC_BUILD_ENV || 'test';
        process.env.MAVIS_BUILD_ENV = BUILD_ENV_TO_MAVIS[buildEnv] ?? 'test';
    }
    if (!process.env.NODE_USE_SYSTEM_CA) {
        process.env.NODE_USE_SYSTEM_CA = '1';
    }
    delete process.env.ELECTRON_RUN_AS_NODE;
    // ── Now inherit the user's login shell PATH / toolchain env.
    //    Variables already set above are protected by the "skip if defined"
    //    guard in mergeLoginShellEnv(). ──
    bootstrapLoginShellEnv();
    // Electron 38 + Node 22 on macOS occasionally times out / `ENOTFOUND`s on
    // libuv `getaddrinfo` for IPv6-preferred hosts (e.g. `open.feishu.cn`).
    // Forcing IPv4-first on the Node DNS resolver matches the behaviour of
    // pure-terminal Node and unblocks the Feishu SDK's long-connection
    // bootstrap (`POST /callback/ws/endpoint`). The setting only narrows the
    // result order — A records still resolve as before.
    try {
        const dns = require('node:dns');
        dns.setDefaultResultOrder?.('ipv4first');
    }
    catch {
        /* setDefaultResultOrder is best-effort — fall back to the default order. */
    }
    // Keep the utility process on the same managed-backend lane as Electron
    // main. The lane snapshot is updated independently from auth rotations and
    // is normalized by the shared lightweight routing helper.
    try {
        const routing = await importEsm('@mavis/agent-tools/desktop/managed-routing');
        const applyRoutingContext = (lane) => {
            managedRoutingContext = routing.normalizeManagedBackendRoutingContext(lane, process.env.MAVIS_BUILD_ENV);
            setUtilityRuntimeRoutingContext(managedRoutingContext);
        };
        applyRoutingContext(storage.getDesktopConfig().swimLaneName);
        if (!swimLaneListenerRegistered && typeof storage.onSwimLaneNameChanged === 'function') {
            storage.onSwimLaneNameChanged((nextLane) => applyRoutingContext(nextLane));
            swimLaneListenerRegistered = true;
        }
    }
    catch {
        logger.warn('[LocalRuntime] managed routing lane bootstrap unavailable');
    }
}
function readNonEmptyEnv(key) {
    const value = process.env[key]?.trim();
    return value && value.length > 0 ? value : undefined;
}
function resolveMainFetch() {
    return resolveElectronNetFetch() ?? fetch;
}
function currentManagedRoutingHeaders() {
    const lane = managedRoutingContext?.bedrockLane?.trim();
    if (!lane)
        return undefined;
    return { lane, bedrock_lane: lane, 'bedrock-lane': lane };
}
function removeLocalAsrProxyRuntimeSecretsFromEnv() {
    // Retained for defense-in-depth: the new HTTP proxy path never consumes
    // long-lived opaque or shared-secret credentials from the environment.
    delete process.env[LEGACY_ASR_PROXY_TOKEN_ENV];
    delete process.env[LEGACY_ASR_PROXY_JWT_SECRET_ENV];
    delete process.env[LEGACY_ASR_TENANT_ID_ENV];
}
function consumeLocalAsrProxyRuntimeSecretsFromEnv() {
    // Seed / Qwen providers were retired; there is no upstream token to
    // adopt. We keep this call sequenced with utility fork preparation so
    // any leaked value in `process.env` is removed before the child forks.
    removeLocalAsrProxyRuntimeSecretsFromEnv();
}
function clearLocalAsrRuntimeSecrets() {
    // Amadeus is authenticated per-request from the Electron main process;
    // there is no cached opaque token to clear. Retained as a no-op for
    // call-site compatibility with the existing shutdown / restart paths.
}
function resolveBundledSessionTransferClient() {
    const override = readNonEmptyEnv('MAVIS_SESSION_TRANSFER_CLIENT');
    if (override)
        return override;
    const binaryName = process.platform === 'win32'
        ? 'mavis-session-transfer-client.exe'
        : 'mavis-session-transfer-client';
    const platformDirectory = `${process.platform}-${process.arch}`;
    const proc = process;
    const roots = [
        ...(process.versions.electron && proc.resourcesPath
            ? [path.join(proc.resourcesPath, 'resources')]
            : []),
        path.join(app.getAppPath(), 'resources'),
    ];
    for (const root of roots) {
        const candidate = path.join(root, 'session-transfer', platformDirectory, binaryName);
        if (existsSync(candidate))
            return candidate;
    }
    return undefined;
}
function hydrateUtilitySessionTransferProcessEnv() {
    const binary = resolveBundledSessionTransferClient();
    if (binary)
        process.env.MAVIS_SESSION_TRANSFER_CLIENT = binary;
    else
        delete process.env.MAVIS_SESSION_TRANSFER_CLIENT;
    process.env.MAVIS_SESSION_RESULT_DOWNLOADS_DIR = app.getPath('downloads');
}
function importEsm(specifier) {
    if (process.env.VITEST === 'true') {
        return import(specifier);
    }
    // eslint-disable-next-line no-new-func -- Preserve native dynamic import in Electron's CJS main process.
    const dynamicImport = new Function('specifier', 'return import(specifier)');
    return dynamicImport(specifier);
}
function loadLocalRuntimeModule() {
    if (!localRuntimeModulePromise) {
        localRuntimeModulePromise = importEsm('@mavis/local-runtime-v2');
    }
    return localRuntimeModulePromise;
}
function isDiagnosticSidecarEnabled() {
    return process.env.MAVIS_ELECTRON_ENABLE_DIAGNOSTIC_SIDECAR === '1';
}
function isElectronDiagnosticsProviderEnabled() {
    if (process.env.VITEST === 'true')
        return false;
    return process.env.NODE_ENV === 'development' || isDiagnosticSidecarEnabled();
}
async function maybeCreateElectronDiagnosticsProvider() {
    if (!isElectronDiagnosticsProviderEnabled())
        return undefined;
    const mod = await import('../diagnostics/electron-diagnostics-provider');
    return mod.createElectronDiagnosticsProvider();
}
function diagnosticSidecarManifestFile() {
    const manifest = process.env.MAVIS_ELECTRON_DIAGNOSTIC_MANIFEST?.trim();
    return manifest && manifest.length > 0 ? manifest : null;
}
function isLocalRuntimePath(url) {
    return (!!url &&
        (url.startsWith('/mavis/') ||
            url === '/archon/api/v1' ||
            url.startsWith('/archon/api/v1/') ||
            url === DESKTOP_SERVICE_API_PREFIX ||
            url.startsWith(`${DESKTOP_SERVICE_API_PREFIX}/`)));
}
function isAsrApiPath(pathname) {
    return pathname === ASR_API_ROOT || pathname.startsWith(ASR_API_PREFIX);
}
function isAsrStreamPath(pathname) {
    return pathname === ASR_STREAM_PATH;
}
function mapLocalRuntimeUrl(reqUrl) {
    const url = new URL(reqUrl || '/', `http://127.0.0.1:${httpPort ?? 0}`);
    if (url.pathname === '/archon/api/v1') {
        url.pathname = '/mavis/api';
    }
    else if (url.pathname.startsWith('/archon/api/v1/')) {
        url.pathname = `/mavis/api/${url.pathname.slice('/archon/api/v1/'.length)}`;
    }
    return url.toString();
}
function mapLocalRuntimePath(reqUrl) {
    const url = new URL(mapLocalRuntimeUrl(reqUrl));
    return `${url.pathname}${url.search}`;
}
function webHeadersFromNode(req) {
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
        if (Array.isArray(value)) {
            for (const item of value)
                headers.append(key, item);
        }
        else if (value !== undefined) {
            headers.set(key, value);
        }
    }
    return headers;
}
async function writeWebResponse(response, res) {
    const headers = {};
    response.headers.forEach((value, key) => {
        headers[key] = value;
    });
    if ((headers['content-type'] || '').includes('text/event-stream')) {
        headers['cache-control'] = 'no-cache';
        headers['x-accel-buffering'] = 'no';
    }
    res.writeHead(response.status, headers);
    if (!response.body) {
        res.end();
        return;
    }
    await pipeline(Readable.fromWeb(response.body), res);
}
async function handleHttpRequest(req, res) {
    if (!isLocalRuntimePath(req.url)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'local_runtime_route_not_found' }));
        return;
    }
    const mappedPath = mapLocalRuntimePath(req.url);
    if (isAsrApiPath(new URL(`http://127.0.0.1${mappedPath}`).pathname)) {
        await proxyAsrHttpRequest(req, res, mappedPath);
        return;
    }
    const method = req.method || 'GET';
    const abortController = new AbortController();
    const abort = () => abortController.abort();
    activeHttpAbortControllers.add(abortController);
    req.once('aborted', abort);
    res.once('close', abort);
    const init = {
        method,
        headers: webHeadersFromNode(req),
        signal: abortController.signal,
    };
    if (method !== 'GET' && method !== 'HEAD') {
        init.body = req;
        init.duplex = 'half';
    }
    try {
        // The diagnostic listener is main-owned, but the business runtime is
        // always hosted by the utility process. Keep this sidecar as a transport
        // adapter only; it must never instantiate a second local-runtime host.
        const response = await handleLocalRuntimeRequest(new Request(mapLocalRuntimeUrl(req.url), init));
        await writeWebResponse(response, res);
    }
    finally {
        activeHttpAbortControllers.delete(abortController);
        req.off('aborted', abort);
        res.off('close', abort);
    }
}
function writeJson(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
}
function readString(value) {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}
function normalizeLocalAsrMode(value) {
    // Seed / Qwen providers were retired. The daemon only accepts the
    // Amadeus mode now; anything else (including a missing / legacy 'auto'
    // or 'seed' value) is rejected as an invalid open frame.
    const mode = typeof value === 'string' && value.length > 0 ? value.toLowerCase() : '';
    return mode === 'amadeus' ? 'amadeus' : null;
}
async function resolveLocalAsrConfigSnapshot() {
    // Electron can switch MAVIS_DATA_DIR in tests and real-user dev smoke runs;
    // reload before ASR reads so this bridge follows the active profile.
    resetConfig();
    const asr = getConfig().asr;
    return { enabled: asr.enabled !== false };
}
async function buildLocalAsrStatus() {
    const asr = await resolveLocalAsrConfigSnapshot();
    // Amadeus is authenticated per-request from the Electron main process
    // and needs no live readyz probe here — the /audio/asr/status route
    // now just reports the master switch and the sole remaining provider.
    return {
        enabled: asr.enabled,
        provider: 'amadeus',
        ...(asr.enabled ? {} : { reason: 'Cloud ASR is disabled by asr.enabled=false.' }),
    };
}
function runtimeRegion() {
    return process.env.MAVIS_REGION === 'cn' ? 'cn' : 'en';
}
function localAsrError(code, message) {
    const err = new Error(message);
    err.code = code;
    return err;
}
function rawDataToBuffer(data) {
    if (Buffer.isBuffer(data))
        return data;
    if (Array.isArray(data))
        return Buffer.concat(data);
    return Buffer.from(data);
}
function rawDataToString(data) {
    return rawDataToBuffer(data).toString('utf-8');
}
async function proxyAsrHttpRequest(req, res, mappedPath) {
    const pathname = new URL(`http://127.0.0.1${mappedPath}`).pathname;
    if ((req.method ?? 'GET') === 'GET' && pathname === `${ASR_API_ROOT}/status`) {
        writeJson(res, 200, await buildLocalAsrStatus());
        return;
    }
    writeJson(res, 501, {
        error: 'LOCAL_ASR_WEBSOCKET_REQUIRED',
        message: 'Electron clean runtime exposes ASR through /audio/asr/stream WebSocket only.',
        provider: 'local-runtime',
    });
}
async function handleAsrUpgrade(req, socket, head) {
    const mappedPath = mapLocalRuntimePath(req.url);
    if (!isAsrStreamPath(new URL(`http://127.0.0.1${mappedPath}`).pathname)) {
        socket.destroy();
        return;
    }
    activeAsrUpgradeSockets.add(socket);
    socket.once('close', () => {
        activeAsrUpgradeSockets.delete(socket);
    });
    handleLocalAsrUpgrade(req, socket, head);
}
function getLocalAsrWebSocketServer() {
    if (!localAsrWebSocketServer) {
        localAsrWebSocketServer = new ws_1.WebSocketServer({
            noServer: true,
            handleProtocols: (protocols) => protocols.has(BROWSER_ASR_WS_SUBPROTOCOL) ? BROWSER_ASR_WS_SUBPROTOCOL : false,
        });
    }
    return localAsrWebSocketServer;
}
function handleLocalAsrUpgrade(req, socket, head) {
    if (!isAuthorizedLocalAsrUpgrade(req)) {
        rejectLocalAsrUpgrade(socket);
        return;
    }
    getLocalAsrWebSocketServer().handleUpgrade(req, socket, head, (ws) => {
        routeLocalAsrBrowserWebSocket(ws);
    });
}
function isAuthorizedLocalAsrUpgrade(req) {
    const requestToken = readLocalAsrRuntimeToken(req);
    if (localRuntimeStartupToken && requestToken === localRuntimeStartupToken)
        return true;
    const origin = req.headers.origin;
    return typeof origin === 'string' && isTrustedLocalAsrOrigin(origin);
}
function readLocalAsrRuntimeToken(req) {
    const headerToken = readFirstHeader(req, 'x-mavis-runtime-token') ??
        readFirstHeader(req, 'x-mavis-startup-token') ??
        readFirstHeader(req, 'x-local-runtime-startup-token');
    if (headerToken)
        return headerToken;
    try {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        return (url.searchParams.get('startupToken') ?? url.searchParams.get('runtimeToken') ?? undefined);
    }
    catch {
        return undefined;
    }
}
function readFirstHeader(req, name) {
    const value = req.headers[name];
    if (Array.isArray(value))
        return value[0];
    return typeof value === 'string' && value ? value : undefined;
}
function isTrustedLocalAsrOrigin(origin) {
    try {
        const url = new URL(origin);
        return url.protocol === 'app:' || isTrustedLocalAsrDevOrigin(url);
    }
    catch {
        return false;
    }
}
function isTrustedLocalAsrDevOrigin(url) {
    if (process.env.NODE_ENV === 'production')
        return false;
    if (url.protocol !== 'http:')
        return false;
    const expectedPort = Number.parseInt(process.env.MAVIS_ELECTRON_DEV_PORT || '3100', 10);
    if (!Number.isFinite(expectedPort) || expectedPort <= 0)
        return false;
    if (Number.parseInt(url.port || '80', 10) !== expectedPort)
        return false;
    return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
}
function rejectLocalAsrUpgrade(socket) {
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    socket.destroy();
}
function parseLocalAsrBrowserFramePayload(parsed) {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        return null;
    const type = parsed.type;
    if (type !== 'open' && type !== 'stop')
        return null;
    return parsed;
}
function parseLocalAsrBrowserFrame(data) {
    return parseLocalAsrBrowserFramePayload(JSON.parse(rawDataToString(data)));
}
function createLocalAsrClientSession(clientTransport) {
    const localSessionId = `local-asr-${randomUUID()}`;
    let openStarted = false;
    let stopStarted = false;
    let amadeusPcmChunks = [];
    let amadeusPcmBytes = 0;
    let amadeusAbortController = null;
    let finalized = false;
    const cleanup = () => {
        if (finalized)
            return;
        finalized = true;
        amadeusAbortController?.abort();
        amadeusAbortController = null;
        amadeusPcmChunks = [];
        amadeusPcmBytes = 0;
    };
    const closeBrowser = (code = 1000, reason = '') => {
        clientTransport.close(code, reason.slice(0, 120));
    };
    const failBrowser = (err, closeCode = 1011) => {
        const error = err instanceof Error ? err : new Error(String(err));
        clientTransport.sendFrame({
            type: 'error',
            provider: 'amadeus',
            code: error.code ?? 'AMADEUS_ASR_ERROR',
            message: error.message,
        });
        cleanup();
        closeBrowser(closeCode, error.message);
    };
    const receiveFrame = (frame) => {
        void (async () => {
            if (finalized)
                return;
            if (frame.type === 'open') {
                if (openStarted) {
                    failBrowser(localAsrError('BAD_REQUEST', 'ASR WebSocket session already opened'), 1008);
                    return;
                }
                const mode = normalizeLocalAsrMode(frame.mode);
                if (!mode) {
                    failBrowser(localAsrError('BAD_REQUEST', `Invalid mode='${String(frame.mode)}'. Expected: amadeus.`), 1008);
                    return;
                }
                openStarted = true;
                const asr = await resolveLocalAsrConfigSnapshot();
                if (!asr.enabled) {
                    failBrowser(localAsrError('FEATURE_DISABLED', 'Cloud ASR is disabled by asr.enabled=false.'));
                    return;
                }
                if (finalized || !clientTransport.isOpen())
                    return;
                clientTransport.sendFrame({
                    type: 'connected',
                    sessionId: localSessionId,
                    provider: 'amadeus',
                    lifecycle: 'per-utterance',
                    chunkMs: 200,
                });
                return;
            }
            if (stopStarted)
                return;
            stopStarted = true;
            const pcm = amadeusPcmChunks.length > 0 ? Buffer.concat(amadeusPcmChunks) : Buffer.alloc(0);
            const wav = pcm16LeToWav(pcm);
            const requestController = new AbortController();
            amadeusAbortController = requestController;
            try {
                const userToken = authContext.accessToken?.trim();
                if (!userToken) {
                    throw localAsrError('AUTH_REQUIRED', 'Please sign in before using voice input.');
                }
                const managedBaseURL = DOMAIN_URL.replace(/\/+$/, '');
                const proxyBaseURL = resolveAmadeusProxyBaseURL(readNonEmptyEnv('ASR_PROXY_BASE_URL'), managedBaseURL);
                const routingHeaders = currentManagedRoutingHeaders();
                const sessionCredential = await issueAmadeusProxySessionToken({
                    fetchImpl: resolveMainFetch(),
                    baseURL: managedBaseURL,
                    userToken,
                    region: runtimeRegion() === 'cn' ? 'cn' : 'global',
                    routingHeaders,
                    signal: requestController.signal,
                });
                const response = await postAmadeusProxyWav({
                    fetchImpl: resolveMainFetch(),
                    baseURL: proxyBaseURL,
                    token: sessionCredential.token,
                    wav,
                    routingHeaders,
                    signal: requestController.signal,
                });
                const traceId = response.headers.get('Trace-Id') ?? 'unknown';
                logger.info(`[ASR:amadeus] proxy SSE response traceId=${traceId} status=${response.status} content-type=${response.headers.get('content-type') ?? 'unknown'}`);
                await consumeAmadeusAsrSse(response, (text, final, index) => {
                    if (finalized)
                        return;
                    logger.info(`[ASR:amadeus] parsed event index=${index ?? 'implicit'} finish=${final} textLength=${text.length}`);
                    clientTransport.sendFrame({
                        type: 'result',
                        text,
                        kind: final ? 'final' : 'partial',
                        provider: 'amadeus',
                        ...(typeof index === 'number' ? { seq: index } : {}),
                    });
                }, undefined, { signal: requestController.signal });
                if (finalized)
                    return;
                clientTransport.sendFrame({ type: 'close', provider: 'amadeus', reason: 'completed' });
                cleanup();
                closeBrowser(1000, 'completed');
            }
            catch (err) {
                if (err?.name === 'AbortError' || finalized)
                    return;
                failBrowser(localAsrError('AMADEUS_ASR_ERROR', err instanceof Error ? err.message : String(err)));
            }
        })().catch((err) => {
            if (!finalized)
                failBrowser(err);
        });
    };
    const receiveAudio = (data) => {
        if (finalized || stopStarted)
            return;
        const remaining = 16000000 - amadeusPcmBytes;
        if (data.length > remaining) {
            failBrowser(localAsrError('AUDIO_TOO_LONG', 'ASR audio exceeds the 500 second limit.'));
            return;
        }
        if (data.length > 0) {
            amadeusPcmChunks.push(Buffer.from(data));
            amadeusPcmBytes += data.length;
        }
    };
    return {
        receiveFrame,
        receiveAudio,
        close: () => cleanup(),
    };
}
function routeLocalAsrBrowserWebSocket(browserWs) {
    const session = createLocalAsrClientSession({
        isOpen: () => browserWs.readyState === ws_1.default.OPEN,
        sendFrame: (frame) => {
            if (browserWs.readyState !== ws_1.default.OPEN)
                return;
            browserWs.send(JSON.stringify(frame));
        },
        close: (code = 1000, reason = '') => {
            if (browserWs.readyState === ws_1.default.CLOSED || browserWs.readyState === ws_1.default.CLOSING) {
                return;
            }
            browserWs.close(code, reason);
        },
    });
    browserWs.on('message', (data, isBinary) => {
        if (isBinary) {
            session.receiveAudio(rawDataToBuffer(data));
            return;
        }
        let frame = null;
        try {
            frame = parseLocalAsrBrowserFrame(data);
        }
        catch {
            browserWs.close(1008, 'Malformed ASR WebSocket frame');
            return;
        }
        if (!frame) {
            browserWs.close(1008, 'Unsupported ASR WebSocket frame');
            return;
        }
        session.receiveFrame(frame);
    });
    browserWs.once('error', () => session.close());
    browserWs.once('close', () => session.close());
}
export function createLocalAsrNativeSession(input) {
    return createLocalAsrClientSession({
        isOpen: input.isOpen,
        sendFrame: input.sendFrame,
        close: (_code, reason = '') => input.close(reason),
    });
}
export function parseLocalAsrNativeControlFrame(frame) {
    return parseLocalAsrBrowserFramePayload(frame);
}
async function startLocalRuntimeServer() {
    if (!isDiagnosticSidecarEnabled())
        return;
    if (httpServer)
        return;
    const manifestFile = diagnosticSidecarManifestFile();
    if (!manifestFile) {
        throw new Error('MAVIS_ELECTRON_DIAGNOSTIC_MANIFEST is required when diagnostic sidecar is enabled');
    }
    httpServer = createServer((req, res) => {
        void handleHttpRequest(req, res).catch((err) => {
            if (res.destroyed || res.writableEnded)
                return;
            if (!res.headersSent) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
            }
            res.end(JSON.stringify({
                error: 'local_runtime_http_error',
                message: err instanceof Error ? err.message : String(err),
            }));
        });
    });
    httpServer.on('connection', (socket) => {
        activeHttpSockets.add(socket);
        socket.once('close', () => {
            activeHttpSockets.delete(socket);
        });
    });
    httpServer.on('upgrade', (req, socket, head) => {
        void handleAsrUpgrade(req, socket, head).catch(() => {
            socket.destroy();
        });
    });
    const server = httpServer;
    if (!server) {
        throw new Error('Local runtime server unavailable');
    }
    await new Promise((resolve, reject) => {
        const onError = (err) => {
            server.off('listening', onListening);
            reject(err);
        };
        const onListening = () => {
            server.off('error', onError);
            resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        const requested = Number(process.env.MAVIS_ELECTRON_DIAGNOSTIC_PORT || '0');
        server.listen(Number.isFinite(requested) && requested > 0 ? requested : 0, '127.0.0.1');
    });
    const address = httpServer.address();
    httpPort = typeof address === 'object' && address ? address.port : null;
    if (httpPort) {
        await mkdir(path.dirname(manifestFile), { recursive: true });
        await writeFile(manifestFile, JSON.stringify({
            port: httpPort,
            host: '127.0.0.1',
            pid: process.pid,
            owner: 'electron',
            mode: 'diagnostic',
            startedAt: new Date().toISOString(),
            startedAtMs: Date.now(),
            startupToken: localRuntimeStartupToken,
        }), 'utf-8');
    }
}
async function removeDiagnosticSidecarManifest() {
    const manifestFile = diagnosticSidecarManifestFile();
    if (!manifestFile)
        return;
    await rm(manifestFile, { force: true });
}
async function stopLocalRuntimeServer() {
    const server = httpServer;
    httpServer = null;
    httpPort = null;
    localRuntimeStartupToken = null;
    try {
        await removeDiagnosticSidecarManifest();
    }
    catch {
        /* ignore */
    }
    if (!server)
        return;
    for (const controller of activeHttpAbortControllers) {
        controller.abort();
    }
    activeHttpAbortControllers.clear();
    for (const socket of activeHttpSockets) {
        socket.destroy();
    }
    activeHttpSockets.clear();
    for (const socket of activeAsrUpgradeSockets) {
        socket.destroy();
    }
    activeAsrUpgradeSockets.clear();
    await closeLocalAsrWebSocketServer();
    await new Promise((resolve) => {
        server.close(() => resolve());
    });
}
async function closeLocalAsrWebSocketServer() {
    const server = localAsrWebSocketServer;
    localAsrWebSocketServer = null;
    if (!server)
        return;
    await new Promise((resolve) => {
        server.close(() => resolve());
    });
}
export function prepareLocalRuntime() {
    return (async () => {
        // Warmup, window creation and auth synchronization are automatic callers;
        // none of them is an explicit operator request to bypass recovery cooldown.
        const prepared = await ensureUtilityRuntimeStarted();
        if (!prepared)
            return false;
        try {
            if (isDiagnosticSidecarEnabled()) {
                localRuntimeStartupToken = getUtilityRuntimeStartupToken();
                if (!localRuntimeStartupToken) {
                    throw new Error('Utility runtime startup token unavailable');
                }
            }
            await startLocalRuntimeServer();
            localRuntimeSidecarFailReason = null;
            return true;
        }
        catch (error) {
            await stopLocalRuntimeServer();
            await stopUtilityRuntime();
            localRuntimeSidecarFailReason = error instanceof Error ? error.message : String(error);
            logger.error(`[LocalRuntime] diagnostic sidecar failed to start: ${localRuntimeSidecarFailReason}`);
            return false;
        }
    })();
}
export async function waitForLocalRuntime() {
    return prepareLocalRuntime();
}
export function isLocalRuntimeReady() {
    return isUtilityRuntimeReady();
}
export function getLocalRuntimeFailReason() {
    const terminal = getUtilityRuntimeTerminalFailure();
    if (terminal?.reasonCode === 'crash_loop') {
        return { type: 'runtime_crash_loop', message: terminal.message };
    }
    if (terminal?.reasonCode === 'memory_pressure' ||
        terminal?.reasonCode === 'runtime_unresponsive' ||
        terminal?.reasonCode === 'oom') {
        return { type: 'runtime_recovery_failed', message: terminal.message };
    }
    const message = getUtilityRuntimeFailReason() ?? localRuntimeSidecarFailReason;
    return message ? { type: 'startup_error', message } : null;
}
export async function handleLocalRuntimeRequest(request, options = {}) {
    // Renderer JS traffic rides its direct renderer<->utility port. Main-owned
    // callers use lazy per-consumer siblings so a long-lived app:// stream does
    // not delay Remote Control commands on the same utility process.
    return fetchViaUtilityRuntime(request, options.transportConsumer);
}
export async function stopLocalRuntime() {
    let stopResult = { status: 'exited' };
    try {
        await stopLocalRuntimeServer();
    }
    finally {
        try {
            stopResult = await stopUtilityRuntime();
        }
        finally {
            localRuntimeSidecarFailReason = null;
            clearLocalAsrRuntimeSecrets();
            restoreLocalRuntimeDataDirOverride();
        }
    }
    return stopResult;
}
export async function setLocalRuntimeAuthContext(data, options = {}) {
    const nextAuthContext = normalizeAuthContext(data);
    authContextPersistence = options.persistence ?? 'persistent';
    const authContextChanged = JSON.stringify(authContext) !== JSON.stringify(nextAuthContext);
    authContext = nextAuthContext;
    const nextAuthContextRevision = authContextChanged
        ? (authContextRevision += 1)
        : authContextRevision;
    if (authContextChanged) {
        clearLocalAsrRuntimeSecrets();
        const transitionContext = nextAuthContext.authState === 'logged_out'
            ? nextAuthContext
            : { authState: 'pending' };
        // Invalidate the old Utility identity before policy refresh or runtime
        // warmup can take noticeable time. This post is ordered ahead of the full
        // snapshot below; Utility handles the credential-free pending state
        // without repeating greeting retries.
        void setUtilityRuntimeAuthContext(transitionContext).catch((error) => logger.warn(`[LocalRuntime] Failed to publish pending auth context: ${String(error)}`));
    }
    if (options.prepare !== false) {
        await prepareLocalRuntime();
    }
    // Runtime startup may outlive a newer auth update. The latest revision owns
    // persistence, policy refresh, and the final Utility snapshot.
    if (nextAuthContextRevision !== authContextRevision)
        return { success: true };
    const persistenceDeferred = authContextPersistence === 'persistent' &&
        options.deferPersistenceUntilPrepared === true &&
        activeLocalRuntimeDataDir === null;
    if (authContextPersistence === 'memory-only') {
        deferredAuthContextPersistencePending = false;
    }
    else if (persistenceDeferred) {
        deferredAuthContextPersistencePending = true;
    }
    else if (persistLocalRuntimeAuthContext(nextAuthContext)) {
        deferredAuthContextPersistencePending = false;
    }
    if (authContextChanged && !persistenceDeferred) {
        // A newer identity rotation owns the final publication. Its pending
        // transition is already queued, so an older update must not restore
        // stale credentials after a rapid account/token switch.
        if (nextAuthContextRevision === authContextRevision &&
            nextAuthContext.authState !== 'pending') {
            await setUtilityRuntimeAuthContext(nextAuthContext);
        }
    }
    return { success: true };
}
export function configureLocalRuntimeAuthRecovery(recover) {
    localRuntimeAuthRecovery = recover;
}
export function syncLocalRuntimeAuthContext(data, options = {}) {
    return setLocalRuntimeAuthContext(data, options);
}
export function setLocalRuntimeContextWindowUsageEnabled(enabled) {
    contextWindowUsageEnabled = enabled;
    setUtilityRuntimeContextWindowUsageEnabled(enabled);
}
/** Stores a validated optional Apollo override for live updates and Utility restarts. */
export function setLocalRuntimeRunawayGuardConfig(value) {
    runawayGuardConfig = parseRunawayGuardOverride(value);
    setUtilityRuntimeRunawayGuardConfig(runawayGuardConfig);
}
/** Applies a validated, non-persistent Apollo threshold snapshot to the live Desktop runtime. */
export function setLocalRuntimeToolResultCompactionConfig(value) {
    toolResultCompactionConfig = normalizeToolResultCompactionConfig(value);
    setUtilityRuntimeToolResultCompactionConfig(toolResultCompactionConfig);
}
/**
 * Applies an Apollo collection-policy payload to the live Desktop runtime and
 * persists it as the new last-valid document.
 *
 * Returns `false` when the payload could not be parsed. Callers must treat that
 * as "keep what is already effective": an unreadable remote document, unlike an
 * absent one, must never clear excludes that are already denying collection.
 * A successful fetch whose key is absent arrives here as `undefined`, which the
 * shared parser resolves to the built-in policy — the one legitimate way back.
 */
export function setLocalRuntimeCollectionPolicyConfig(value) {
    const parsed = parseCollectionPolicy(value);
    if (!parsed) {
        logger.warn('[LocalRuntime] Rejected collection policy payload; keeping the last valid policy');
        return false;
    }
    // Apollo now owns the policy for the rest of this process, so a later fork's
    // env bootstrap must not re-seed it from a stale persisted document.
    collectionPolicyRestored = true;
    if (adoptCollectionPolicy(parsed)) {
        setUtilityRuntimeCollectionPolicy(collectionPolicy);
    }
    // Matching live state does not prove the last-valid document was persisted.
    persistCollectionPolicy(collectionPolicy);
    return true;
}
/**
 * Cold-start restore. Runs the persisted document through the same validator as
 * the hot path so a hand-edited or truncated store degrades to the built-in
 * policy rather than to an empty one, and never overrides a policy Apollo has
 * already delivered in this process.
 */
function restorePersistedCollectionPolicy(persisted) {
    if (collectionPolicyRestored)
        return;
    collectionPolicyRestored = true;
    const restored = parseCollectionPolicy(persisted);
    if (!restored) {
        logger.warn('[LocalRuntime] Persisted collection policy is invalid; using the built-in policy');
        return;
    }
    adoptCollectionPolicy(restored);
}
/**
 * Swaps in `next` when it differs from the effective policy. Identity is the
 * matcher's deterministic content hash, so a periodic refresh that returns the
 * same document is a no-op and cannot invalidate warm workspace state.
 */
function adoptCollectionPolicy(next) {
    const nextVersion = createCollectionPolicyMatcher(next).version;
    collectionPolicyVersion ?? (collectionPolicyVersion = createCollectionPolicyMatcher(collectionPolicy).version);
    if (nextVersion === collectionPolicyVersion)
        return false;
    collectionPolicy = next;
    collectionPolicyVersion = nextVersion;
    return true;
}
function persistCollectionPolicy(policy) {
    void import('../../ipc/storage.ipc').then((storage) => {
        // A newer policy may have been adopted while this import resolved.
        if (collectionPolicy !== policy)
            return;
        storage.setDesktopConfig({ collectionPolicy: policy });
    })
        .catch((error) => {
        logger.warn(`[LocalRuntime] Failed to persist collection policy: ${String(error)}`);
    });
}
function normalizeToolResultCompactionConfig(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        return {};
    const record = value;
    const enabled = typeof record.enabled === 'boolean' ? record.enabled : undefined;
    const maxInlineBytes = kibToPositiveSafeBytes(record.max_inline_kib);
    const mcpDetailsMaxInlineBytes = kibToPositiveSafeBytes(record.mcp_details_max_inline_kib);
    const watermarkBytes = kibToPositiveSafeBytes(record.watermark_kib);
    const minSavingsBytes = kibToPositiveSafeBytes(record.min_savings_kib);
    const minCandidateBytes = kibToPositiveSafeBytes(record.min_candidate_kib);
    const keepRecentRounds = typeof record.keep_recent_rounds === 'number' &&
        Number.isSafeInteger(record.keep_recent_rounds) &&
        record.keep_recent_rounds > 0
        ? record.keep_recent_rounds
        : undefined;
    return {
        ...(enabled !== undefined ? { enabled } : {}),
        ...(maxInlineBytes !== undefined ? { maxInlineBytes } : {}),
        ...(mcpDetailsMaxInlineBytes !== undefined ? { mcpDetailsMaxInlineBytes } : {}),
        ...(watermarkBytes !== undefined ? { watermarkBytes } : {}),
        ...(minSavingsBytes !== undefined ? { minSavingsBytes } : {}),
        ...(minCandidateBytes !== undefined ? { minCandidateBytes } : {}),
        ...(keepRecentRounds !== undefined ? { keepRecentRounds } : {}),
    };
}
function kibToPositiveSafeBytes(value) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0)
        return undefined;
    const bytes = value * 1024;
    return Number.isSafeInteger(bytes) ? bytes : undefined;
}
function normalizeAuthContext(data) {
    const identity = {
        ...(readOptionalString(data.loginEpoch)
            ? { loginEpoch: readOptionalString(data.loginEpoch) }
            : {}),
        ...(readOptionalString(data.accessToken)
            ? { accessToken: readOptionalString(data.accessToken) }
            : {}),
        ...(readOptionalString(data.realUserID)
            ? { realUserID: readOptionalString(data.realUserID) }
            : {}),
        ...(readOptionalString(data.userEmail)
            ? { userEmail: readOptionalString(data.userEmail) }
            : {}),
        ...(readOptionalString(data.userName) ? { userName: readOptionalString(data.userName) } : {}),
        ...(readOptionalString(data.subUserName)
            ? { subUserName: readOptionalString(data.subUserName) }
            : {}),
    };
    return {
        ...identity,
        authState: identity.accessToken && identity.realUserID
            ? 'authenticated'
            : identity.accessToken || identity.realUserID
                ? 'pending'
                : 'logged_out',
    };
}
function persistLocalRuntimeAuthContext(context) {
    try {
        writeLocalRuntimeAuthContext(activeLocalRuntimeDataDir ?? resolveLocalRuntimeDataDir(), context);
        return true;
    }
    catch (error) {
        logger.warn(`[LocalRuntime] Failed to persist auth context: ${String(error)}`);
        return false;
    }
}
function restoreLocalRuntimeDataDirOverride() {
    if (minimaxDataDirOverridden) {
        if (previousMinimaxDataDir === undefined) {
            delete process.env.MINIMAX_DATA_DIR;
        }
        else {
            process.env.MINIMAX_DATA_DIR = previousMinimaxDataDir;
        }
        resetConfig();
    }
    if (localRuntimeDataDirSourceOverridden) {
        if (previousLocalRuntimeDataDirSource === undefined) {
            delete process.env[LOCAL_RUNTIME_DATA_DIR_SOURCE_ENV];
        }
        else {
            process.env[LOCAL_RUNTIME_DATA_DIR_SOURCE_ENV] = previousLocalRuntimeDataDirSource;
        }
    }
    activeLocalRuntimeDataDir = null;
    sourceLocalRuntimeDataDir = null;
    previousMinimaxDataDir = undefined;
    previousLocalRuntimeDataDirSource = undefined;
    minimaxDataDirOverridden = false;
    localRuntimeDataDirSourceOverridden = false;
    startupExecutionPolicy = 'enabled';
}
function hydratePersistedLocalRuntimeAuthContext(dataDir) {
    try {
        const persisted = readLocalRuntimeAuthContext(dataDir);
        if (!persisted)
            return;
        const nextAuthContext = normalizeAuthContext(persisted);
        if (Object.keys(nextAuthContext).length === 0)
            return;
        // Keep any freshly synced in-memory fields (for example from the renderer
        // during the current process) while backfilling fields restored from disk on
        // cold start. Without this, a restarted packaged app can have a valid
        // local-runtime.auth.json but pass an empty authContext to managed-login LLM
        // calls until the renderer happens to sync tokens again.
        authContext = normalizeAuthContext({ ...nextAuthContext, ...authContext });
    }
    catch (error) {
        logger.warn(`[LocalRuntime] Failed to load persisted auth context: ${String(error)}`);
    }
}
function readOptionalString(value) {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}
// Utility-process hooks let the manager pull the live auth context and run
// main-side env bootstrap before each fork without importing this module
// (avoids an import cycle).
/**
 * Desktop eval ingest configuration.
 *
 * `sessionClioEnabled` is a separate switch from raw Eval capture on purpose:
 * raw Eval is sampled diagnostics that may be dropped, while Session Clio is a
 * durable QA record set. They share this transport and nothing else.
 */
export function resolveDesktopEvalCaptureConfig(packagedBuild = app.isPackaged, domainUrl = DOMAIN_URL, sessionClioEnabled = desktopSessionClioEnabled()) {
    if (!packagedBuild)
        return undefined;
    try {
        const endpoint = new URL('/mavis/api/v1/eval/steps/report', domainUrl);
        if (endpoint.protocol !== 'https:')
            return undefined;
        return { endpoint: endpoint.toString(), sessionClioEnabled };
    }
    catch {
        return undefined;
    }
}
function broadcastEmbeddedBrowserAgentAction(event) {
    for (const window of BrowserWindow.getAllWindows()) {
        if (window.isDestroyed?.() || window.webContents.isDestroyed?.())
            continue;
        window.webContents.send(IPC_CHANNELS.EMBEDDED_BROWSER_AGENT_ACTION, event);
    }
}
registerUtilityRuntimeMainHooks({
    getAuthContext: () => authContext,
    recoverAuthContext: (rejectedAccessToken, loginEpoch) => {
        const recover = localRuntimeAuthRecovery;
        if (!recover)
            throw new Error('Desktop auth recovery is unavailable');
        return recover(rejectedAccessToken, loginEpoch);
    },
    getPromptConfigKey: () => resolveDesktopPromptConfigKey({ packaged: app.isPackaged, appPath: app.getAppPath() }),
    getContextWindowUsageEnabled: () => contextWindowUsageEnabled,
    getRunawayGuardConfig: () => runawayGuardConfig,
    getToolResultCompactionConfig: () => toolResultCompactionConfig,
    getCollectionPolicy: () => collectionPolicy,
    getStartupExecutionPolicy: () => startupExecutionPolicy,
    getAppVersion: () => app.getVersion(),
    // Resolved lazily (and only on the rare failure that renders prose to the
    // user): `utils/tool` reaches the desktop config through ipc/storage.ipc,
    // which imports this module back. A static import would close that cycle and
    // drag the whole ipc/window graph into every consumer of local-runtime.
    isEnglishLocale: () => {
        try {
            return require('../../utils/tool').getIsEn();
        }
        catch {
            // Config store unreadable this early: the manager's own fallback picks
            // English rather than losing the failure report.
            logger.warn('[LocalRuntime] desktop language lookup failed; using English failure text');
            return true;
        }
    },
    getEvalCaptureConfig: resolveDesktopEvalCaptureConfig,
    broadcastRuntimeFailed: (failReason) => {
        // Mid-session terminal verdict: windows created before the latch already
        // resolved their one-shot startup RUNTIME_FAILED, so they only learn the
        // runtime is gone for good from this push.
        for (const window of BrowserWindow.getAllWindows()) {
            try {
                window.webContents.send(IPC_CHANNELS.RUNTIME_FAILED, failReason);
            }
            catch {
                logger.warn('[LocalRuntime] runtime-failed push to window failed');
            }
        }
    },
    getBrowserAdapter: () => buildEmbeddedBrowserToolAdapter({
        isEnabled: () => getConfig().beta.filePanelBrowser === true,
        onAgentAction: (event) => broadcastEmbeddedBrowserAgentAction(event),
    }),
    openMiniAppSurface: async ({ sessionId, pluginId, path, signal, isGenerationCurrent }) => {
        await openManagedMiniAppSurface({
            sessionId,
            pluginId,
            ...(path !== undefined ? { path } : {}),
            signal,
            isGenerationCurrent,
        });
        // openManagedMiniAppSurface has crossed the native-tab commit point.
        // Keep the renderer event aligned with that committed visible state.
        broadcastEmbeddedBrowserAgentAction({ sessionId, action: 'open_miniapp' });
    },
    closeMiniAppSurface: ({ pluginId, isGenerationCurrent }) => closeManagedMiniAppSurface({ pluginId, isGenerationCurrent }),
    getHostDiagnosticsProvider: () => maybeCreateElectronDiagnosticsProvider(),
    prepareForkEnv: async () => {
        // Keep ASR credentials in Electron main. The manager snapshots
        // process.env immediately after this hook. Consume them before the first
        // potentially failing await so a rejected bootstrap cannot leave them
        // available to a later fork attempt or any MCP stdio descendants.
        consumeLocalAsrProxyRuntimeSecretsFromEnv();
        try {
            await bootstrapManagedRuntimeEnv();
        }
        finally {
            // Login-shell inheritance may reintroduce stale ASR credentials after
            // the main-owned token was consumed. Clear only the env surface here so
            // those values cannot replace the token retained by Electron main.
            removeLocalAsrProxyRuntimeSecretsFromEnv();
        }
        const launchPlan = resolveLocalRuntimeLaunchPlan(process.env.NEXT_PUBLIC_BUILD_ENV, process.env.MAVIS_LOCAL_RUNTIME_ISOLATION);
        startupExecutionPolicy = launchPlan.startupExecutionPolicy;
        sourceLocalRuntimeDataDir ?? (sourceLocalRuntimeDataDir = resolveLocalRuntimeDataDir());
        const sourceDataDir = sourceLocalRuntimeDataDir;
        const isolation = launchPlan.dataDirMode === 'isolated-clone'
            ? await prepareLocalRuntimeTestDataIsolation({
                sourceDataDir,
                managedRoot: path.join(app.getPath('userData'), 'local-runtime-v2-isolation'),
            })
            : undefined;
        const dataDir = isolation?.dataDir ?? sourceDataDir;
        if (activeLocalRuntimeDataDir === null) {
            previousMinimaxDataDir = process.env.MINIMAX_DATA_DIR;
            previousLocalRuntimeDataDirSource = process.env[LOCAL_RUNTIME_DATA_DIR_SOURCE_ENV];
        }
        activeLocalRuntimeDataDir = dataDir;
        process.env.MINIMAX_DATA_DIR = dataDir;
        if (isolation) {
            process.env[LOCAL_RUNTIME_DATA_DIR_SOURCE_ENV] = 'test_isolation';
            localRuntimeDataDirSourceOverridden = true;
        }
        minimaxDataDirOverridden = true;
        resetConfig();
        logger.info(`[LocalRuntime] Launch plan: buildEnv=${process.env.NEXT_PUBLIC_BUILD_ENV ?? 'unset'}, ` +
            `dataDirMode=${launchPlan.dataDirMode}, policy=${launchPlan.startupExecutionPolicy}, ` +
            `clone=${isolation ? (isolation.created ? 'created' : 'reused') : 'disabled'}`);
        const memoryOnlyAuth = authContextPersistence === 'memory-only';
        const hasDeferredAuthContext = !memoryOnlyAuth && deferredAuthContextPersistencePending;
        if (!hasDeferredAuthContext && !memoryOnlyAuth) {
            hydratePersistedLocalRuntimeAuthContext(dataDir);
        }
        const authContextPersisted = memoryOnlyAuth || persistLocalRuntimeAuthContext(authContext);
        if (hasDeferredAuthContext && !authContextPersisted) {
            throw new Error('Failed to persist deferred local-runtime auth context');
        }
        if (hasDeferredAuthContext) {
            deferredAuthContextPersistencePending = false;
        }
        hydrateUtilitySessionTransferProcessEnv();
    },
});
