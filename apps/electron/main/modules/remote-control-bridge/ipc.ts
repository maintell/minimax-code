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
function buildDefaultProxy(logger, bridge) {
    const identity = new bridge.DeviceIdentityStore(path.join(app.getPath('userData'), 'remote-control', 'state.json'), logger);
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
    return new bridge.RemoteControlProxy({
        identity,
        pairingClient,
        logger,
        clientVersion: app.getVersion(),
        isRuntimeHealthy: () => isLocalRuntimeReady(),
        getCurrentUserId: () => resolveCurrentUserId(getUserInfo()),
        getWebSocketHeaders,
        // Reverse loop: main can't sign GET /desktop/bindings, so ask the renderer to
        // re-sign and push credentials back (self-heal design §4.2).
        requestRendererRefresh: () => broadcastRefreshBinding(logger),
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
    activeProxy = rc;
    activeLogger = log;
    ipcMain.handle(IPC_CHANNELS.RC_CONNECT, async () => {
        log.info('[rc.ipc] rc:connect invoked');
        try {
            return await rc.connect();
        }
        catch (err) {
            log.error(`[rc.ipc] rc:connect threw: ${err instanceof Error ? err.message : String(err)}`);
            return { phase: 'error' };
        }
    });
    ipcMain.handle(IPC_CHANNELS.RC_DISCONNECT, async (_event, opts) => {
        log.info(`[rc.ipc] rc:disconnect invoked unbind=${opts?.unbind === true}`);
        try {
            await rc.disconnect(opts?.unbind ? { unbind: true } : {});
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
