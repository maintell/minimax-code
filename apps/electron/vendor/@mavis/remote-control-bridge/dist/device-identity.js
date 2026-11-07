/**
 * T0 — desktop_device_id primitive + local RC state persistence.
 *
 * Owns `<userData>/remote-control/state.json`:
 *   { desktop_device_id, binding_id?, bound_user_id? }
 *
 * - desktop_device_id: stable UUID v4, generated on first start and reused
 *   forever after (survives unbind — identifies this desktop install).
 * - binding_id / bound_user_id: written when pairing completes, cleared on
 *   unbind. NEVER stores tickets or JWTs (plan §10 hard constraint).
 *
 * Writes are atomic (tmp file + rename) so a crash mid-write can't corrupt
 * the state file. Corrupt/invalid files are treated as absent and rebuilt.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
function isValidPendingUnbind(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return false;
    const v = value;
    if (typeof v.request_id !== 'string' || v.request_id.length === 0)
        return false;
    if (typeof v.created_at_ms !== 'number' || !Number.isFinite(v.created_at_ms))
        return false;
    if (typeof v.attempts !== 'number' || !Number.isFinite(v.attempts))
        return false;
    if (v.user_id !== undefined && typeof v.user_id !== 'string')
        return false;
    if (v.binding_id !== undefined && typeof v.binding_id !== 'number')
        return false;
    return true;
}
function isValidState(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return false;
    const v = value;
    if (typeof v.desktop_device_id !== 'string' || v.desktop_device_id.length === 0)
        return false;
    if (v.binding_id !== undefined && typeof v.binding_id !== 'number')
        return false;
    if (v.bound_user_id !== undefined && typeof v.bound_user_id !== 'string')
        return false;
    if (v.producer_generation !== undefined && typeof v.producer_generation !== 'number')
        return false;
    if (v.producer_type !== undefined && typeof v.producer_type !== 'string')
        return false;
    // pending_unbind 结构损坏时**不能**整份 state 作废（那会连带丢掉 device_id 和绑定），
    // 只在投影阶段丢弃这一个字段，见 readFromDisk。
    return true;
}
export class DeviceIdentityStore {
    stateFilePath;
    logger;
    state = null;
    /**
     * @param stateFilePath absolute path to state.json, e.g.
     *   path.join(app.getPath('userData'), 'remote-control', 'state.json')
     * @param logger optional RC logger — when provided, identity lifecycle
     *   (device_id generation, corrupt-state rebuilds, write failures) lands in
     *   the remoteControl-*.log file. Optional so existing test call sites keep
     *   their single-arg construction.
     */
    constructor(stateFilePath, logger) {
        this.stateFilePath = stateFilePath;
        this.logger = logger;
    }
    /** Load state from disk (or create it on first start). Idempotent. */
    ensure() {
        if (this.state)
            return copyState(this.state);
        const fromDisk = this.readFromDisk();
        if (fromDisk) {
            this.state = fromDisk;
            return copyState(fromDisk);
        }
        const fresh = { desktop_device_id: randomUUID() };
        this.logger?.info(`[rc.identity] no usable state on disk; generated fresh desktop_device_id=sha…${deviceIdTail(fresh.desktop_device_id)}`);
        this.writeToDisk(fresh);
        this.state = fresh;
        return copyState(fresh);
    }
    /** Stable per-install device id (UUID v4). */
    getDeviceId() {
        return this.ensure().desktop_device_id;
    }
    getState() {
        // Return a copy so callers can't mutate persisted state in place.
        return this.ensure();
    }
    /**
     * Persist binding info after pairing completes.
     *
     * `producerGeneration` / `producerType` 是连接身份的一部分（方案 §4.5.1），
     * 和 binding_id 一起落盘，使重启后的第一次凭据推送能做同代次比较。
     * 未确认解绑记录（pending_unbind）在这里**必须保留** —— 它由解绑链路独立收敛，
     * 一次代表 binding 刷新不应把「还没确认删掉没有」的事实抹掉（方案 §4.5.4）。
     */
    setBinding(bindingId, boundUserId, identity) {
        const current = this.ensure();
        const next = { desktop_device_id: current.desktop_device_id };
        next.binding_id = bindingId;
        if (boundUserId !== undefined)
            next.bound_user_id = boundUserId;
        // 服务端没下发代次时沿用已持久化的值，避免把「本次响应缺字段」写成「代次被清空」。
        const nextGeneration = identity?.producerGeneration ?? current.producer_generation;
        if (nextGeneration !== undefined)
            next.producer_generation = nextGeneration;
        const nextType = identity?.producerType ?? current.producer_type;
        if (nextType !== undefined)
            next.producer_type = nextType;
        if (current.pending_unbind !== undefined)
            next.pending_unbind = current.pending_unbind;
        this.writeToDisk(next);
        this.state = next;
    }
    /**
     * Clear binding fields (unbind / account switch). device_id survives.
     * 同时清掉 producer 代次（它属于已经不存在的那段绑定关系）。
     * 默认一并清掉 pending_unbind；账号切换可显式保留带 owner 的未确认记录，
     * 供切回原账号后继续重放。
     */
    clearBinding(options = {}) {
        const current = this.ensure();
        const next = { desktop_device_id: current.desktop_device_id };
        // producer_type 是本机固有属性（不随绑定关系存亡变化），保留它。
        if (current.producer_type !== undefined)
            next.producer_type = current.producer_type;
        // 账号切换只清当前本地连接，不能丢掉旧账号尚未确认的幂等操作。该记录自带
        // user_id，切回原账号后才能继续重放；其他 clearBinding 调用仍按原语义清除。
        if (options.preservePendingUnbind && current.pending_unbind !== undefined) {
            next.pending_unbind = current.pending_unbind;
        }
        this.writeToDisk(next);
        this.state = next;
    }
    /**
     * 记录/复用一次 producer 全删解绑的 request_id（方案 §4.5.4，ADR-011 D12）。
     *
     * 已存在未确认记录时**复用原 request_id**并把 attempts+1 —— 这正是幂等的关键：
     * 用户重复点、renderer 刷新后重放、崩溃恢复后重放，都必须是同一个 request_id，
     * 否则服务端会把它们当成多次独立的全删操作。
     */
    beginPendingUnbind(input) {
        const current = this.ensure();
        const existing = current.pending_unbind;
        const pending = existing
            ? { ...existing, attempts: existing.attempts + 1 }
            : {
                request_id: input.requestId,
                created_at_ms: input.nowMs ?? Date.now(),
                attempts: 1,
                ...(input.userId !== undefined ? { user_id: input.userId } : {}),
                ...(input.bindingId !== undefined ? { binding_id: input.bindingId } : {}),
            };
        const next = { ...current, pending_unbind: pending };
        this.writeToDisk(next);
        this.state = next;
        return { ...pending };
    }
    /** 读取未确认解绑记录；无记录返回 undefined。 */
    getPendingUnbind() {
        const pending = this.ensure().pending_unbind;
        return pending ? { ...pending } : undefined;
    }
    /**
     * 清除未确认解绑记录。
     * 只在「服务端确认已删」或「服务端明确拒绝该请求」两种确定结果下调用；
     * 超时/网络错误**不得**调用（方案 §4.5.4：不能凭 HTTP 超时判定未解绑）。
     */
    clearPendingUnbind() {
        const current = this.ensure();
        if (current.pending_unbind === undefined)
            return;
        const next = { ...current };
        delete next.pending_unbind;
        this.writeToDisk(next);
        this.state = next;
    }
    readFromDisk() {
        let raw;
        try {
            raw = readFileSync(this.stateFilePath, 'utf8');
        }
        catch (err) {
            if (err.code === 'ENOENT')
                return null;
            // An unreadable existing file is not a new installation. Replacing it
            // would silently discard the durable device and pending-unbind identity.
            throw err;
        }
        try {
            const parsed = JSON.parse(raw);
            if (!isValidState(parsed)) {
                this.logger?.warn('[rc.identity] state.json present but failed schema validation; treating as absent and regenerating (previous binding, if any, is lost)');
                return null;
            }
            // Re-project to drop any unknown keys (defensive: never round-trip
            // fields we don't own, e.g. if an old build wrote extra data).
            const state = { desktop_device_id: parsed.desktop_device_id };
            if (parsed.binding_id !== undefined)
                state.binding_id = parsed.binding_id;
            if (parsed.bound_user_id !== undefined)
                state.bound_user_id = parsed.bound_user_id;
            if (parsed.producer_generation !== undefined) {
                state.producer_generation = parsed.producer_generation;
            }
            if (parsed.producer_type !== undefined)
                state.producer_type = parsed.producer_type;
            // isValidState 刻意不校验 pending_unbind（校验失败不该作废整份 state），
            // 所以这里必须按 unknown 重新校验一次再投影。
            const rawPending = parsed.pending_unbind;
            if (rawPending !== undefined) {
                if (isValidPendingUnbind(rawPending)) {
                    state.pending_unbind = rawPending;
                }
                else {
                    // 只丢这一个字段，不作废整份 state（否则连 device_id 都会被重建）。
                    // 必须留日志：丢掉待确认记录意味着那次解绑不会再被重放。
                    this.logger?.warn('[rc.identity] pending_unbind in state.json failed schema validation; dropping it (that unbind will NOT be replayed)');
                }
            }
            return state;
        }
        catch (err) {
            this.logger?.warn(`[rc.identity] state.json is corrupt (JSON parse failed: ${err instanceof Error ? err.message : String(err)}); regenerating device_id — previous binding is lost`);
            return null; // corrupt — regenerate
        }
    }
    writeToDisk(state) {
        const dir = path.dirname(this.stateFilePath);
        const tmpPath = `${this.stateFilePath}.${randomUUID()}.tmp`;
        try {
            mkdirSync(dir, { recursive: true });
            // Atomic replace: write sibling tmp file then rename over the target.
            writeFileSync(tmpPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
            renameSync(tmpPath, this.stateFilePath);
        }
        catch (err) {
            // Callers see the failure and keep the last durable state in memory.
            // A failed rename must not leave an uncommitted identity file behind.
            try {
                rmSync(tmpPath, { force: true });
            }
            catch {
                /* Preserve the original write failure. */
            }
            this.logger?.error(`[rc.identity] failed to persist state.json at ${this.stateFilePath}: ${err instanceof Error ? err.message : String(err)}`);
            throw err;
        }
    }
}
function copyState(state) {
    return {
        ...state,
        ...(state.pending_unbind ? { pending_unbind: { ...state.pending_unbind } } : {}),
    };
}
/** sha256-free short tail for correlating a device_id in logs without
 * disclosing it (audit-redaction.ts owns the sha helper; identity avoids the import
 * cycle by using the raw UUID tail, which is itself non-sensitive routing
 * data — never the ticket/JWT). */
function deviceIdTail(deviceId) {
    return deviceId.slice(-6);
}
//# sourceMappingURL=device-identity.js.map