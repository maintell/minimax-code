/**
 * §8.2 — Electron control-plane for the RemoteControlProxy.
 *
 * Channels (registered via ipcMain.handle, mirroring archonChat/storage
 * *.ipc.ts style):
 *   rc:connect         renderer→main   proxy.connect() → RCConnectResult
 *   rc:disconnect      renderer→main   proxy.disconnect({unbind?})
 *   rc:get-status      renderer→main   RCStatus snapshot
 *   rc:status-changed  main→renderer   RCStatus push on every change
 *   rc:get-device-name renderer→main   optional stable host name for pairing metadata
 *   rc:binding-ready   renderer→main   fresh credentials → spin up / retry WS
 *   rc:refresh-binding main→renderer   ask renderer to re-sign GET /desktop/bindings
 *   rc:binding-lost    renderer→main   state=none → disconnect (only exit)
 *
 * Main-process lifecycle wiring:
 *   - lifecycle ipc-updater beforeQuit → proxy.disconnect() (keeps binding;
 *     the WS carries ctrl.disconnect_reason {code: app_quit})
 *   - storage.ipc onUserInfoChanged → if the logged-in user no longer matches
 *     state.bound_user_id, disconnect({unbind:true}) to clear the stale
 *     binding (account switch semantics, plan §8.2)
 */
import { app, net, BrowserWindow, ipcMain } from "electron";
import * as path from "node:path";
import { IPC_CHANNELS, DOMAIN_URL } from "../../config/constants";
import { isDev, isTest, isStaging } from "../../config/env";
import { getDesktopConfig, getUserInfo, onSwimLaneNameChanged, onUserInfoChanged } from "../../ipc/storage.ipc";
import { handleLocalRuntimeRequest, isLocalRuntimeReady } from "../local-runtime";
import { setRemoteAccessEnabled } from "../power";
import { createRcAuditLogger } from "./audit-log";
import { getHostDeviceName } from "./device-name";
import { fetchPrcBinding, parsePrcConfig } from "./prc-credentials";
import { registerRemoteSessionRcDeviceIdProvider } from "../local-runtime/utility/remote-session-broker";
import { createRemoteControlGlobalEventSource } from "./global-events";
let remoteControlBridgeModulePromise = null;
function importEsm(specifier) {
    if (process.env.VITEST === 'true') {
        return import(specifier);
    }
    // eslint-disable-next-line no-new-func -- Preserve native dynamic import in Electron's CJS main process.
    const dynamicImport = new Function('specifier', 'return import(specifier)');
    return dynamicImport(specifier);
}
function loadRemoteControlBridgeModule() {
    if (!remoteControlBridgeModulePromise) {
        remoteControlBridgeModulePromise = importEsm('@mavis/remote-control-bridge');
    }
    return remoteControlBridgeModulePromise;
}
async function loadGlobalEventTransport() {
    const [thriftClient, globalEvents] = await Promise.all([
        importEsm('@mavis/thrift-gen-client'),
        importEsm('@mavis/shared/global-events'),
    ]);
    return {
        createDesktopServiceClient: thriftClient.createDesktopServiceClient,
        decodeGlobalEventFrame: globalEvents.decodeGlobalEventFrame,
    };
}
const RC_CHANNELS = [
    IPC_CHANNELS.RC_CONNECT,
    IPC_CHANNELS.RC_DISCONNECT,
    IPC_CHANNELS.RC_GET_STATUS,
    IPC_CHANNELS.RC_CHECK_BINDING,
    IPC_CHANNELS.RC_REQUEST_CODE,
    IPC_CHANNELS.RC_GET_DEVICE_ID,
    IPC_CHANNELS.RC_GET_DEVICE_NAME,
    IPC_CHANNELS.RC_BINDING_READY,
    IPC_CHANNELS.RC_BINDING_LOST,
    IPC_CHANNELS.RC_MARK_UNBOUND,
    IPC_CHANNELS.RC_BEGIN_UNBIND,
    IPC_CHANNELS.RC_GET_PENDING_UNBIND,
    IPC_CHANNELS.RC_RESOLVE_UNBIND,
    IPC_CHANNELS.RC_PUBLISH_SESSION_COMPOSER_MODE,
];
export function resolveCurrentUserId(user) {
    const id = user.realUserID?.trim() || user.userID?.trim();
    return id ? id : undefined;
}
/** RC_BIZ_HEADERS="bedrock-lane:rc,foo:bar" → lane/debug headers (联调 only). */
export function parseExtraBizHeaders(raw) {
    return (raw ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .reduce((acc, pair) => {
        const i = pair.indexOf(':');
        if (i > 0)
            acc[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
        return acc;
    }, {});
}
/** Use only the explicitly configured non-production lane for RC WebSocket traffic. */
export function getRemoteControlWebSocketHeaders(swimLaneName) {
    const lane = typeof swimLaneName === 'string' ? swimLaneName.trim() : '';
    if (!(isDev || isTest || isStaging) || !lane)
        return {};
    return { lane, bedrock_lane: lane, 'bedrock-lane': lane };
}
export function parseByteSizeConfigValue(value) {
    if (typeof value === 'number') {
        return Number.isSafeInteger(value) && value > 0 ? value : undefined;
    }
    if (typeof value !== 'string')
        return undefined;
    const match = value.trim().match(/^(\d+)\s*(b|bytes?|k|kb|kib|m|mb|mib|g|gb|gib)?$/i);
    if (!match)
        return undefined;
    const amount = Number(match[1]);
    if (!Number.isSafeInteger(amount) || amount <= 0)
        return undefined;
    const unit = (match[2] ?? 'b').toLowerCase();
    const multiplier = unit === 'g' || unit === 'gb' || unit === 'gib'
        ? 1024 * 1024 * 1024
        : unit === 'm' || unit === 'mb' || unit === 'mib'
            ? 1024 * 1024
            : unit === 'k' || unit === 'kb' || unit === 'kib'
                ? 1024
                : 1;
    const bytes = amount * multiplier;
    return Number.isSafeInteger(bytes) && bytes > 0 ? bytes : undefined;
}
/**
 * PRC mode: an operator configured a self-hosted gateway URL + password, so the
 * main process signs its own binding instead of waiting for the renderer. The
 * operator is the only principal on that gateway, hence the fixed user id.
 */
const PRC_OPERATOR_USER_ID = 'prc:operator';
/**
 * Cap every PRC HTTP call well below the 60 s ticket TTL: a gateway that accepts
 * the connection but never answers must not wedge the single-flight guard. The
 * credential module reports the abort as a `network:*` failure.
 */
const PRC_FETCH_TIMEOUT_MS = 10_000;
/** Re-entry guard for every PRC connect attempt; cleared in `finally` so a
 *  failed attempt can retry on the next refresh instead of dead-locking. */
let prcConnecting = false;
/** One-shot startup thunk installed by buildDefaultProxy, run once by setup. */
let prcConnect: (() => Promise<void>) | null = null;
/**
 * Resolve the operator config: the persisted `remote_control_prc` block, with
 * `MC_RC_PRC_URL` / `MC_RC_PRC_PASSWORD` winning when both are present. Plain
 * `http:` carries the password in the clear, so it is only accepted when the
 * operator set `allowInsecureOrigin` explicitly; otherwise PRC mode stays off
 * and the bridge keeps its existing renderer-driven path.
 */
function resolvePrcConfig(logger) {
    // `getDesktopConfig()` is typed from its defaults, which do not list optional
    // extras like this one; read it as an untyped record and let the parser decide.
    const desktopConfig: Record<string, unknown> = getDesktopConfig();
    const fromFile = parsePrcConfig(desktopConfig.remote_control_prc);
    const envUrl = process.env.MC_RC_PRC_URL?.trim();
    const envPassword = process.env.MC_RC_PRC_PASSWORD?.trim();
    // The opt-in flag is a safety decision, not credential material: env
    // overrides replace the secret pair only and still honour the file's flag.
    const fromEnv = envUrl && envPassword
        ? parsePrcConfig({ url: envUrl, password: envPassword, allowInsecureOrigin: fromFile?.allowInsecureOrigin })
        : undefined;
    const config = fromEnv ?? fromFile;
    if (!config)
        return undefined;
    if (config.baseUrl.startsWith('http:') && !config.allowInsecureOrigin) {
        logger.warn('[rc.ipc] PRC disabled reason=insecure_origin scheme=http set remote_control_prc.allowInsecureOrigin=true to permit plaintext');
        return undefined;
    }
    return config;
}
/**
 * PRC-only fetch: bounded by `PRC_FETCH_TIMEOUT_MS`, combined with any caller
 * signal via `AbortSignal.any` so neither side is silently dropped.
 */
function createPrcFetchImpl() {
    return (input, init) => {
        const timeout = AbortSignal.timeout(PRC_FETCH_TIMEOUT_MS);
        const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
        return net.fetch(input instanceof URL ? input.toString() : input, { ...init, signal });
    };
}
/**
 * Fetch our own binding, cache it on the proxy and connect. Logs phase and
 * binding id only — never the password, the ticket or the URL query.
 */
async function connectToPrc(deps) {
    if (prcConnecting) {
        deps.logger.info('[rc.ipc] prc connect skipped reason=already_in_progress');
        return;
    }
    prcConnecting = true;
    try {
        deps.logger.info('[rc.ipc] prc connect start');
        const result = await fetchPrcBinding({
            config: deps.config,
            deviceId: deps.proxy.getDeviceId(),
            clientVersion: app.getVersion(),
            fetchImpl: createPrcFetchImpl(),
        });
        if (!result.ok) {
            // `error` is a controlled token (`network:*`, `http_<status>`,
            // `not_authenticated`, `not_bound`) built by the credential module.
            deps.logger.warn(`[rc.ipc] prc connect failed reason=${result.error}`);
            return;
        }
        const bindingId = result.credentials.binding_id;
        if (!deps.proxy.applyRendererCredentials(result.credentials)) {
            deps.logger.warn(`[rc.ipc] prc credentials rejected reason=stale_request_epoch binding_id=${bindingId}`);
            return;
        }
        const connected = await deps.proxy.connect();
        deps.logger.info(`[rc.ipc] prc connect settled phase=${connected.phase} binding_id=${bindingId}`);
    }
    catch (err) {
        // A thrown message may echo the request URL; keep only the error class.
        deps.logger.warn(`[rc.ipc] prc connect threw error=${err instanceof Error ? err.name : 'unknown'}`);
    }
    finally {
        prcConnecting = false;
    }
}
function buildDefaultProxy(logger, bridge) {
    const identity = new bridge.DeviceIdentityStore(path.join(app.getPath('userData'), 'remote-control', 'state.json'), logger);
    // A rebuild (hot reload) must not replay the previous configuration's
    // startup connect; setup installs a fresh thunk below when PRC is on.
    prcConnect = null;
    const prcConfig = resolvePrcConfig(logger);
    // Assigned right after construction: requestRendererRefresh only fires from
    // async proxy events, never during the constructor.
    let connectViaPrc = async () => {};
    const baseUrl = process.env.RC_BIZ_BASE_URL ?? DOMAIN_URL;
    const envHeaders = parseExtraBizHeaders(process.env.RC_BIZ_HEADERS);
    logger.info(`[rc.ipc] init baseUrl=${baseUrl} envHeaders=${Object.keys(envHeaders).join('|') || 'none'}`);
    const getExtraHeaders = () => {
        const headers = getRemoteControlWebSocketHeaders(getDesktopConfig().swimLaneName);
        // Pairing HTTP keeps the explicit debug-header escape hatch; WS never receives it.
        Object.assign(headers, envHeaders);
        return headers;
    };
    const getWebSocketHeaders = () => getRemoteControlWebSocketHeaders(getDesktopConfig().swimLaneName);
    const getRemoteControlFileContentMaxBytes = () => parseByteSizeConfigValue(getDesktopConfig().remote_control_file_content_max_bytes);
    const localRuntimeInvoke = (request) => handleLocalRuntimeRequest(request, { transportConsumer: 'remote-control' });
    const pairingClient = new bridge.PairingClient({
        baseUrl,
        getJwt: () => {
            logger.warn('[rc.ipc] getJwt: legacy SSO token projection is disabled under Shared OAuth; failing closed');
            return '';
        },
        // matrix Auth cross-check: `user_id` query common-param must equal the
        // token's auth_uid — desktop identity source is the same resolver the
        // bound-user bookkeeping uses (realUserID preferred).
        getUserId: () => resolveCurrentUserId(getUserInfo()),
        getDeviceId: () => identity.getDeviceId(),
        getPlatform: () => (process.platform === 'win32' ? 'win32' : 'darwin'),
        getAppVersion: () => app.getVersion(),
        getDeviceName: getHostDeviceName,
        getExtraHeaders,
        fetchImpl: ((input, init) => net.fetch(input instanceof URL ? input.toString() : input, init)),
        logger,
    });
    const rc = new bridge.RemoteControlProxy({
        identity,
        pairingClient,
        logger,
        clientVersion: app.getVersion(),
        isRuntimeHealthy: () => isLocalRuntimeReady(),
        // PRC is single-principal: the operator password is the only identity
        // there is, and the renderer never signs a binding in this mode.
        getCurrentUserId: () => (prcConfig ? PRC_OPERATOR_USER_ID : resolveCurrentUserId(getUserInfo())),
        getWebSocketHeaders,
        // Reverse loop: main can't sign GET /desktop/bindings, so ask the renderer to
        // re-sign and push credentials back (self-heal design §4.2). In PRC mode the
        // main process holds the password and signs the binding itself.
        requestRendererRefresh: () => {
            if (prcConfig) {
                void connectViaPrc();
                return;
            }
            broadcastRefreshBinding(logger);
        },
        onSessionComposerModeChange: broadcastSessionComposerMode,
        // Wave-2 commands ride the in-process localRuntime entrypoint. Global
        // Events use the same entrypoint behind a generated-client host adapter,
        // keeping Thrift/SSE details outside the host-neutral Bridge package.
        localRuntimeInvoke,
        globalEventSource: createRemoteControlGlobalEventSource(localRuntimeInvoke, loadGlobalEventTransport),
        getRemoteControlFileContentMaxBytes,
        // Wave-3 §4-3: send attachments land under userData before the daemon
        // sees them (filePath shape); net.fetch mirrors the pairing client.
        attachmentFetcher: bridge.createAttachmentFetcher({
            saveDir: path.join(app.getPath('userData'), 'remote-control', 'attachments'),
            fetchImpl: ((input, init) => net.fetch(input instanceof URL ? input.toString() : input, init)),
            logger,
        }),
    });
    if (prcConfig) {
        connectViaPrc = () => connectToPrc({ logger, config: prcConfig, proxy: rc });
        prcConnect = connectViaPrc;
    }
    return rc;
}
let activeProxy = null;
let activeLogger = null;
let teardownHooks = [];
export function getRemoteControlProxy() {
    return activeProxy;
}
function broadcastStatus(status) {
    for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
            win.webContents.send(IPC_CHANNELS.RC_STATUS_CHANGED, status);
        }
    }
}
function remoteAccessEnabled(status) {
    return status.binding_id !== undefined && status.phase !== 'unbound';
}
function handleRemoteControlStatus(status) {
    setRemoteAccessEnabled(remoteAccessEnabled(status));
    broadcastStatus(status);
}
function broadcastSessionComposerMode(change) {
    for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
            win.webContents.send(IPC_CHANNELS.RC_SESSION_COMPOSER_MODE_CHANGED, change);
        }
    }
}
/**
 * Ask every renderer to re-sign the binding via its axios pipeline (the main
 * process cannot sign GET /desktop/bindings). The resident RC daemon in the renderer
 * handles `rc:refresh-binding` and pushes the result back through
 * rc:binding-ready (bound) or rc:binding-lost (state=none). Broadcasting to
 * all windows is safe: checkBinding is idempotent and multi-window pushes are
 * debounced by RcConnection.retryNow (self-heal design §4.2/§7-2).
 */
function broadcastRefreshBinding(logger) {
    const windows = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed());
    logger.info(`[rc.ipc] broadcasting rc:refresh-binding to ${windows.length} window(s)`);
    for (const win of windows) {
        win.webContents.send(IPC_CHANNELS.RC_REFRESH_BINDING);
    }
}
/**
 * Register the RC bridge IPC surface and storage subscriptions.
 * A prebuilt proxy can be injected for tests; production builds the default.
 */
export async function setupRemoteControlBridgeIPC(proxy, logger, loadBridge = loadRemoteControlBridgeModule) {
    const log = logger ?? createRcAuditLogger();
    const rc = proxy ?? buildDefaultProxy(log, await loadBridge());
    // Only a default-built proxy can be in PRC mode; an injected one must not
    // inherit a previous build's configuration.
    const startPrc = proxy ? null : prcConnect;
    // PRC mode owns the binding: the operator password signs it, so the renderer
    // and the cloud account have no say over this proxy's lifecycle.
    const prcMode = startPrc !== null;
    activeProxy = rc;
    activeLogger = log;
    // The Runtime's mavis tool reads controlled devices' sessions as this desktop.
    registerRemoteSessionRcDeviceIdProvider(() => rc.getDeviceId());
    ipcMain.handle(IPC_CHANNELS.RC_CONNECT, async () => {
        log.info('[rc.ipc] rc:connect invoked');
        try {
            // PRC mode: only the gateway can mint a ticket, so `rc.connect()` alone
            // could never recover from a stop. Re-ticket through the same path the
            // refresh hook and startup use, then report the state it produced.
            if (prcMode) {
                await startPrc();
                return rc.getStatus();
            }
            return await rc.connect();
        }
        catch (err) {
            log.error(`[rc.ipc] rc:connect threw: ${err instanceof Error ? err.message : String(err)}`);
            return { phase: 'error' };
        }
    });
    ipcMain.handle(IPC_CHANNELS.RC_DISCONNECT, async (_event, opts) => {
        log.info(`[rc.ipc] rc:disconnect invoked unbind=${opts?.unbind === true}`);
        // PRC mode: a PRC binding id must never reach the cloud pairing client, so
        // the renderer's unbind flag degrades to a plain disconnect.
        if (prcMode && opts?.unbind === true) {
            log.info('[rc.ipc] rc:disconnect unbind skipped source=prc');
        }
        try {
            await rc.disconnect(opts?.unbind && !prcMode ? { unbind: true } : {});
            return { success: true };
        }
        catch (err) {
            log.error(`[rc.ipc] rc:disconnect threw: ${err instanceof Error ? err.message : String(err)}`);
            return { success: false, error: String(err) };
        }
    });
    ipcMain.handle(IPC_CHANNELS.RC_GET_STATUS, () => rc.getStatus());
    ipcMain.handle(IPC_CHANNELS.RC_GET_DEVICE_ID, () => {
        // Identity is created lazily inside getDeviceId() (identity.ensure()); no
        // extra server call needed. The previous implementation fired a fire-and-
        // forget `rc.checkBinding()` here which used the main-process token and
        // surfaced spurious 401s in the logs whenever the renderer asked for
        // device id (init / polling / requestBind all hit this).
        return rc.getDeviceId();
    });
    ipcMain.handle(IPC_CHANNELS.RC_GET_DEVICE_NAME, () => getHostDeviceName());
    ipcMain.handle(IPC_CHANNELS.RC_PUBLISH_SESSION_COMPOSER_MODE, async (_event, change) => {
        const sessionId = typeof change?.sessionId === 'string' ? change.sessionId.trim() : '';
        if (sessionId.length === 0 || !['default', 'goal', 'plan'].includes(change.mode)) {
            return false;
        }
        return rc.publishSessionComposerMode({ ...change, sessionId });
    });
    // rc:check-binding is intentionally NOT wired up — binding state lives on
    // the renderer (axios → archon_biz, uses the renderer's token). The main
    // process only owns WS lifecycle (connect/disconnect), so there is no
    // server-side check to expose here. Re-enable if the WS control plane ever
    // needs to consult /binding directly.
    ipcMain.handle(IPC_CHANNELS.RC_BINDING_READY, async (_event, payload) => {
        log.info(`[rc.ipc] rc:binding-ready invoked binding_id=${payload?.binding_id} producer_generation=${payload?.producer_generation ?? 'absent'} request_epoch=${payload?.request_epoch ?? 'absent'}`);
        // PRC credentials come from the gateway, not from the renderer. A renderer
        // that still checks the cloud binding would otherwise look like a same-
        // identity refresh (both sides report `prc:operator`) and silently replace
        // our ticket, so acknowledge and drop the payload before any validation.
        if (prcMode) {
            log.info(`[rc.ipc] rc:binding-ready ignored source=prc binding_id=${String(payload?.binding_id)}`);
            return { success: true, source: 'prc', ignored: true };
        }
        // 只有三个必填字段能否决整条凭据；producer_generation / request_epoch 这类
        // 可选字段即便畸形也不整条拒绝 —— 见下方「按未提供处理 + 留痕」。
        // 否则一个装饰性字段写错就能让桌面端永远连不上（§4.5.1 / §4.5.2）。
        if (typeof payload?.binding_id !== 'number' ||
            typeof payload?.ticket !== 'string' ||
            typeof payload?.endpoint !== 'string') {
            log.warn(`[rc.ipc] rc:binding-ready rejected reason=invalid_payload binding_id=${String(payload?.binding_id)}`);
            return { success: false, error: 'invalid payload' };
        }
        // 可选字段做类型校验后再透传：非法值一律按「未提供」处理，不能把
        // NaN/字符串塞进代次比较里造成误判（§4.5.1）。
        const producerGeneration = typeof payload.producer_generation === 'number' &&
            Number.isSafeInteger(payload.producer_generation)
            ? payload.producer_generation
            : undefined;
        if (payload.producer_generation !== undefined && producerGeneration === undefined) {
            log.warn(`[rc.ipc] rc:binding-ready producer_generation ignored reason=not_a_safe_integer raw=${String(payload.producer_generation)}`);
        }
        const requestEpoch = typeof payload.request_epoch === 'number' && Number.isSafeInteger(payload.request_epoch)
            ? payload.request_epoch
            : undefined;
        if (payload.request_epoch !== undefined && requestEpoch === undefined) {
            log.warn(`[rc.ipc] rc:binding-ready request_epoch ignored reason=not_a_safe_integer raw=${String(payload.request_epoch)}`);
        }
        try {
            // Cache the fresh credentials so the WS layer can resolve them via
            // the credential provider without re-querying /binding (which the
            // main process no longer does).
            const accepted = rc.applyRendererCredentials({
                binding_id: payload.binding_id,
                ticket: payload.ticket,
                endpoint: payload.endpoint,
                ...(producerGeneration !== undefined ? { producer_generation: producerGeneration } : {}),
                ...(requestEpoch !== undefined ? { request_epoch: requestEpoch } : {}),
            });
            if (!accepted) {
                log.warn(`[rc.ipc] rc:binding-ready rejected reason=stale_request_epoch binding_id=${payload.binding_id}`);
                return { success: false, error: 'stale request epoch' };
            }
            const result = await rc.connect();
            if (result.phase === 'error') {
                return { success: false, error: result.last_error?.message ?? 'connect failed' };
            }
            return { success: true };
        }
        catch (err) {
            log.error(`[rc.ipc] rc:binding-ready threw: ${err instanceof Error ? err.message : String(err)}`);
            return { success: false, error: String(err) };
        }
    });
    ipcMain.handle(IPC_CHANNELS.RC_BINDING_LOST, async () => {
        log.info('[rc.ipc] rc:binding-lost invoked (renderer reports state=none)');
        // PRC mode owns the binding: a cloud `state=none` says nothing about the
        // operator gateway, so it must not disconnect us.
        if (prcMode) {
            log.info('[rc.ipc] rc:binding-lost ignored source=prc');
            return { success: true, source: 'prc', ignored: true };
        }
        try {
            rc.onRendererBindingLost();
            return { success: true };
        }
        catch (err) {
            log.error(`[rc.ipc] rc:binding-lost threw: ${err instanceof Error ? err.message : String(err)}`);
            return { success: false, error: String(err) };
        }
    });
    ipcMain.handle(IPC_CHANNELS.RC_MARK_UNBOUND, async () => {
        log.info('[rc.ipc] rc:mark-unbound invoked (renderer issued the unbind HTTP call itself; main only clears local state)');
        // The renderer can only unbind the cloud binding; clearing local state
        // here would drop the operator's PRC binding with it.
        if (prcMode) {
            log.info('[rc.ipc] rc:mark-unbound ignored source=prc');
            return { success: true, source: 'prc', ignored: true };
        }
        try {
            rc.onRendererUnbound();
            return { success: true };
        }
        catch (err) {
            log.error(`[rc.ipc] rc:mark-unbound threw: ${err instanceof Error ? err.message : String(err)}`);
            return { success: false, error: String(err) };
        }
    });
    // ── producer 全删解绑的 request_id 幂等链路（方案 §4.5.4 / ADR-011 D12） ──
    // 持久化在 main（renderer 刷新会丢），HTTP 仍由 renderer 发（matrix gateway
    // 签名材料只在 renderer 的 axios 管线里，是硬约束）。
    ipcMain.handle(IPC_CHANNELS.RC_BEGIN_UNBIND, async () => {
        // Unbinding a PRC device belongs to the operator gateway (`POST
        // …/remote-control/unbind`, password-authenticated), not to the renderer:
        // fail loudly instead of writing a pending record nobody can resolve.
        if (prcMode) {
            log.warn('[rc.ipc] rc:begin-unbind rejected reason=prc_mode');
            return { success: false, error: 'prc_mode' };
        }
        try {
            const pending = rc.beginProducerUnbind();
            log.info(`[rc.ipc] rc:begin-unbind → request_id=${pending.request_id} attempts=${pending.attempts}`);
            return { success: true, pending };
        }
        catch (err) {
            log.error(`[rc.ipc] rc:begin-unbind threw: ${err instanceof Error ? err.message : String(err)}`);
            return { success: false, error: String(err) };
        }
    });
    ipcMain.handle(IPC_CHANNELS.RC_GET_PENDING_UNBIND, async () => {
        try {
            const pending = rc.getPendingProducerUnbind();
            if (pending) {
                log.info(`[rc.ipc] rc:get-pending-unbind → pending request_id=${pending.request_id} attempts=${pending.attempts} created_at_ms=${pending.created_at_ms}`);
            }
            else {
                log.debug('[rc.ipc] rc:get-pending-unbind → none');
            }
            return { success: true, ...(pending ? { pending } : {}) };
        }
        catch (err) {
            log.error(`[rc.ipc] rc:get-pending-unbind threw: ${err instanceof Error ? err.message : String(err)}`);
            return { success: false, error: String(err) };
        }
    });
    ipcMain.handle(IPC_CHANNELS.RC_RESOLVE_UNBIND, async (_event, payload) => {
        // Same rule as rc:begin-unbind: no renderer outcome may clear the PRC
        // binding, so neither `resolveProducerUnbind()` nor the proxy is touched.
        if (prcMode) {
            log.warn('[rc.ipc] rc:resolve-unbind rejected reason=prc_mode');
            return { success: false, error: 'prc_mode' };
        }
        const outcome = payload?.outcome;
        if (outcome !== 'confirmed' && outcome !== 'rejected') {
            // 只接受两种**确定**结果。超时/网络错误必须保持待确认，不能从这里溜进来。
            log.warn(`[rc.ipc] rc:resolve-unbind rejected reason=invalid_outcome raw=${String(outcome)} (timeouts must stay pending — §4.5.4)`);
            return { success: false, error: 'invalid outcome' };
        }
        const reason = typeof payload?.reason === 'string' ? payload.reason : 'unspecified';
        try {
            rc.resolveProducerUnbind(outcome, reason);
            return { success: true };
        }
        catch (err) {
            log.error(`[rc.ipc] rc:resolve-unbind threw: ${err instanceof Error ? err.message : String(err)}`);
            return { success: false, error: String(err) };
        }
    });
    ipcMain.handle(IPC_CHANNELS.RC_REQUEST_CODE, async () => {
        log.info('[rc.ipc] rc:request-code invoked');
        try {
            return await rc.requestPairingCode();
        }
        catch (err) {
            log.error(`[rc.ipc] rc:request-code threw: ${err instanceof Error ? err.message : String(err)}`);
            return rc.getStatus();
        }
    });
    // Keep-awake is effective only while this computer owns a producer binding.
    // Seed the power state before listening so hot reload/setup cannot inherit a
    // stale value from a previous proxy instance.
    setRemoteAccessEnabled(remoteAccessEnabled(rc.getStatus()));
    teardownHooks.push(rc.onStatusChange(handleRemoteControlStatus));
    // A lane change changes the WS routing destination only in non-production
    // environments. Production does not inject lane headers, so avoid a
    // pointless WS restart if a hidden/stale config value changes there.
    if (isDev || isTest || isStaging) {
        const unsubscribeSwimLaneChange = onSwimLaneNameChanged(() => {
            rc.onSwimLaneChanged();
        });
        teardownHooks.push(unsubscribeSwimLaneChange);
    }
    // Account switch / logout: a binding belongs to the user who paired it.
    const unsubscribeUserChange = onUserInfoChanged(() => {
        // PRC mode binds to the device/operator, not to the cloud session: the
        // bound user is `prc:operator`, so every login/logout would read as an
        // owner switch and tear down a connection the operator still wants.
        if (prcMode) {
            log.info('[rc.ipc] user identity changed; PRC mode ignores account changes action=none');
            return;
        }
        const state = rc.getBoundUserState();
        if (state.binding_id === undefined) {
            log.debug('[rc.ipc] user identity changed but no local binding; nothing to do action=none');
            return;
        }
        const userInfo = getUserInfo();
        if (Object.keys(userInfo).length === 0) {
            log.info(`[rc.ipc] user identity cleared; disconnecting binding_id=${state.binding_id}`);
            void rc.disconnect().catch((err) => {
                log.warn(`[rc.ipc] logout disconnect failed: ${err instanceof Error ? err.message : String(err)}`);
            });
            return;
        }
        const currentUserId = resolveCurrentUserId(userInfo);
        if (!currentUserId || !state.bound_user_id || currentUserId === state.bound_user_id) {
            log.debug(`[rc.ipc] user identity change is not an owner switch binding_id=${state.binding_id} bound_user=${state.bound_user_id ?? 'unknown'} current_user=${currentUserId ?? 'unknown'} action=none`);
            return;
        }
        // ★ 安全（方案 §4.5.4）：账号已经切走，这里**不能**再发服务端解绑 ——
        // pairingClient 的 token 与 user_id 公参都取自「当前」账号，用它去删旧账号的
        // 绑定就是拿新账号冒认旧账号。改为只做本地断开 + 清本地绑定；服务端那条关系
        // 留给旧账号自己在授权状态下清理（proxy.disconnect 内有 fail-closed 归属校验，
        // 这里的 unbind:false 是第二道闸）。
        log.warn(`[rc.ipc] user identity changed (owner mismatch) binding_id=${state.binding_id} bound_user=${state.bound_user_id} current_user=${currentUserId} server_unbind=skipped action=local_disconnect_only reason=refuse_to_impersonate_previous_account`);
        void rc.disconnect().catch((err) => {
            log.warn(`[rc.ipc] stale-binding local disconnect failed: ${err instanceof Error ? err.message : String(err)}`);
        });
        try {
            // 本地绑定必须清掉：新账号下这台机器不应继续按旧绑定重连。
            // 服务端关系仍在（旧账号可见），这是有意为之，见上面的安全说明。
            rc.clearLocalBindingForAccountSwitch();
        }
        catch (err) {
            log.warn(`[rc.ipc] stale-binding local clear failed: ${err instanceof Error ? err.message : String(err)}`);
        }
    });
    teardownHooks.push(unsubscribeUserChange);
    // PRC mode: nobody pushes rc:binding-ready, so the first connect happens
    // here — after the teardown hooks exist, so a failed attempt stays retryable
    // through requestRendererRefresh.
    if (startPrc)
        void startPrc();
}
/** Lifecycle-owned quit hook: quiet WS teardown while retaining the binding. */
export function disconnectRemoteControlBridgeBeforeQuit() {
    const rc = activeProxy;
    if (!rc)
        return;
    activeLogger?.info('[rc.ipc] before-quit → disconnect (keep binding)');
    try {
        void rc.disconnect().catch(() => {
            // best-effort during shutdown
        });
    }
    catch {
        // best-effort during shutdown
    }
}
/** Reverse of setup — used by tests / hot reload. */
export function teardownRemoteControlBridgeIPC() {
    const rc = activeProxy;
    const log = activeLogger;
    for (const ch of RC_CHANNELS)
        ipcMain.removeHandler(ch);
    for (const undo of teardownHooks) {
        try {
            undo();
        }
        catch {
            // already torn down
        }
    }
    teardownHooks = [];
    activeProxy = null;
    activeLogger = null;
    // Drop the startup thunk with the proxy it closes over (hot reload / tests).
    prcConnect = null;
    setRemoteAccessEnabled(false);
    if (!rc)
        return;
    log?.info('[rc.ipc] teardown → disconnect (keep binding)');
    try {
        void rc.disconnect().catch((err) => {
            log?.warn(`[rc.ipc] teardown disconnect failed: ${err instanceof Error ? err.message : String(err)}`);
        });
    }
    catch (err) {
        log?.warn(`[rc.ipc] teardown disconnect threw: ${err instanceof Error ? err.message : String(err)}`);
    }
}
