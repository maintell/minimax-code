/**
 * RemoteControlProxy coordinates durable producer identity and public RC status.
 * Renderer-owned credentials drive the normal connect flow. Legacy explicit
 * pairing/lookup/unbind operations delegate to RcPairingSession; RcDataPlane
 * alone owns sockets, command scopes, stream pumps and upstream subscriptions.
 * Account changes invalidate old work without issuing a server-side unbind.
 */
import { RcPairingSession, pairingErrorInfo as toErrorInfo } from './pairing-session.js';
import { RcDataPlane } from './data-plane.js';
import { randomUUID } from 'node:crypto';
import { createCredentialProvider } from './credential.js';
export { DEFAULT_PAIRING_POLL_INTERVAL_MS } from './pairing-session.js';
/** Desktop 作为 producer 的固定类型标识（方案 §4.5.11：Desktop 明确为 desktop）。 */
export const DESKTOP_PRODUCER_TYPE = 'desktop';
/**
 * 比较两次连接身份，返回**第一个**不同的维度（方案 §4.5.1 / ADR-011 D12）。
 *
 * 为什么返回具体原因而不是 boolean：日志里必须能读出「为什么重建了连接」/
 * 「为什么没重建」，否则线上排障只能靠猜。
 *
 * producer_generation 的缺省语义：任一侧为 undefined（旧服务端不下发）时该维度
 * **不参与**判定 —— 把「服务端没给」当成「代次变了」会导致每次刷新都断连。
 */
export function compareConnectionIdentity(previous, next) {
    if (previous.user_id !== next.user_id)
        return 'user_changed';
    if (previous.producer_type !== next.producer_type)
        return 'producer_type_changed';
    if (previous.producer_device_id !== next.producer_device_id)
        return 'producer_device_changed';
    if (previous.producer_generation !== undefined &&
        next.producer_generation !== undefined &&
        previous.producer_generation !== next.producer_generation) {
        return 'producer_generation_changed';
    }
    return 'unchanged';
}
/** 连接身份的日志投影（不含 ticket/JWT，plan §10）。 */
function describeIdentity(identity) {
    return `user=${identity.user_id ?? 'unknown'} producer_type=${identity.producer_type} producer_device=${identity.producer_device_id.slice(-6)} producer_generation=${identity.producer_generation ?? 'absent'}`;
}
export class RemoteControlProxy {
    opts;
    // 冷启动时 renderer 会在任何 phase 迁移前主动读取状态，因此初始快照也必须
    // 携带代次；不能只依赖 setStatus() 在后续迁移时补齐。
    status = {
        phase: 'idle',
        request_epoch: 0,
        producer_type: DESKTOP_PRODUCER_TYPE,
    };
    listeners = new Set();
    connectInFlight = null;
    /**
     * main 侧请求代次（方案 §4.5.2 / ADR-011 D12）。只增不减；renderer 快照后随
     * 凭据 IPC 回传，代次不符即拒绝。与 renderer 侧 `lifecycleEpoch` 同语义，
     * 两层都判是为了覆盖各自的在途异步（renderer 判自己的 HTTP，main 判 IPC）。
     */
    requestEpoch = 0;
    /**
     * 内存镜像：当前 producer 代次 / 未确认解绑 request_id。
     * setStatus 每次都把它们盖回 status，避免 phase 迁移把身份元数据冲掉。
     *
     * Survives one-shot ticket consumption so a producer epoch change is observable.
     */
    producerGeneration;
    pendingUnbindRequestId;
    /**
     * Credentials that the renderer has already fetched (with its own token).
     * When present, the credential provider returns them directly — skipping
     * the main-process `GET /desktop/bindings` call that would otherwise hit archon_biz
     * with the storage.ipc token and risk 401 if it has drifted.
     */
    rendererCredentials = null;
    dataPlane;
    pairing;
    constructor(opts) {
        this.opts = opts;
        this.dataPlane = new RcDataPlane(opts);
        this.pairing = new RcPairingSession({
            client: opts.pairingClient,
            logger: opts.logger,
            pollIntervalMs: opts.pollIntervalMs,
            ensureIdentity: () => {
                opts.identity.ensure();
            },
            getCurrentUserId: opts.getCurrentUserId,
            publish: (status) => this.setStatus(status.phase === 'pairing' && this.status.phase === 'pairing'
                ? { ...this.status, ...status }
                : status),
            acceptBinding: (info, owner, connect) => {
                opts.identity.setBinding(info.binding_id, owner, {
                    producerType: DESKTOP_PRODUCER_TYPE,
                    producerGeneration: info.producer_generation,
                });
                this.producerGeneration = info.producer_generation;
                if (!connect) {
                    this.setStatus({ phase: 'connected', binding_id: info.binding_id });
                    return;
                }
                if (info.ticket && info.endpoint)
                    this.rendererCredentials = {
                        bindingId: info.binding_id,
                        ticket: info.ticket,
                        endpoint: info.endpoint,
                        producerGeneration: info.producer_generation,
                        fetchedAtMs: Date.now(),
                    };
                void this.startConnection(info.binding_id);
            },
        });
    }
    getStatus() {
        return {
            ...this.status,
            ...(this.status.last_error ? { last_error: { ...this.status.last_error } } : {}),
        };
    }
    /** Broadcast a Desktop-owned temporary composer choice to the bound phone. */
    publishSessionComposerMode(change) {
        return this.dataPlane.publishSessionComposerMode(change);
    }
    /** Stable device UUID for X-Device-Id header. */
    getDeviceId() {
        this.opts.identity.ensure();
        return this.opts.identity.getDeviceId();
    }
    /** Read-only view of the persisted binding owner (for account-switch checks). */
    getBoundUserState() {
        const state = this.opts.identity.getState();
        return {
            ...(state.binding_id !== undefined ? { binding_id: state.binding_id } : {}),
            ...(state.bound_user_id !== undefined ? { bound_user_id: state.bound_user_id } : {}),
        };
    }
    /** 当前 main 侧请求代次（方案 §4.5.2 / ADR-011 D12）。 */
    getRequestEpoch() {
        return this.requestEpoch;
    }
    /**
     * 让所有在途的 renderer 凭据请求作废（方案 §4.5.2）。
     *
     * 调用时机 = 「任何让旧凭据不再可信的事件」：账号切换、binding lost、解绑完成、
     * lane 变化。之后到达的、携带旧代次的 IPC 会被 applyRendererCredentials 拒绝，
     * 从而避免「谁最后调谁赢」把已经收敛的新状态覆盖回去。
     */
    bumpRequestEpoch(reason) {
        this.pairing.invalidate();
        this.connectInFlight = null;
        this.requestEpoch += 1;
        this.opts.logger.info(`[rc.proxy] request epoch bumped epoch=${this.requestEpoch} reason=${reason}`);
        return this.requestEpoch;
    }
    /** 读取当前连接身份三元组（持久化状态 + 当前账号）。 */
    getCurrentIdentity() {
        const state = this.opts.identity.getState();
        return {
            user_id: state.bound_user_id,
            producer_type: state.producer_type ?? DESKTOP_PRODUCER_TYPE,
            producer_device_id: state.desktop_device_id,
            producer_generation: state.producer_generation,
        };
    }
    /** 未确认解绑只能由创建它的账号读取、复用或收敛。缺少 owner 时同样拒绝。 */
    isPendingUnbindOwnedByCurrentUser(pending, operation) {
        const currentUserId = this.opts.getCurrentUserId();
        const reason = pending.user_id === undefined
            ? 'pending_owner_missing'
            : currentUserId === undefined
                ? 'current_user_missing'
                : pending.user_id !== currentUserId
                    ? 'owner_mismatch'
                    : undefined;
        if (!reason)
            return true;
        this.opts.logger.warn(`[rc.proxy] producer unbind ${operation} rejected reason=${reason} request_id=${pending.request_id} action=preserve_pending_record`);
        return false;
    }
    /**
     * Receive the binding credentials the renderer just fetched via its own
     * (matrix-signed) `GET /desktop/bindings` call. Subsequent WS connect attempts
     * consume these directly through the credential provider, so the main
     * process does NOT have to re-hit /binding (which it cannot sign).
     *
     * 多对多改造（方案 §4.5.1 / §4.5.2，ADR-011 D12）——
     *
     * 1) 连接身份判据从 `binding_id` 换成 `user + producer identity +
     *    producer_generation`。改造前「binding_id 变了就换连接」是显式契约，但在
     *    多对多下代表 binding 只是「拿来签 ticket 的那一条」：consumer A 解绑后代表
     *    从 b1 轮到 b2，被控端并没有换人，**不得**因此停掉正在服务 consumer B 的 WS。
     *    因此默认分支改为 `retryNow()`（只刷凭据不断连），只有身份三元组真的变了才
     *    走 `startConnection()` 停旧建新。
     *
     * 2) 迟到凭据用请求代次拒绝。renderer 在发起 `GET /binding` 前快照 main 的
     *    `request_epoch` 并随 IPC 回传；代次不符说明这份凭据属于上一段生命周期
     *    （典型场景：账号切换时上一个账号的 /binding 响应刚回来）。
     *    未携带代次时接受并记日志 —— 兼容尚未升级的 renderer 调用点，不能因为缺字段
     *    就把已绑定的桌面端卡死。
     */
    applyRendererCredentials(creds) {
        // ── §4.5.2 请求代次校验：迟到的旧凭据不得覆盖新状态 ──
        if (creds.request_epoch !== undefined && creds.request_epoch !== this.requestEpoch) {
            this.opts.logger.warn(`[rc.proxy] renderer credentials REJECTED (stale epoch) binding_id=${creds.binding_id} request_epoch=${creds.request_epoch} current_epoch=${this.requestEpoch} action=ignore`);
            return false;
        }
        if (creds.request_epoch === undefined) {
            this.opts.logger.info(`[rc.proxy] renderer credentials accepted without epoch binding_id=${creds.binding_id} current_epoch=${this.requestEpoch} reason=caller_did_not_supply_epoch`);
        }
        const previousBindingId = this.status.binding_id ?? this.opts.identity.getState().binding_id;
        const previousIdentity = this.getCurrentIdentity();
        const nextIdentity = {
            user_id: this.opts.getCurrentUserId(),
            producer_type: DESKTOP_PRODUCER_TYPE,
            producer_device_id: this.opts.identity.getDeviceId(),
            producer_generation: creds.producer_generation ?? previousIdentity.producer_generation,
        };
        // 首次绑定（此前没有 bound_user_id）不算「账号变了」——那只是从无到有。
        const hadIdentity = previousIdentity.user_id !== undefined;
        const changeReason = hadIdentity
            ? compareConnectionIdentity(previousIdentity, nextIdentity)
            : 'unchanged';
        // Only publish credentials after their durable identity has committed.
        this.opts.identity.setBinding(creds.binding_id, nextIdentity.user_id, {
            producerGeneration: creds.producer_generation,
            producerType: DESKTOP_PRODUCER_TYPE,
        });
        this.pairing.invalidate();
        this.rendererCredentials = {
            bindingId: creds.binding_id,
            ticket: creds.ticket,
            endpoint: creds.endpoint,
            ...(creds.producer_generation !== undefined
                ? { producerGeneration: creds.producer_generation }
                : {}),
            fetchedAtMs: Date.now(),
        };
        this.producerGeneration = nextIdentity.producer_generation;
        this.opts.logger.info(`[rc.proxy] renderer credentials cached binding_id=${creds.binding_id} ${describeIdentity(nextIdentity)} epoch=${this.requestEpoch}`);
        if (!this.dataPlane.isActive()) {
            // 没有活连接就没有生命周期要保护，交给后续 connect() 正常建连。
            this.opts.logger.info(`[rc.proxy] no live connection; credentials cached only binding_id=${creds.binding_id} identity_change=${changeReason} action=none`);
            return true;
        }
        if (changeReason !== 'unchanged') {
            // 账号 / producer / 代次变了 → 先停旧连接再建新连接（§4.5.2）。
            this.bumpRequestEpoch(`identity_change:${changeReason}`);
            this.opts.logger.info(`[rc.proxy] connection identity changed reason=${changeReason} old=[${describeIdentity(previousIdentity)}] new=[${describeIdentity(nextIdentity)}] action=restart_connection`);
            void this.startConnection(creds.binding_id);
            return true;
        }
        if (previousBindingId !== creds.binding_id) {
            // ★ 本次改造的核心分支：代表 binding 轮换（b1 → b2）。
            // 同账号同 producer 同代次 —— 被控端没换人，共享 WS 上可能还挂着其他
            // consumer，停连接会误伤它们（方案 §4.5.1 / 验收 §6.5、§6.15）。
            // 只刷新凭据：连接活着就什么都不用做，退避中就立刻用新 ticket 重试。
            this.opts.logger.info(`[rc.proxy] representative binding rotated old_binding_id=${previousBindingId ?? 'unknown'} new_binding_id=${creds.binding_id} identity=unchanged action=refresh_credentials_keep_ws`);
            this.dataPlane.retryNow();
            return true;
        }
        this.opts.logger.info(`[rc.proxy] binding refresh old_binding_id=${previousBindingId} new_binding_id=${creds.binding_id} identity=unchanged action=retry_connection`);
        // Live connection idling on backoff → jump straight to a fresh attempt.
        this.dataPlane.retryNow();
        return true;
    }
    /**
     * The renderer's `GET /desktop/bindings` reported state=none — no consumer binding
     * owns this desktop. This is the ONLY disconnect trigger in the self-heal
     * design (§2): stop the WS, clear local binding, turn `unbound`. Every
     * other error keeps retrying forever.
     */
    onRendererBindingLost() {
        this.opts.logger.info('[rc.proxy] renderer reports binding lost (state=none); disconnecting');
        // 本地绑定即将清空，所有在途凭据请求作废（§4.5.2）。
        this.bumpRequestEpoch('binding_lost');
        this.rendererCredentials = null;
        this.producerGeneration = undefined;
        this.dataPlane.stop('server_initiated_unbind');
        this.opts.identity.clearBinding();
        this.pendingUnbindRequestId = undefined;
        this.producerGeneration = undefined;
        this.setStatus({ phase: 'unbound' });
    }
    /**
     * The renderer has already issued the unbind HTTP call via its own axios
     * pipeline (which carries the matrix gateway signature material the main
     * process cannot produce — see pairing-client.ts header comments). The
     * main process only needs to drop its in-process state: stop the WS,
     * clear the cached renderer credentials and the local binding record,
     * and turn `unbound`. Do NOT call pairingClient.unbind() here — the
     * renderer already did, and re-issuing it from the main process would
     * race with the renderer's own call (and would also 401, see §4.2).
     *
     * This is the user-initiated "unbind phone" path: Settings → Connection
     * → Unbind button. Account switches use clearLocalBindingForAccountSwitch()
     * and preserve the old account's server binding; they never impersonate the
     * previous account with the current account's credentials.
     */
    onRendererUnbound() {
        this.opts.logger.info('[rc.proxy] renderer reports unbind done (HTTP unbind issued by renderer); clearing local state');
        // 服务端已确认删除，在途凭据全部作废（§4.5.2）。
        this.bumpRequestEpoch('unbound');
        this.rendererCredentials = null;
        this.producerGeneration = undefined;
        this.dataPlane.stop('server_initiated_unbind');
        this.opts.identity.clearBinding();
        this.pendingUnbindRequestId = undefined;
        this.producerGeneration = undefined;
        this.setStatus({ phase: 'unbound' });
    }
    // ── producer 全删解绑：request_id 幂等 + 待确认中间态（方案 §4.5.4 / ADR-011 D12） ──
    /**
     * 开始（或恢复）一次 producer 全删解绑，返回要用于 HTTP 的 request_id。
     *
     * 为什么 request_id 由 main 生成并持久化：renderer 一刷新就丢，而「已经发出去但
     * 没收到响应」的解绑必须能用**同一个** request_id 重放，靠服务端幂等收敛
     * （ADR-011 D12）。HTTP 本身仍由 renderer 发 —— matrix gateway 签名材料只在
     * renderer 的 axios 管线里，这是硬约束。
     *
     * 已存在未确认记录时复用它（attempts+1），不会生成新 id。
     */
    beginProducerUnbind(requestIdFactory) {
        const state = this.opts.identity.getState();
        const existing = state.pending_unbind;
        const currentUserId = this.opts.getCurrentUserId();
        if (currentUserId === undefined) {
            this.opts.logger.warn('[rc.proxy] producer unbind begin rejected reason=current_user_missing action=none');
            throw new Error('Current account is unavailable');
        }
        if (existing && !this.isPendingUnbindOwnedByCurrentUser(existing, 'begin')) {
            throw new Error('Pending unbind belongs to another account');
        }
        const requestId = existing?.request_id ?? (requestIdFactory ?? randomUUID)();
        const pending = this.opts.identity.beginPendingUnbind({
            requestId,
            userId: currentUserId,
            bindingId: state.binding_id,
        });
        this.opts.logger.info(existing
            ? `[rc.proxy] producer unbind RESUMED request_id=${pending.request_id} attempts=${pending.attempts} binding_id=${pending.binding_id ?? 'unknown'} reason=pending_record_exists`
            : `[rc.proxy] producer unbind STARTED request_id=${pending.request_id} binding_id=${pending.binding_id ?? 'unknown'} reason=user_initiated`);
        this.pairing.invalidate();
        this.pendingUnbindRequestId = pending.request_id;
        this.broadcastStatus();
        return pending;
    }
    /** 读取未确认解绑记录（renderer 冷启动时用于恢复重放）。 */
    getPendingProducerUnbind() {
        const pending = this.opts.identity.getPendingUnbind();
        if (!pending || !this.isPendingUnbindOwnedByCurrentUser(pending, 'read'))
            return undefined;
        return pending;
    }
    /**
     * renderer 报告解绑得到了**确定结果**。
     *
     * - `confirmed`：服务端确认已全删 → 停 WS、清本地绑定、清待确认记录。
     * - `rejected`：服务端明确拒绝（4xx 等确定性失败）→ 只清待确认记录，
     *   **保留**本地绑定（关系其实还在，清掉会让 UI 和服务端不一致）。
     *
     * 超时 / 网络错误 / 5xx **不走这里**：那些保持待确认，等待下一次重放
     * （方案 §4.5.4：不能凭 HTTP 超时判定未解绑）。
     */
    resolveProducerUnbind(outcome, reason) {
        const pending = this.opts.identity.getPendingUnbind();
        if (!pending) {
            this.opts.logger.warn(`[rc.proxy] producer unbind resolve ignored outcome=${outcome} reason=${reason} cause=no_pending_record`);
            return;
        }
        if (!this.isPendingUnbindOwnedByCurrentUser(pending, 'resolve')) {
            throw new Error('Pending unbind belongs to another account');
        }
        if (outcome === 'confirmed') {
            this.opts.logger.info(`[rc.proxy] producer unbind CONFIRMED request_id=${pending.request_id} attempts=${pending.attempts} reason=${reason} action=clear_local_state`);
            this.onRendererUnbound();
            return;
        }
        this.opts.logger.warn(`[rc.proxy] producer unbind REJECTED request_id=${pending.request_id} attempts=${pending.attempts} reason=${reason} action=clear_pending_keep_binding`);
        this.opts.identity.clearPendingUnbind();
        this.pendingUnbindRequestId = undefined;
        this.broadcastStatus();
    }
    /**
     * 账号切换：只清本地绑定，**不**发任何服务端解绑请求（方案 §4.5.4）。
     *
     * 为什么单独开一个方法而不是复用 disconnect({unbind:true})：后者的语义是
     * 「服务端也删掉」，而账号已经切走时我们没有旧账号的授权材料，发请求就是冒认。
     * 这里的语义明确为「先断开旧账号本地连接」，服务端关系保留给旧账号自行处理。
     */
    clearLocalBindingForAccountSwitch() {
        const state = this.opts.identity.getState();
        this.opts.logger.warn(`[rc.proxy] account switch cleanup binding_id=${state.binding_id} bound_user=${state.bound_user_id ?? 'unknown'} current_user=${this.opts.getCurrentUserId() ?? 'unknown'} server_unbind=skipped action=clear_local_binding_only`);
        this.bumpRequestEpoch('account_switch');
        this.rendererCredentials = null;
        this.dataPlane.stop('app_quit');
        this.opts.identity.clearBinding({ preservePendingUnbind: true });
        this.pendingUnbindRequestId = undefined;
        this.producerGeneration = undefined;
        this.setStatus({ phase: 'unbound' });
    }
    /**
     * A local WS-routing setting changed. Keep the durable binding, but discard
     * the one-shot renderer ticket/endpoint and force the renderer to sign a
     * fresh bundle before the next WS attempt. With no active connection there
     * is no lifecycle to disrupt; the next normal connect reads the current
     * headers anyway.
     */
    onSwimLaneChanged() {
        if (this.pairing.isActive() || this.rendererCredentials) {
            this.bumpRequestEpoch('swim_lane_pending');
            this.rendererCredentials = null;
            if (this.status.phase === 'pairing')
                this.setStatus({ phase: 'idle' });
        }
        if (!this.dataPlane.isActive()) {
            // 无活连接 → 无生命周期可打断，下次正常建连自然读到新 headers。
            this.opts.logger.info('[rc.proxy] swim lane changed but no live connection; nothing to restart action=none');
            return;
        }
        const bindingId = this.status.binding_id ?? this.opts.identity.getState().binding_id;
        // 丢弃的一次性 ticket 对应旧 lane，在途的 refresh 响应同样不能再用（§4.5.2）。
        this.bumpRequestEpoch('swim_lane_changed');
        this.opts.logger.info(`[rc.proxy] swim lane changed binding_id=${bindingId ?? 'unknown'} action=drop_ticket_and_request_refresh`);
        this.rendererCredentials = null;
        this.dataPlane.stop('app_quit');
        if (bindingId !== undefined) {
            this.setStatus({ phase: 'reconnecting', binding_id: bindingId });
        }
        this.opts.requestRendererRefresh?.();
    }
    onStatusChange(cb) {
        this.listeners.add(cb);
        return () => {
            this.listeners.delete(cb);
        };
    }
    /**
     * Check binding status via GET /desktop/bindings WITHOUT initiating pairing.
     * Updates internal status and returns it. Used on page enter to decide
     * whether to show Connect or Settings.
     *
     * NOTE: Binding state is now owned by the renderer (axios → archon_biz with
     * the renderer's token). The main process must NOT poll /binding itself —
     * its token (storage.ipc) and the renderer's token (localStorage) are
     * independently refreshed and can drift out of sync, which surfaces as
     * `401 token_expired` log spam from this method. If a bound state is
     * detected here (explicit legacy IPC path), we still record the binding so the
     * WS layer can connect; otherwise we just report `idle`.
     */
    async checkBinding() {
        await this.pairing.checkBinding();
        return this.getStatus();
    }
    /**
     * Request a fresh pairing code via POST /pairing/code and start polling.
     * Does NOT check binding first — caller should have checked via checkBinding().
     */
    async requestPairingCode() {
        await this.pairing.requestCode();
        return this.getStatus();
    }
    /**
     * Begin establishing the bridge. Idempotent: already connected returns the
     * current snapshot; a connect already in flight is joined, not restarted.
     * Resolves at the first stable milestone (pairing code issued / connected /
     * reconnecting / error) — later transitions stream via onStatusChange.
     */
    connect() {
        if (this.status.phase === 'connected' || this.status.phase === 'pairing') {
            return Promise.resolve(this.toConnectResult());
        }
        if (this.dataPlane.isActive() &&
            (this.status.phase === 'connecting' || this.status.phase === 'reconnecting')) {
            // A live connection attempt already owns the lifecycle.
            return Promise.resolve(this.toConnectResult());
        }
        if (this.connectInFlight)
            return this.connectInFlight;
        this.opts.logger.info('[rc.proxy] connect() invoked');
        const task = this.doConnect().finally(() => {
            if (this.connectInFlight === task)
                this.connectInFlight = null;
        });
        this.connectInFlight = task;
        return task;
    }
    /**
     * Tear down. Default keeps the binding (reconnectable); {unbind:true} also
     * deletes it server-side and clears local binding state. A failed server
     * unbind keeps the local identity so callers can retry and must never report
     * a stale server-side binding as successfully removed.
     *
     * 安全约束（方案 §4.5.4）：**禁止用新账号凭据冒认旧账号解绑**。
     * pairingClient 的鉴权材料（token / user_id 公参）全部取自「当前」账号，
     * 所以账号已经切走之后再调 POST /unbind，本质是拿新账号的身份去删旧账号的关系。
     * 这里做 fail-closed 归属校验：归属不符时只做本地断开 + 清本地绑定，
     * 不发任何服务端请求，并在日志中显式标注 server_unbind=skipped。
     */
    async disconnect(opts = {}) {
        this.opts.logger.info(`[rc.proxy] disconnect() unbind=${opts.unbind === true}`);
        this.bumpRequestEpoch('disconnect');
        this.rendererCredentials = null;
        this.dataPlane.stop('app_quit');
        if (opts.unbind) {
            const state = this.opts.identity.getState();
            const bindingId = state.binding_id;
            const boundUserId = state.bound_user_id;
            const currentUserId = this.opts.getCurrentUserId();
            // 归属校验：只有「当前账号 == 绑定所属账号」时才允许发服务端解绑。
            const ownershipOk = boundUserId === undefined || currentUserId === undefined || boundUserId === currentUserId;
            if (bindingId !== undefined && !ownershipOk) {
                this.opts.logger.warn(`[rc.proxy] unbind SKIPPED (ownership mismatch) binding_id=${bindingId} bound_user=${boundUserId ?? 'unknown'} current_user=${currentUserId ?? 'unknown'} server_unbind=skipped action=local_disconnect_only reason=refuse_to_impersonate_previous_account`);
                this.bumpRequestEpoch('account_switch_local_only');
                this.rendererCredentials = null;
                this.opts.identity.clearBinding();
                this.producerGeneration = undefined;
                this.setStatus({ phase: 'unbound' });
                return;
            }
            if (bindingId !== undefined) {
                try {
                    await this.pairing.unbind(bindingId, () => {
                        this.bumpRequestEpoch('unbind_via_disconnect');
                        try {
                            this.opts.identity.clearBinding();
                        }
                        catch (error) {
                            this.setStatus({
                                phase: 'error',
                                binding_id: bindingId,
                                last_error: toErrorInfo(error),
                            });
                            throw error;
                        }
                        this.producerGeneration = undefined;
                        this.pendingUnbindRequestId = undefined;
                        this.setStatus({ phase: 'unbound' });
                        this.opts.logger.info(`[rc.proxy] unbind ok binding_id=${bindingId} bound_user=${boundUserId ?? 'unknown'}`);
                    });
                    return;
                }
                catch (err) {
                    const { code, message } = toErrorInfo(err);
                    this.opts.logger.error(`[rc.proxy] unbind binding_id=${bindingId} failed; preserving local binding for retry: ${code} ${message}`);
                    throw err;
                }
            }
            else {
                this.opts.logger.info('[rc.proxy] unbind requested but no local binding exists');
            }
            this.bumpRequestEpoch('unbind_via_disconnect');
            this.opts.identity.clearBinding();
            this.producerGeneration = undefined;
            this.pendingUnbindRequestId = undefined;
            this.setStatus({ phase: 'unbound' });
            return;
        }
        this.setStatus({ phase: 'idle', binding_id: this.opts.identity.getState().binding_id });
    }
    async doConnect() {
        // T0: device_id must exist before any HTTP
        this.opts.identity.ensure();
        // Binding state is now owned by the renderer (axios → archon_biz with
        // the renderer's token). The main process no longer polls /binding —
        // using the storage.ipc token here surfaced spurious 401s and could
        // return stale state (token drift between renderer and main). The
        // renderer pushes `phase: 'bound' {binding_id, ticket, endpoint}` via
        // `RC_BINDING_READY` once the user finishes the pairing flow on the
        // phone, which lands in applyRendererCredentials().
        if (this.rendererCredentials) {
            const bindingId = this.rendererCredentials.bindingId;
            this.setStatus({ phase: 'connecting', binding_id: bindingId });
            return await this.startConnection(bindingId);
        }
        const status = this.getStatus();
        if (status.phase === 'connected' && status.binding_id !== undefined) {
            return await this.startConnection(status.binding_id);
        }
        this.opts.logger.info(`[rc.proxy] connect: no binding yet (phase=${status.phase}); renderer drives pairing`);
        return this.toConnectResult();
    }
    /** Spin up the WS and resolve at its first settle (see connect() doc). */
    startConnection(bindingId) {
        this.dataPlane.stop('app_quit');
        this.setStatus({ phase: 'connecting', binding_id: bindingId });
        return new Promise((resolve) => {
            let settled = false;
            const settle = () => {
                if (settled)
                    return;
                settled = true;
                resolve(this.toConnectResult());
            };
            const credentials = createCredentialProvider(() => this.rendererCredentials);
            this.dataPlane.start({
                credentials,
                commandScope: JSON.stringify([this.getCurrentIdentity(), this.requestEpoch]),
                onEvent: (ev) => {
                    this.handleConnectionEvent(ev, bindingId);
                    if (ev.kind === 'connected' ||
                        ev.kind === 'reconnecting' ||
                        ev.kind === 'need-credentials' ||
                        ev.kind === 'stopped') {
                        settle();
                    }
                },
            });
        });
    }
    handleConnectionEvent(ev, bindingId) {
        switch (ev.kind) {
            case 'connecting':
                if (this.status.phase !== 'reconnecting') {
                    this.setStatus({ phase: 'connecting', binding_id: bindingId });
                }
                return;
            case 'connected':
                // Burn-after-use: the one-shot ticket has now been consumed by a
                // successful handshake. Drop it so any later reconnect goes stale →
                // need-credentials → renderer re-sign, never replaying a dead ticket
                // (which the gateway rejects as ticket_invalid — design §4.5).
                this.rendererCredentials = null;
                this.setStatus({ phase: 'connected', binding_id: bindingId });
                return;
            case 'reconnecting':
                // WS down → abort only the pumps owned by that gateway connection.
                this.setStatus({ phase: 'reconnecting', binding_id: bindingId });
                return;
            case 'need-credentials':
                // The provider had no fresh ticket. Ask the renderer to re-sign; the
                // connection has already armed a backoff re-attempt, so a slow/absent
                // renderer never wedges the loop (design §4.3).
                this.opts.logger.info('[rc.proxy] need-credentials → requesting renderer refresh');
                this.opts.requestRendererRefresh?.();
                this.setStatus({ phase: 'reconnecting', binding_id: bindingId });
                return;
            case 'replay-overflow':
                // IDL: empty payload — replay unrecoverable. Wave 1: recorded only.
                // Wave 2+: trigger the phone's full snapshot refetch.
                this.opts.logger.warn('[rc.proxy] replay overflow — full snapshot refetch required');
                return;
            case 'stopped':
                this.handleConnectionStopped(ev, bindingId);
                break;
            default:
                break;
        }
    }
    handleConnectionStopped(ev, bindingId) {
        switch (ev.cause) {
            case 'requested':
                return; // disconnect() sets the final phase itself
            case 'superseded':
                // Quiet exit; binding stays valid for a later connect().
                this.setStatus({ phase: 'idle', binding_id: bindingId });
                return;
            case 'credentials': {
                // Gateway rejected the ticket (auth_expired / ticket_invalid). The
                // ticket was one-shot and is now spent, so the cached bundle is dead:
                // drop it and drive the renderer re-sign loop instead of retrying the
                // same dead ticket or dead-ending in `error`. Never a disconnect —
                // the only disconnect exit is renderer state=none (design §4.5).
                this.rendererCredentials = null;
                this.opts.logger.warn(`[rc.proxy] ${ev.reason ?? 'credentials rejected'}; requesting renderer refresh + retrying`);
                this.setStatus({ phase: 'reconnecting', binding_id: bindingId });
                this.opts.requestRendererRefresh?.();
                this.dataPlane.restart();
                return;
            }
            case 'server-unbind':
                // SERVER_INITIATED_UNBIND revokes this connection, but in the
                // multi-consumer model it does not prove that every binding for the
                // producer has been removed. Drop the representative binding and ask
                // the renderer to reconcile `/desktop/bindings`: a remaining binding
                // supplies a fresh one-shot ticket and reconnects, while state=none
                // confirms the final unbound state.
                this.bumpRequestEpoch('server_unbind');
                this.rendererCredentials = null;
                this.opts.identity.clearBinding();
                this.producerGeneration = undefined;
                this.setStatus({ phase: 'unbound' });
                this.opts.requestRendererRefresh?.();
                break;
            default:
                break;
        }
    }
    toConnectResult() {
        const result = { phase: this.status.phase };
        if (this.status.binding_id !== undefined)
            result.binding_id = this.status.binding_id;
        if (this.status.pairing_code !== undefined)
            result.pairing_code = this.status.pairing_code;
        if (this.status.expires_in !== undefined)
            result.expires_in = this.status.expires_in;
        if (this.status.last_error !== undefined)
            result.last_error = { ...this.status.last_error };
        return result;
    }
    /**
     * 重新广播当前状态（不改 phase）。用于只有连接身份元数据变化的场景，
     * 例如解绑进入/离开「待确认」中间态（§4.5.4）。
     */
    broadcastStatus() {
        this.setStatus({ ...this.status });
    }
    setStatus(next) {
        // request_epoch / pending_unbind_request_id / producer_* 是**跨 phase** 的连接身份
        // 元数据（§4.5.1/§4.5.2/§4.5.4）：既有 setStatus 调用点都是整份替换 status，
        // 若不在这里统一盖章，任何一次 phase 迁移都会把它们抹掉，renderer 的代次校验
        // 和待确认中间态就会失效。
        const phaseStatus = { ...next };
        delete phaseStatus.request_epoch;
        delete phaseStatus.producer_generation;
        delete phaseStatus.producer_type;
        delete phaseStatus.pending_unbind_request_id;
        this.status = {
            ...phaseStatus,
            request_epoch: this.requestEpoch,
            producer_type: DESKTOP_PRODUCER_TYPE,
            ...(this.producerGeneration !== undefined
                ? { producer_generation: this.producerGeneration }
                : {}),
            ...(this.pendingUnbindRequestId !== undefined
                ? { pending_unbind_request_id: this.pendingUnbindRequestId }
                : {}),
        };
        const snapshot = this.getStatus();
        for (const cb of this.listeners) {
            try {
                cb(snapshot);
            }
            catch (err) {
                this.opts.logger.warn(`[rc.proxy] status listener threw: ${err instanceof Error ? err.message : String(err)}`);
            }
        }
    }
}
export { createAttachmentFetcher } from './attachment-fetch.js';
export { DeviceIdentityStore } from './device-identity.js';
export { PairingClient } from './pairing-client.js';
export { describeBindingForLog, deviceIdForLog, hashTail6, redactWsUrl, } from './audit-redaction.js';
//# sourceMappingURL=index.js.map