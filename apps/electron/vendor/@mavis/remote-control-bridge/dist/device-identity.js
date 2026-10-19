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
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
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
            return this.state;
        const fromDisk = this.readFromDisk();
        if (fromDisk) {
            this.state = fromDisk;
            return fromDisk;
        }
        const fresh = { desktop_device_id: randomUUID() };
        this.logger?.info(`[rc.identity] no usable state on disk; generated fresh desktop_device_id=sha…${deviceIdTail(fresh.desktop_device_id)}`);
        this.state = fresh;
        this.writeToDisk(fresh);
        return fresh;
    }
    /** Stable per-install device id (UUID v4). */
    getDeviceId() {
        return this.ensure().desktop_device_id;
    }
    getState() {
        // Return a copy so callers can't mutate persisted state in place.
        return { ...this.ensure() };
    }
    /** Persist binding info after pairing completes. */
    setBinding(bindingId, boundUserId) {
        const current = this.ensure();
        const next = { desktop_device_id: current.desktop_device_id };
        next.binding_id = bindingId;
        if (boundUserId !== undefined)
            next.bound_user_id = boundUserId;
        this.state = next;
        this.writeToDisk(next);
    }
    /** Clear binding fields (unbind / account switch). device_id survives. */
    clearBinding() {
        const current = this.ensure();
        const next = { desktop_device_id: current.desktop_device_id };
        this.state = next;
        this.writeToDisk(next);
    }
    readFromDisk() {
        let raw;
        try {
            raw = readFileSync(this.stateFilePath, 'utf8');
        }
        catch {
            return null; // absent — first start (normal, not logged)
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
            return state;
        }
        catch (err) {
            this.logger?.warn(`[rc.identity] state.json is corrupt (JSON parse failed: ${err instanceof Error ? err.message : String(err)}); regenerating device_id — previous binding is lost`);
            return null; // corrupt — regenerate
        }
    }
    writeToDisk(state) {
        const dir = path.dirname(this.stateFilePath);
        try {
            mkdirSync(dir, { recursive: true });
            // Atomic replace: write sibling tmp file then rename over the target.
            const tmpPath = `${this.stateFilePath}.${process.pid}.${Date.now()}.tmp`;
            writeFileSync(tmpPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
            renameSync(tmpPath, this.stateFilePath);
        }
        catch (err) {
            // Persist failure is not fatal (in-memory state still serves this run),
            // but it means device_id won't survive a restart — must be visible.
            this.logger?.error(`[rc.identity] failed to persist state.json at ${this.stateFilePath}: ${err instanceof Error ? err.message : String(err)}`);
            throw err;
        }
    }
}
/** sha256-free short tail for correlating a device_id in logs without
 * disclosing it (audit-redaction.ts owns the sha helper; identity avoids the import
 * cycle by using the raw UUID tail, which is itself non-sensitive routing
 * data — never the ticket/JWT). */
function deviceIdTail(deviceId) {
    return deviceId.slice(-6);
}
//# sourceMappingURL=device-identity.js.map