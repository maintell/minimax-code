/**
 * Telegram channel binding store and persisted-record codec.
 *
 * Migration copy (MR1): store half of v1 `channels/telegram.ts` (the v1 file
 * mixed Store + HTTP Api + outbound client; proposal §4 requires the split).
 * Owns `telegram-channel.yaml` persistence and record normalization. The
 * HTTP Api surface stays with v1 until MR3; the outbound client moves with
 * the transport adapter batch.
 */
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import yaml from 'js-yaml';
import { readFirstString } from '../../record-read.js';
/** A persisted disabled or disconnected SDK row is not a transport credential. */
export function isUsableTelegramBinding(record) {
    if (!record?.enabled || !record.connected || record.mode !== 'sdk')
        return false;
    return Boolean(record.botToken.trim());
}
export class LocalTelegramChannelStore {
    dataDir;
    nowMs;
    loaded = false;
    bindings = new Map();
    familyHook;
    constructor(dataDir, nowMs) {
        this.dataDir = dataDir;
        this.nowMs = nowMs;
    }
    /** Install the shared primary-family write seam (plan §5.2). */
    setFamilyMutationHook(hook) {
        this.familyHook = hook;
    }
    /** True only while the host has installed a trusted primary-family hook. */
    async isPrimaryFamilyAgent(agentName, kind = 'bind') {
        return (await this.familyHook?.isPrimaryFamilyAgent(agentName.trim(), kind)) === true;
    }
    async bind(input) {
        await this.load();
        const agentName = input.agentName.trim();
        const clientId = telegramClientId(agentName);
        const existing = this.bindings.get(clientId);
        const now = this.nowMs();
        // Staged disabled for the primary family — see `feishu.ts` bind().
        const primaryFamily = input.suppressFamilyMutation !== true && (await this.isPrimaryFamilyAgent(agentName));
        const record = {
            clientId,
            agentName,
            botToken: input.botToken.trim(),
            ...(input.botName?.trim() ? { botName: input.botName.trim() } : {}),
            connected: true,
            enabled: !primaryFamily,
            mode: input.mode ?? 'sdk',
            createdAt: existing?.createdAt ?? now,
            updatedAt: now,
        };
        this.bindings.set(clientId, record);
        await this.save();
        if (primaryFamily) {
            await this.familyHook?.afterMutation({ agentName, kind: 'bind' });
        }
        return { ...(this.bindings.get(clientId) ?? record) };
    }
    async unbind(agentName, options) {
        await this.load();
        const trimmed = agentName.trim();
        const existing = this.bindings.get(telegramClientId(trimmed));
        const deleted = this.bindings.delete(telegramClientId(trimmed));
        if (deleted)
            await this.save();
        if (existing &&
            deleted &&
            options?.suppressFamilyMutation !== true &&
            (await this.isPrimaryFamilyAgent(trimmed, 'unbind')) === true) {
            const identity = existing.botToken.trim();
            await this.familyHook?.afterMutation({
                agentName: trimmed,
                kind: 'unbind',
                unbound: { enabled: existing.enabled, ...(identity ? { identity } : {}) },
            });
        }
        return deleted;
    }
    /** Copy one binding's whole credential group onto another agentName. */
    async cloneBindingForAgent(input) {
        await this.load();
        const source = this.bindings.get(telegramClientId(input.fromAgentName.trim()));
        if (!source)
            return undefined;
        const toAgentName = input.toAgentName.trim();
        const clientId = telegramClientId(toAgentName);
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
        const clientId = telegramClientId(agentName.trim());
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
    async get(agentName) {
        await this.load();
        const record = this.bindings.get(telegramClientId(agentName.trim()));
        return record ? { ...record } : undefined;
    }
    /**
     * Expose the configured data dir so peer components (e.g. the attachment
     * downloader) can scope their on-disk artefacts under the same root.
     * The accessor is read-only — direct mutation of the YAML store is the
     * store's responsibility.
     */
    getDataDir() {
        return this.dataDir();
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
            const record = normalizeTelegramBinding(clientId, value);
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
        // Explicit chmod — on some filesystems (e.g. FAT32 mounts inside CI) the
        // `mode` option is silently ignored.
        await chmod(this.filePath, 0o600);
    }
    get filePath() {
        return join(this.dataDir(), 'telegram-channel.yaml');
    }
}
export function telegramClientId(agentName) {
    return `telegram:${agentName.trim() || 'mavis'}`;
}
function normalizeTelegramBinding(fallbackClientId, value) {
    if (!isRecord(value))
        return undefined;
    const agentName = readFirstString(value, ['agentName', 'agentId', 'agent']);
    const botToken = readFirstString(value, ['botToken', 'token']);
    if (!agentName || !botToken)
        return undefined;
    return {
        clientId: readFirstString(value, ['clientId']) ?? fallbackClientId,
        agentName,
        botToken,
        ...(readFirstString(value, ['botName'])
            ? { botName: readFirstString(value, ['botName']) }
            : {}),
        ...normalizePersistedTelegramState(value),
        createdAt: readNumber(value.createdAt) ?? Date.now(),
        updatedAt: readNumber(value.updatedAt) ?? Date.now(),
    };
}
function normalizePersistedTelegramState(value) {
    const mode = value.mode === 'sdk' ? 'sdk' : 'mock';
    if (mode === 'mock')
        return { mode, connected: false, enabled: false };
    return { mode, connected: value.connected !== false, enabled: value.enabled !== false };
}
function isRecord(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}
function readNumber(value) {
    if (typeof value === 'number' && Number.isFinite(value))
        return value;
    if (typeof value === 'string') {
        const parsed = Number(value);
        if (Number.isFinite(parsed))
            return parsed;
    }
    return undefined;
}
//# sourceMappingURL=telegram-store.js.map