/**
 * Feishu channel binding store and persisted-record codec.
 *
 * Migration copy (MR1): store half of v1 `channels/feishu.ts`, which mixed
 * Store + HTTP Api + event parsing in one file (proposal §4 requires the
 * split). This file owns `feishu-channel.yaml` persistence and the record
 * normalization rules; the HTTP Api surface stays with v1 until the MR3
 * delivery takeover, and event parsing moves to the transport adapter files.
 */
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import yaml from 'js-yaml';
import { imLogger as logger } from '@mavis/shared/local-runtime-logging/im-logger';
import { readFirstString } from '../../record-read.js';
export class LocalFeishuChannelStore {
    dataDir;
    nowMs;
    // Promise-based dedup so concurrent first-touch callers (eager
    // `startFeishuWs()` + `restoreInboundLoops()` both firing at host
    // construction) all await the same in-flight read. The previous
    // boolean `loaded` was flipped synchronously before the I/O resolved,
    // which let a second caller see `loaded === true` and skip the read —
    // returning a half-populated `bindings` map (`records: 0` even when
    // the YAML on disk was valid). See fix/feishu-store-load-race.
    loadPromise = null;
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
        const clientId = feishuClientId(agentName);
        const existing = this.bindings.get(clientId);
        const now = this.nowMs();
        // A primary-family candidate is staged disabled: the reconciler below is
        // the only writer allowed to enable a family record, so a crash between
        // this save and the reconcile leaves "no transport", never two.
        const primaryFamily = input.suppressFamilyMutation !== true && (await this.isPrimaryFamilyAgent(agentName));
        const record = buildFeishuBindingRecord({
            input,
            clientId,
            agentName,
            existing,
            now,
            primaryFamily,
        });
        this.bindings.set(clientId, record);
        await this.save();
        if (primaryFamily) {
            await this.familyHook?.afterMutation({ agentName, kind: 'bind' });
        }
        // Re-read: the reconcile may have enabled this record (canonical winner) or
        // left it disabled (legacy shadow). Callers gate transport start on it.
        return { ...(this.bindings.get(clientId) ?? record) };
    }
    async unbind(agentName, options) {
        await this.load();
        const trimmed = agentName.trim();
        const existing = this.bindings.get(feishuClientId(trimmed));
        const deleted = this.bindings.delete(feishuClientId(trimmed));
        if (deleted)
            await this.save();
        if (existing &&
            deleted &&
            options?.suppressFamilyMutation !== true &&
            (await this.isPrimaryFamilyAgent(trimmed, 'unbind')) === true) {
            const identity = existing.appId.trim();
            await this.familyHook?.afterMutation({
                agentName: trimmed,
                kind: 'unbind',
                unbound: { enabled: existing.enabled, ...(identity ? { identity } : {}) },
            });
        }
        return deleted;
    }
    /**
     * Copy one binding's whole credential group onto another agentName (plan
     * §5.3: never merge two credentials field by field). Narrow on purpose — the
     * reconciler is the only caller and the raw YAML map stays private.
     */
    async cloneBindingForAgent(input) {
        await this.load();
        const source = this.bindings.get(feishuClientId(input.fromAgentName.trim()));
        if (!source)
            return undefined;
        const toAgentName = input.toAgentName.trim();
        const clientId = feishuClientId(toAgentName);
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
        const clientId = feishuClientId(agentName.trim());
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
        const record = this.bindings.get(feishuClientId(agentName.trim()));
        return record ? { ...record } : undefined;
    }
    async list() {
        await this.load();
        return [...this.bindings.values()]
            .sort((a, b) => a.clientId.localeCompare(b.clientId))
            .map((record) => ({ ...record }));
    }
    load() {
        // Concurrent callers (eager WS start + restoreInboundLoops fire in
        // the same tick) all await the same in-flight read instead of racing
        // on a boolean flag. On failure the promise is cleared so the next
        // caller retries — useful for transient FS errors (EAGAIN, etc.).
        if (this.loadPromise)
            return this.loadPromise;
        this.loadPromise = this.doLoadLogged();
        return this.loadPromise;
    }
    /** doLoad + shared failure logging; clears the in-flight cache for a retry. */
    async doLoadLogged() {
        try {
            await this.doLoad();
        }
        catch (err) {
            this.loadPromise = null;
            const code = err && typeof err === 'object' ? err.code : undefined;
            logger.error({
                errorName: err instanceof Error ? err.name : typeof err,
                ...(typeof code === 'string' ? { code } : {}),
                platform: 'feishu',
            }, 'Feishu binding store load failed');
            throw err;
        }
    }
    async doLoad() {
        // ENOENT is a valid first-boot state (no yaml yet) — keep it quiet.
        // Permission / I/O errors surface so the wrapper can log + retry.
        let raw;
        try {
            raw = await readFile(this.filePath, 'utf8');
        }
        catch (err) {
            if (err.code !== 'ENOENT')
                throw err;
        }
        if (!raw)
            return;
        const parsed = yaml.load(raw);
        const bindings = parsed?.bindings;
        if (!bindings || typeof bindings !== 'object')
            return;
        for (const [clientId, value] of Object.entries(bindings)) {
            const record = normalizeFeishuBinding(clientId, value);
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
        return join(this.dataDir(), 'feishu-channel.yaml');
    }
}
export function feishuClientId(agentName) {
    return agentName.trim() || 'mavis';
}
export function readFeishuAgentName(body, defaultAgentName) {
    const explicit = readFirstString(body, ['agentName', 'agentId', 'agent', 'agent_name']);
    if (explicit)
        return explicit;
    const name = readFirstString(body, ['name']);
    if (name && !isFeishuPlatformName(name))
        return name;
    return defaultAgentName;
}
function isFeishuPlatformName(value) {
    const normalized = value.trim().toLowerCase();
    return normalized === 'feishu' || normalized === 'lark';
}
/** Write-side record assembly for bind(); staging rule documented at the call site. */
function buildFeishuBindingRecord(build) {
    const { input, clientId, agentName, existing, now, primaryFamily } = build;
    return {
        clientId,
        agentName,
        appId: input.appId.trim(),
        appSecret: input.appSecret.trim(),
        ...(input.verificationToken?.trim()
            ? { verificationToken: input.verificationToken.trim() }
            : {}),
        ...(input.encryptKey?.trim() ? { encryptKey: input.encryptKey.trim() } : {}),
        ...(input.botName?.trim() ? { botName: input.botName.trim() } : {}),
        connected: true,
        enabled: !primaryFamily,
        mode: input.mode ??
            (existing?.mode === 'webhook' || existing?.mode === 'websocket'
                ? existing.mode
                : 'websocket'),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
    };
}
/** Optional persisted credential columns (round-trip preserving). */
function readOptionalPersistedFeishuFields(value) {
    const verificationToken = readFirstString(value, ['verificationToken']);
    const encryptKey = readFirstString(value, [
        'encryptKey',
        'encrypt_key',
        'encryptToken',
        'encrypt_token',
    ]);
    const botName = readFirstString(value, ['botName']);
    return {
        ...(verificationToken ? { verificationToken } : {}),
        ...(encryptKey ? { encryptKey } : {}),
        ...(botName ? { botName } : {}),
    };
}
function normalizeFeishuBinding(fallbackClientId, value) {
    if (!isRecord(value))
        return undefined;
    const agentName = readFirstString(value, ['agentName', 'agentId', 'agent']);
    const appId = readFirstString(value, ['appId', 'app_id']);
    const appSecret = readFirstString(value, ['appSecret', 'app_secret']);
    if (!agentName || !appId || !appSecret)
        return undefined;
    return {
        clientId: readFirstString(value, ['clientId']) ?? fallbackClientId,
        agentName,
        appId,
        appSecret,
        ...readOptionalPersistedFeishuFields(value),
        ...normalizePersistedFeishuState(value),
        createdAt: readNumber(value.createdAt) ?? Date.now(),
        updatedAt: readNumber(value.updatedAt) ?? Date.now(),
    };
}
function normalizeFeishuMode(value) {
    return value === 'webhook' || value === 'websocket' ? value : 'mock';
}
function normalizePersistedFeishuState(value) {
    const mode = normalizeFeishuMode(readFirstString(value, ['mode']));
    // Historical mock (and omitted/unknown legacy mode) remains readable so it
    // can be exactly unbound, but it can never be restored as a live transport.
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
//# sourceMappingURL=feishu-store.js.map