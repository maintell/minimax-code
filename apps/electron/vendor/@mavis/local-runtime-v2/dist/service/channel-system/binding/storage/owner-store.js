/**
 * Migration copy (MR1) of v1 `channels/owner-store.ts`.
 */
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import yaml from 'js-yaml';
/**
 * Build the `clientName` the **imGateway inbound path** uses to key the channel
 * owner record. Feishu and WeChat inbound events arrive through the Electron
 * imGateway, which hardcodes `clientName = `${DEFAULT_AGENT}:${platform}`` (see
 * `apps/electron/main/modules/imGateway/im-runtime-bridge.ts:238`, with
 * `DEFAULT_AGENT = 'mavis'` at line 58). That is the source of truth for this
 * convention.
 *
 * The daemon's own `*ClientId(agentName)` helpers (`feishuClientId` etc.) use a
 * DIFFERENT shape, so the owner gate can record an owner under the imGateway key
 * while the daemon's unbind clears the `*ClientId` key — a silent mismatch that
 * leaves a stale owner behind. We deliberately duplicate the imGateway
 * convention here (instead of importing electron code into the daemon) so the
 * unbind path can clear BOTH keys. This duplication is the accepted tech-debt of
 * the minimal fix; if `im-runtime-bridge.ts:238` ever changes its convention,
 * update this helper to match.
 */
export function imGatewayInboundClientName(agentName, platform) {
    return `${agentName.trim() || 'mavis'}:${platform}`;
}
/**
 * Clear a channel owner record under BOTH the daemon `*ClientId` key and the
 * imGateway inbound key (`${agentName}:${platform}`), so an unbind frees up the
 * owner regardless of which path (daemon-local or imGateway-fronted) bootstrapped
 * it. The two keys are de-duplicated, so platforms whose `*ClientId` already
 * equals the imGateway shape (e.g. Telegram → `telegram:mavis`) only issue a
 * single `clear`.
 *
 * Best-effort: `clear` returns `false` for a missing record and never throws, so
 * a missing owner on either key is not an error. Returns the number of records
 * actually deleted (0–2) for optional non-PII logging by the caller.
 */
export async function clearOwnerAllConventions(ownerStore, agentName, platform, primaryClientId) {
    const keys = new Set([primaryClientId, imGatewayInboundClientName(agentName, platform)]);
    let cleared = 0;
    for (const key of keys) {
        if (await ownerStore.clear(key))
            cleared += 1;
    }
    return cleared;
}
export class LocalChannelOwnerStore {
    dataDir;
    nowMs;
    loaded = false;
    owners = new Map();
    /**
     * Per-client serialisation tail. Each call to `checkAndBootstrap(clientName, ...)`
     * chains its critical section onto the previous tail, so two concurrent callers
     * with the same `clientName` cannot interleave their load-check-write.
     *
     * The map value is `Promise<unknown>` because `tracked = next.finally(...)`
     * preserves the task's return type. We never read the resolved value —
     * callers await their own `next` directly.
     */
    pending = new Map();
    constructor(dataDir, nowMs) {
        this.dataDir = dataDir;
        this.nowMs = nowMs;
    }
    /**
     * Atomically:
     * 1. Load the YAML store on first use (idempotent).
     * 2. If no owner is recorded for `clientName`, claim it for `senderId` and return `'allow'`.
     * 3. Otherwise compare the recorded `ownerSenderId` to `senderId` and return
     *    `'allow'` on match, `'deny'` on mismatch.
     *
     * Two concurrent calls for the same `clientName` are linearised by the
     * per-client promise chain in `pending`, so only the first to run actually
     * performs the bootstrap write — the second observes the recorded owner.
     */
    async checkAndBootstrap(clientName, senderId, senderName) {
        if (!clientName || !senderId) {
            // Defensive: a missing `clientName` or `senderId` should never reach
            // the owner gate, but treating either as 'deny' keeps the invariant
            // "no identifier pair → no turn". `checkChannelAccess` already short-
            // circuits on a missing senderId, so this is a belt-and-braces guard
            // for direct callers.
            return 'deny';
        }
        return this.serialise(clientName, async () => {
            await this.load();
            const existing = this.owners.get(clientName);
            if (!existing) {
                const owner = {
                    clientName,
                    ownerSenderId: senderId,
                    ...(senderName?.trim() ? { ownerName: senderName.trim() } : {}),
                    bootstrappedAt: this.nowMs(),
                };
                this.owners.set(clientName, owner);
                await this.save();
                return 'allow';
            }
            return existing.ownerSenderId === senderId ? 'allow' : 'deny';
        });
    }
    async getOwner(clientName) {
        await this.load();
        const owner = this.owners.get(clientName);
        return owner ? { ...owner } : undefined;
    }
    async list() {
        await this.load();
        return [...this.owners.values()]
            .sort((a, b) => a.clientName.localeCompare(b.clientName))
            .map((owner) => ({ ...owner }));
    }
    /**
     * Drop the owner record for a `clientName`. Called from the unbind path so
     * the next DM after re-bind can claim ownership again.
     */
    async clear(clientName) {
        return this.serialise(clientName, async () => {
            await this.load();
            const deleted = this.owners.delete(clientName);
            if (deleted)
                await this.save();
            return deleted;
        });
    }
    /**
     * Move a primary-family owner record from one clientName to another (plan
     * §6.3). Callers pass BOTH key conventions — the daemon `*ClientId` key and
     * the imGateway `${agentName}:${platform}` key — because an owner can have
     * been bootstrapped under either.
     *
     * Rules, identical to the ACL and binding migrations:
     *   - canonical empty → copy the legacy record verbatim;
     *   - both sides record the same `ownerSenderId` → drop the legacy copy;
     *   - both sides record a different owner → conflict, nothing is written.
     *
     * Ownership is never unioned: two different owners mean the wrong human could
     * end up driving the surviving binding, so the reconciler refuses instead.
     * `mode: 'inspect'` reports the same decision without writing.
     */
    async rekeyPrimaryFamily(input) {
        await this.load();
        const conflicts = [];
        const moves = [];
        const drops = [];
        for (const { from, to } of input.keys) {
            const decision = this.decideRekey(from, to);
            if (decision === undefined)
                continue;
            if (decision.kind === 'move')
                moves.push(decision.move);
            else if (decision.kind === 'drop')
                drops.push(from);
            else
                conflicts.push(`channel_owner:${to}`);
        }
        const result = { conflicts, moved: moves.length, deduped: drops.length };
        if (input.mode === 'inspect' || conflicts.length > 0)
            return result;
        await this.applyRekey(moves, drops);
        return result;
    }
    /** Apply phase of {@link rekeyPrimaryFamily}; persists only when something changed. */
    async applyRekey(moves, drops) {
        for (const move of moves) {
            this.owners.delete(move.from);
            this.owners.set(move.to, move.owner);
        }
        for (const key of drops)
            this.owners.delete(key);
        if (moves.length > 0 || drops.length > 0)
            await this.save();
    }
    /**
     * Decide one legacy→canonical owner key move (see {@link rekeyPrimaryFamily}
     * rules). Returns undefined when there is nothing to do for this pair.
     */
    decideRekey(from, to) {
        if (!from || !to || from === to)
            return undefined;
        const legacy = this.owners.get(from);
        if (!legacy)
            return undefined;
        const canonical = this.owners.get(to);
        if (!canonical)
            return { kind: 'move', move: { from, to, owner: { ...legacy, clientName: to } } };
        if (canonical.ownerSenderId === legacy.ownerSenderId)
            return { kind: 'drop' };
        return { kind: 'conflict' };
    }
    /**
     * Run `task` after the previous task for `clientName` resolves. The returned
     * promise resolves with `task`'s value; ordering is preserved within
     * `clientName` and isolated across different `clientName`s.
     *
     * The `pending` map holds a *tracked* wrapper that self-removes on
     * settlement, so the map size is bounded by the number of *concurrent*
     * in-flight operations per `clientName` — typically 1. Callers receive the
     * unwrapped task promise so that real rejections surface naturally.
     */
    serialise(clientName, task) {
        const prev = this.pending.get(clientName) ?? Promise.resolve();
        const next = runAfterSettled(prev, task);
        // Tracked wrapper self-removes on settlement so the map size stays bounded
        // by the number of concurrent in-flight operations per clientName. The
        // container indirection lets the cleanup compare against the tracked
        // promise's own identity without a self-reference inside its body.
        const laneTail = {};
        const tracked = settleAndCleanup(next, () => {
            // Drop the entry only if no later caller has appended their own tail.
            if (this.pending.get(clientName) === laneTail.current) {
                this.pending.delete(clientName);
            }
        });
        laneTail.current = tracked;
        this.pending.set(clientName, tracked);
        return next;
    }
    async load() {
        if (this.loaded)
            return;
        this.loaded = true;
        const raw = await readOwnerFileIfPresent(this.filePath);
        if (!raw)
            return;
        try {
            const parsed = yaml.load(raw);
            const owners = parsed?.owners;
            if (!owners || typeof owners !== 'object')
                return;
            for (const [clientName, value] of Object.entries(owners)) {
                const owner = normalizeOwner(clientName, value);
                if (owner)
                    this.owners.set(owner.clientName, owner);
            }
        }
        catch {
            // Corrupt YAML — start empty. The next `save()` will rewrite the file.
        }
    }
    async save() {
        const payload = {
            schemaVersion: 1,
            owners: Object.fromEntries([...this.owners.entries()].sort(([left], [right]) => left.localeCompare(right))),
        };
        await mkdir(dirname(this.filePath), { recursive: true });
        await writeFile(this.filePath, yaml.dump(payload, { lineWidth: 120, noRefs: true }), {
            encoding: 'utf8',
            mode: 0o600,
        });
        await chmod(this.filePath, 0o600);
    }
    get filePath() {
        return join(this.dataDir(), 'channel-owner.yaml');
    }
}
function normalizeOwner(fallbackClientName, value) {
    if (!value || typeof value !== 'object')
        return undefined;
    const raw = value;
    const ownerSenderId = readString(raw.ownerSenderId ?? raw.senderId);
    if (!ownerSenderId)
        return undefined;
    const clientName = readString(raw.clientName) ?? fallbackClientName;
    if (!clientName)
        return undefined;
    const ownerName = readString(raw.ownerName ?? raw.senderName);
    return {
        clientName,
        ownerSenderId,
        ...(ownerName ? { ownerName } : {}),
        bootstrappedAt: readNumber(raw.bootstrappedAt) ?? Date.now(),
    };
}
/** Await the previous lane tail (failures isolated), then start `task`. */
async function runAfterSettled(prev, task) {
    try {
        await prev;
    }
    catch {
        // The previous task's rejection already surfaced to its own caller.
    }
    return task();
}
/** Await settlement (success or failure), then run the lane cleanup. */
async function settleAndCleanup(next, cleanup) {
    try {
        await next;
    }
    catch {
        // The rejection surfaces via the untracked promise returned to the caller.
    }
    finally {
        cleanup();
    }
}
/** ENOENT (first boot) reads as "no file"; real I/O failures also stay quiet
 * here because the v1 store treated every read failure as an empty store. */
async function readOwnerFileIfPresent(filePath) {
    try {
        return await readFile(filePath, 'utf8');
    }
    catch {
        return undefined;
    }
}
function readString(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
function readNumber(value) {
    if (typeof value === 'number' && Number.isFinite(value))
        return value;
    if (typeof value === 'string' && value.trim()) {
        const parsed = Number(value);
        if (Number.isFinite(parsed))
            return parsed;
    }
    return undefined;
}
//# sourceMappingURL=owner-store.js.map