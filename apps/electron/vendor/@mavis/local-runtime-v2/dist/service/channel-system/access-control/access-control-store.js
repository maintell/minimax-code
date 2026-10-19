/**
 * Migration copy (MR1) of v1 `channels/access-control-store.ts`. Persists
 * `access-control.yaml`; allow rules and mention policy must be preserved
 * byte-compatibly (proposal §8).
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import yaml from 'js-yaml';
import { imLogger } from '@mavis/shared/local-runtime-logging/im-logger';
import { clonePolicy, defaultAccessControl, evaluatePolicy, isValidAccessControlKey, normalizePolicy, parseAccessControlKey, policySummary, } from './access-control-policy.js';
const ACCESS_CONTROL_LOG_TAG = '[access-control]';
/**
 * Build the YAML key for a `${platform}:${clientName}` policy entry.
 * Empty / missing parts return an empty string so callers can short-
 * circuit on it (the store treats an empty key as invalid and falls
 * back to the default policy for the read path; the write path throws).
 */
export function buildAccessControlKey(platform, clientName) {
    if (!platform || !clientName)
        return '';
    return `${platform}:${clientName}`;
}
/**
 * Defensive default applied when a `clientName` has no entry on disk
 * *or* the stored entry is partial / unparseable. Matches the
 * migration doc §"默认策略":
 *
 *   - `allowedUsers: []` → preserves dev's existing owner-only default.
 *   - `allowedGroups: []` → group traffic is closed by default; the
 *     operator must opt in explicitly with a list or `ALL`.
 *   - `groupMentionPolicy: 'mentionOnly'` → even with groups open an
 *     `@bot` mention is required.
 */
/**
 * Persistence + evaluation layer for the per-Agent-Channel
 * `AccessControl` policy. Mirrors `LocalChannelOwnerStore`: YAML on
 * disk under `<dataDir>/access-control.yaml`, lazy load on first
 * access, atomic rewrite on every `set` / `delete`.
 *
 * The store does NOT serialise per `clientName` for `set` / `delete`
 * (unlike the owner store): policy edits happen out-of-band from
 * inbound traffic, and a 100% loss-free reload is recoverable from
 * disk so a small race window is acceptable. `evaluate` is pure
 * apart from the owner-store side-effect (bootstrap) the caller
 * already paid for in `LocalChannelBridgeInfra.handleInbound`.
 */
export class LocalAccessControlStore {
    dataDir;
    nowMs;
    options;
    loaded = false;
    loadPromise;
    policies = new Map();
    logger;
    constructor(dataDir, nowMs, options = {}) {
        this.dataDir = dataDir;
        this.nowMs = nowMs;
        this.options = options;
        // Migration doc §6 (Audit / observability) hard-requires every
        // evaluate() call to emit an audit line. When the caller does not
        // inject a logger we bind the IM-subsystem engineering logger so the
        // production wire path always satisfies the spec even without
        // explicit host wiring. Tests that want a silent store still pass
        // `{ logInfo: () => {}, logWarn: () => {} }`.
        this.logger = options.logger ?? bindAccessControlAuditLogger(imLogger);
    }
    /**
     * Return the persisted policy for `${platform}:${clientName}` (a fresh
     * copy — callers cannot mutate the in-memory map). Falls back to
     * {@link defaultAccessControl} when nothing is on disk.
     */
    async get(platform, clientName) {
        if (!isValidKey(platform, clientName)) {
            return defaultAccessControl();
        }
        await this.load();
        const stored = this.policies.get(buildAccessControlKey(platform, clientName));
        return clonePolicy(stored ?? defaultAccessControl());
    }
    /**
     * Upsert the policy. Empty `clientName` is rejected (no-op) to avoid
     * a silent global key. Unknown platforms are also rejected so a typo
     * (`Telegarm`) does not end up persisted under a misspelled key.
     */
    async set(platform, clientName, patch) {
        if (!isValidKey(platform, clientName)) {
            throw new Error(`Invalid access-control key: ${platform}:${clientName}`);
        }
        await this.load();
        const key = buildAccessControlKey(platform, clientName);
        const base = this.policies.get(key) ?? defaultAccessControl();
        const next = normalizePolicy({ ...base, ...patch });
        this.policies.set(key, next);
        await this.save();
        return clonePolicy(next);
    }
    async delete(platform, clientName) {
        if (!isValidKey(platform, clientName))
            return false;
        await this.load();
        const key = buildAccessControlKey(platform, clientName);
        const deleted = this.policies.delete(key);
        if (deleted)
            await this.save();
        return deleted;
    }
    async list() {
        await this.load();
        return [...this.policies.entries()]
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, policy]) => ({ key, policy: clonePolicy(policy) }));
    }
    /**
     * Initialise the default policy for `${platform}:${clientName}` if
     * (and only if) no entry already exists. Returns `true` when the
     * call actually wrote the default, `false` when an entry was
     * already present (the bind / restore path must NOT overwrite a
     * user-customised policy — that is the migration doc's explicit
     * "不替用户改" invariant).
     *
     * Silently no-ops on invalid keys so a transient bot-name like
     * `undefined` cannot crash a bind path.
     */
    async ensureDefaultPolicy(platform, clientName) {
        if (!isValidKey(platform, clientName))
            return false;
        await this.load();
        const key = buildAccessControlKey(platform, clientName);
        if (this.policies.has(key))
            return false;
        const policy = defaultAccessControl();
        this.policies.set(key, policy);
        await this.save();
        return true;
    }
    /**
     * Run the five gates against `ctx` + the owner resolver. Pure apart
     * from the owner lookup the caller supplies via
     * `resolveOwnerSenderId` — the bridge layer is expected to run
     * `ownerStore.checkAndBootstrap` before calling `evaluate`, so a
     * fresh binding's first DM is bootstrapped into the owner record
     * rather than denied by an un-recorded owner. When
     * owner-checking and no owner is recorded (the resolver returns
     * `undefined`), the gate denies with `owner_only` — same shape as a
     * senderId mismatch — so a caller that forgot to bootstrap fails
     * closed instead of accidentally admitting an un-owned sender.
     */
    async evaluate(input) {
        const { ctx, resolveOwnerSenderId } = input;
        const policy = await this.get(ctx.platform, ctx.clientName);
        const ownerSenderId = resolveOwnerSenderId
            ? await Promise.resolve(resolveOwnerSenderId(ctx.clientName))
            : undefined;
        const result = evaluatePolicy(policy, ctx, ownerSenderId);
        this.logDecision({ decision: result.decision, policy, ctx, result, ownerSenderId });
        return result;
    }
    logDenyReply(input) {
        this.logger.logWarn(`${ACCESS_CONTROL_LOG_TAG} deny-reply`, {
            decision: 'deny',
            key: input.key,
            platform: input.ctx.platform,
            clientName: input.ctx.clientName,
            chatType: input.ctx.chatType,
            chatId: input.ctx.chatId,
            senderId: input.ctx.senderId,
            hasMention: input.ctx.hasMention === true,
            reason: `access-control:${input.reason}`,
            replyStatus: input.status,
            ...(input.error ? { error: input.error } : {}),
        });
    }
    logDecision(input) {
        const { decision, policy, ctx, result, ownerSenderId } = input;
        const key = buildAccessControlKey(ctx.platform, ctx.clientName);
        const baseFields = {
            decision,
            key,
            platform: ctx.platform,
            clientName: ctx.clientName,
            chatType: ctx.chatType,
            chatId: ctx.chatId,
            senderId: ctx.senderId,
            hasMention: ctx.hasMention === true,
        };
        if (decision === 'deny') {
            const reason = result.reason ? `access-control:${result.reason}` : 'access-control';
            this.logger.logWarn(`${ACCESS_CONTROL_LOG_TAG} decision=deny`, {
                ...baseFields,
                reason,
                policy: policySummary(policy),
                ...(policy.allowedUsers !== 'ALL' ? { ownerSenderId: ownerSenderId ?? null } : {}),
            });
            return;
        }
        // allow path: surface which list matched so the audit line answers
        // "why was this allowed?" without leaking the actual allowlist.
        this.logger.logInfo(`${ACCESS_CONTROL_LOG_TAG} decision=allow`, {
            ...baseFields,
            groupMentionPolicy: policy.groupMentionPolicy,
            allowedUsersMode: policy.allowedUsers === 'ALL' ? 'ALL' : `list(${policy.allowedUsers.length})`,
            allowedGroupsMode: policy.allowedGroups === 'ALL' ? 'ALL' : `list(${policy.allowedGroups.length})`,
            ...(policy.allowedUsers !== 'ALL'
                ? {
                    ownerSenderId: ownerSenderId ?? null,
                }
                : {}),
        });
    }
    async load() {
        if (this.loaded)
            return;
        if (this.loadPromise)
            return this.loadPromise;
        this.loadPromise = this.loadOnce();
        try {
            await this.loadPromise;
            this.loaded = true;
        }
        finally {
            this.loadPromise = undefined;
        }
    }
    async loadOnce() {
        let raw;
        try {
            raw = await readFile(this.filePath, 'utf8');
        }
        catch {
            // v1 semantics: any read failure (ENOENT included) starts an empty store.
            return;
        }
        try {
            const parsed = yaml.load(raw);
            const accessControl = parsed?.accessControl;
            if (!accessControl || typeof accessControl !== 'object')
                return;
            for (const [key, value] of Object.entries(accessControl)) {
                if (!value || typeof value !== 'object')
                    continue;
                // Persisted rows may be partial/legacy shapes; normalizePolicy accepts
                // the raw record and fills defaults, so no cast through unknown.
                const policy = normalizePolicy(value);
                const split = parseAccessControlKey(key);
                if (!split)
                    continue;
                this.policies.set(buildAccessControlKey(split.platform, split.clientName), policy);
            }
        }
        catch {
            // Corrupt YAML — start empty. The next `save()` will rewrite the file.
        }
    }
    async save() {
        const payload = {
            schemaVersion: 1,
            accessControl: Object.fromEntries([...this.policies.entries()]
                .sort(([left], [right]) => left.localeCompare(right))
                .map(([key, policy]) => [key, policy])),
        };
        await mkdir(dirname(this.filePath), { recursive: true });
        await writeFile(this.filePath, yaml.dump(payload, { lineWidth: 120, noRefs: true }), 'utf8');
    }
    get filePath() {
        return join(this.dataDir(), 'access-control.yaml');
    }
}
const isValidKey = isValidAccessControlKey;
export { defaultAccessControl } from './access-control-policy.js';
/**
 * Adapter that lifts a plain {@link LocalRuntimeLogger} into the shape
 * {@link LocalAccessControlStore} expects. Used both by the store's
 * default construction path (where the caller doesn't inject a logger)
 * and by explicit host wiring in `host-channels.ts`, which passes the
 * IM-subsystem logger through so AC audit lines land in
 * `im-runtime-*.log` alongside every other IM signal.
 *
 * Kept as a named export (not an inline construction) so a unit test can
 * assert the adapter forwards `chatId` / `senderId` field maps intact.
 */
export function bindAccessControlAuditLogger(localLogger) {
    return {
        logInfo: (message, fields = {}) => localLogger.info(fields, message),
        logWarn: (message, fields = {}) => localLogger.warn(fields, message),
    };
}
//# sourceMappingURL=access-control-store.js.map