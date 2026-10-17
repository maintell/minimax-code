/**
 * WeChat (iLink) channel binding store and usable-credential predicates.
 *
 * Migration copy (MR1): store half of v1 `channels/wechat.ts` (the v1 file
 * mixed Store + HTTP Api + outbound client; proposal §4 requires the split).
 * Owns `wechat-channel.yaml` persistence, the QR-pending placeholder rules
 * and the iLink long-poll cursor (`getUpdatesBuf`). The HTTP Api surface
 * stays with v1 until MR3; the outbound client moves with the transport
 * adapter batch.
 */
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import yaml from 'js-yaml';
import { normalizeWeChatBinding } from './wechat-binding-serde.js';
export class LocalWeChatChannelStore {
    dataDir;
    nowMs;
    loaded = false;
    bindings = new Map();
    familyHook;
    constructor(dataDir, nowMs) {
        this.dataDir = dataDir;
        this.nowMs = nowMs;
    }
    /** Resolve the active dataDir; exposed so adapters can co-locate scratch files. */
    getDataDir() {
        return this.dataDir();
    }
    /** Install the shared primary-family write seam (plan §5.2). */
    setFamilyMutationHook(hook) {
        this.familyHook = hook;
    }
    /** True only while the host has installed a trusted primary-family hook. */
    async isPrimaryFamilyAgent(agentName, kind = 'bind') {
        return (await this.familyHook?.isPrimaryFamilyAgent(agentName.trim(), kind)) === true;
    }
    /** Copy one binding's whole credential group onto another agentName. */
    async cloneBindingForAgent(input) {
        await this.load();
        const source = this.bindings.get(wechatClientId(input.fromAgentName.trim()));
        if (!source)
            return undefined;
        const toAgentName = input.toAgentName.trim();
        const clientId = wechatClientId(toAgentName);
        const existing = this.bindings.get(clientId);
        const record = {
            ...source,
            clientId,
            agentName: toAgentName,
            enabled: input.enabled,
            createdAt: existing?.createdAt ?? source.createdAt,
            updatedAt: this.nowMs(),
        };
        this.bindings.set(clientId, record);
        await this.save();
        return { ...record };
    }
    /** Flip one record's `enabled` flag without touching its credentials. */
    async setEnabled(agentName, enabled) {
        await this.load();
        const clientId = wechatClientId(agentName.trim());
        const existing = this.bindings.get(clientId);
        if (!existing)
            return undefined;
        if (existing.enabled === enabled)
            return { ...existing };
        const record = { ...existing, enabled, updatedAt: this.nowMs() };
        this.bindings.set(clientId, record);
        await this.save();
        return { ...record };
    }
    async bind(input) {
        await this.load();
        const agentName = input.agentName.trim();
        const clientId = wechatClientId(agentName);
        const existing = this.bindings.get(clientId);
        const now = this.nowMs();
        const botToken = input.botToken.trim();
        const pending = isPendingWeChatBindingToken(botToken);
        // Staged disabled for the primary family — see `feishu.ts` bind(). A QR
        // pending record is also always disabled, including for a custom Agent:
        // it proves neither a credential nor a transport and must never become a
        // family winner before the confirmation write below.
        const primaryFamily = input.suppressFamilyMutation !== true && (await this.isPrimaryFamilyAgent(agentName));
        const record = {
            clientId,
            agentName,
            botToken,
            ...readTrimmedBindOptionals(input),
            connected: input.connected ?? false,
            enabled: !pending && !primaryFamily,
            mode: input.mode ?? 'polling',
            createdAt: existing?.createdAt ?? now,
            updatedAt: now,
        };
        this.bindings.set(clientId, record);
        await this.save();
        // Pending QR creation still resolved the trusted family above (so a manual
        // reserved primary name fails closed), but does not reconcile/activate a
        // placeholder. The confirmed write is the first mutation that may start a
        // real winner.
        if (primaryFamily && !pending) {
            await this.familyHook?.afterMutation({ agentName, kind: 'bind' });
        }
        return { ...(this.bindings.get(clientId) ?? record) };
    }
    async unbind(agentName, options) {
        await this.load();
        const trimmed = agentName.trim();
        const existing = this.bindings.get(wechatClientId(trimmed));
        const deleted = this.bindings.delete(wechatClientId(trimmed));
        if (deleted)
            await this.save();
        if (existing &&
            deleted &&
            options?.suppressFamilyMutation !== true &&
            (await this.isPrimaryFamilyAgent(trimmed, 'unbind')) === true) {
            const identity = existing.ilinkBotId?.trim() || existing.botToken.trim();
            await this.familyHook?.afterMutation({
                agentName: trimmed,
                kind: 'unbind',
                unbound: { enabled: existing.enabled, ...(identity ? { identity } : {}) },
            });
        }
        return deleted;
    }
    /**
     * Persist the iLink long-poll cursor for a bound agent. Returns true on
     * write, false when the binding does not exist (rare: the monitor wire
     * survived an unbind by a few ms). Treats empty/identical cursors as
     * no-ops to avoid spamming the YAML file on every poll tick.
     */
    async setGetUpdatesBuf(agentName, cursor) {
        await this.load();
        const clientId = wechatClientId(agentName.trim());
        const existing = this.bindings.get(clientId);
        if (!existing)
            return false;
        const next = cursor.trim();
        if ((existing.getUpdatesBuf ?? '') === next)
            return false;
        const updated = {
            ...existing,
            ...(next ? { getUpdatesBuf: next } : {}),
            updatedAt: this.nowMs(),
        };
        if (!next)
            delete updated.getUpdatesBuf;
        this.bindings.set(clientId, updated);
        await this.save();
        return true;
    }
    async get(agentName) {
        await this.load();
        const record = this.bindings.get(wechatClientId(agentName.trim()));
        return record ? { ...record } : undefined;
    }
    async getByBindSessionId(sessionId) {
        await this.load();
        const record = [...this.bindings.values()].find((binding) => binding.bindSessionId === sessionId);
        return record ? { ...record } : undefined;
    }
    async list() {
        await this.load();
        return [...this.bindings.values()]
            .sort((a, b) => a.clientId.localeCompare(b.clientId))
            .map((record) => ({ ...record }));
    }
    async load() {
        if (this.loaded)
            return;
        this.loaded = true;
        // v1 semantics: any read failure (first boot included) starts empty.
        let raw;
        try {
            raw = await readFile(this.filePath, 'utf8');
        }
        catch {
            return;
        }
        if (!raw)
            return;
        const parsed = yaml.load(raw);
        const bindings = parsed?.bindings;
        if (!bindings || typeof bindings !== 'object')
            return;
        for (const [clientId, value] of Object.entries(bindings)) {
            const record = normalizeWeChatBinding(clientId, value);
            if (record)
                this.bindings.set(record.clientId, record);
        }
    }
    async save() {
        const payload = {
            schemaVersion: 1,
            bindings: Object.fromEntries([...this.bindings.entries()].sort(([left], [right]) => left.localeCompare(right))),
        };
        await mkdir(dirname(this.filePath), { recursive: true });
        await writeFile(this.filePath, yaml.dump(payload, { lineWidth: 120, noRefs: true }), {
            encoding: 'utf8',
            mode: 0o600,
        });
        await chmod(this.filePath, 0o600);
    }
    get filePath() {
        return join(this.dataDir(), 'wechat-channel.yaml');
    }
}
/**
 * A persisted QR placeholder or rollback row is not a transport credential.
 * Keep every send-facing gate fail-closed on this one predicate.
 */
export function isUsableWeChatBinding(record) {
    if (!record?.enabled || !record.connected || record.mode !== 'polling')
        return false;
    return Boolean(record.botToken.trim()) && !isPendingWeChatBindingToken(record.botToken);
}
/** Exported for the legacy Api facade's configCheck (MR2); single predicate. */
export function isPendingWeChatBindingToken(botToken) {
    return botToken?.startsWith('pending:') === true;
}
export function wechatClientId(agentName) {
    return `wechat:${agentName.trim() || 'mavis'}`;
}
/** Optional bind() inputs, trimmed; empty strings stay omitted. */
function readTrimmedBindOptionals(input) {
    const fields = {};
    for (const key of [
        'ilinkBotId',
        'baseUrl',
        'webhookToken',
        'botName',
        'bindSessionId',
        'qrcodeToken',
        'qrcodeUrl',
    ]) {
        const trimmed = input[key]?.trim();
        if (trimmed)
            fields[key] = trimmed;
    }
    return fields;
}
//# sourceMappingURL=wechat-store.js.map