/**
 * Migration copy (MR1) of v1 `channels/legacy-im-migration.ts`.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readFirstString } from '../record-read.js';
import { LocalFeishuChannelStore, feishuClientId } from '../transport/feishu/feishu-store.js';
import { LocalTelegramChannelStore, telegramClientId, } from '../transport/telegram/telegram-store.js';
import { LocalWeChatChannelStore, wechatClientId } from '../transport/wechat/wechat-store.js';
import { LocalChannelRouteStore } from '../routing/route-rules.js';
/** Rule id + route target agentId charset (mirrors route-api.ts). */
const AGENT_ID_REGEX = /^[a-z0-9-]+$/u;
const PLATFORM_SESSION_TITLE = {
    feishu: 'Feishu',
    telegram: 'Telegram',
    wechat: 'WeChat',
};
function emptyResult() {
    return { migrated: 0, skipped: 0, routesCreated: 0 };
}
/**
 * Reuses the legacy credential decoder to enumerate only valid historical
 * credential files. The marker can already be set when a prior build copied
 * credentials but never created a V2 physical Binding, so callers may safely
 * invoke this on every bounded V2 startup repair pass.
 */
export async function listLegacyImCredentialCandidates(dataDir) {
    const candidates = [];
    for (const agentName of await listAgentDirs(dataDir)) {
        for (const platform of ['feishu', 'telegram', 'wechat']) {
            const credential = await readLegacyCredential(dataDir, agentName, platform);
            if (!isUsableLegacyCredential(platform, credential))
                continue;
            candidates.push({
                key: `legacy-credential:${platform}:${clientNameForLegacyCredential(platform, agentName)}`,
                platform,
                agentName,
                clientName: clientNameForLegacyCredential(platform, agentName),
            });
        }
    }
    return candidates;
}
/**
 * Run the migration. Pure with respect to process env and receipt handling,
 * so it is directly
 * unit-testable and safe to invoke repeatedly.
 */
export async function migrateLegacyImCredentialsIfNeeded(options) {
    const feishu = emptyResult();
    const telegram = emptyResult();
    const wechat = emptyResult();
    for (const agent of await listAgentDirs(options.dataDir)) {
        await migrateFeishu(options, agent, feishu);
        await migrateTelegram(options, agent, telegram);
        await migrateWeChat(options, agent, wechat);
    }
    const { preserved, degraded } = await repairPinnedSessions(options);
    return {
        feishu,
        telegram,
        wechat,
        sessionsPreserved: preserved,
        sessionsDegraded: degraded,
    };
}
async function listAgentDirs(dataDir) {
    try {
        const entries = await readdir(join(dataDir, 'credentials'), { withFileTypes: true });
        return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    }
    catch (err) {
        if (err.code === 'ENOENT')
            return [];
        throw err;
    }
}
/**
 * Read + parse a legacy credential file, flattening the older nested
 * `{ platform, credentials: {...}, updatedAt }` shape into a single record so
 * both the flat (Feishu) and nested (Telegram/WeChat) layouts read uniformly.
 */
async function readLegacyCredential(dataDir, agent, platform) {
    let raw;
    try {
        raw = await readFile(join(dataDir, 'credentials', agent, `${platform}.json`), 'utf8');
    }
    catch (err) {
        if (err.code === 'ENOENT')
            return undefined;
        throw err;
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        return undefined;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        return undefined;
    const obj = parsed;
    const nested = obj.credentials;
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
        return { ...obj, ...nested };
    }
    return obj;
}
function isUsableLegacyCredential(platform, credential) {
    if (!credential)
        return false;
    if (platform === 'feishu') {
        return Boolean(readFirstString(credential, ['appId', 'app_id']) &&
            readFirstString(credential, ['appSecret', 'app_secret']));
    }
    const botToken = readFirstString(credential, ['botToken', 'bot_token', 'token']);
    return Boolean(botToken && (platform !== 'wechat' || !botToken.startsWith('pending:')));
}
function clientNameForLegacyCredential(platform, agentName) {
    if (platform === 'feishu')
        return feishuClientId(agentName);
    if (platform === 'telegram')
        return telegramClientId(agentName);
    return wechatClientId(agentName);
}
async function migrateFeishu(options, agent, result) {
    const cred = await readLegacyCredential(options.dataDir, agent, 'feishu');
    if (!cred)
        return;
    const appId = readFirstString(cred, ['appId', 'app_id']);
    const appSecret = readFirstString(cred, ['appSecret', 'app_secret']);
    if (!appId || !appSecret) {
        result.skipped += 1;
        options.observability.warn('channel.legacy_im_migration.feishu.malformed', {
            agent_name: agent,
        });
        return;
    }
    if (await options.feishuStore.get(agent)) {
        result.skipped += 1;
    }
    else {
        await options.feishuStore.bind({
            agentName: agent,
            appId,
            appSecret,
            ...readOptionalFeishuCredentialFields(cred),
            suppressFamilyMutation: true,
        });
        result.migrated += 1;
    }
    await ensureRoute({
        options,
        platform: 'feishu',
        agent,
        clientId: feishuClientId(agent),
        result,
    });
}
/** Optional legacy Feishu credential fields, with the forced-websocket rule. */
function readOptionalFeishuCredentialFields(cred) {
    const verificationToken = readFirstString(cred, [
        'verificationToken',
        'verification_token',
        'token',
    ]);
    const encryptKey = readFirstString(cred, [
        'encryptKey',
        'encrypt_key',
        'encryptToken',
        'encrypt_token',
    ]);
    const botName = readFirstString(cred, ['botName', 'bot_name']);
    // Legacy im_gateway credentials have no local transport concept; migrated
    // Feishu bots must connect via the local WebSocket. Only honor an explicit
    // legacy webhook/websocket value, otherwise force websocket so the record
    // never falls back to 'mock' (which host-channels-lifecycle silently skips).
    const mode = readFirstString(cred, ['mode']);
    return {
        ...(verificationToken ? { verificationToken } : {}),
        ...(encryptKey ? { encryptKey } : {}),
        ...(botName ? { botName } : {}),
        mode: mode === 'webhook' || mode === 'websocket' ? mode : 'websocket',
    };
}
async function migrateTelegram(options, agent, result) {
    const cred = await readLegacyCredential(options.dataDir, agent, 'telegram');
    if (!cred)
        return;
    const botToken = readFirstString(cred, ['botToken', 'bot_token', 'token']);
    if (!botToken) {
        result.skipped += 1;
        options.observability.warn('channel.legacy_im_migration.telegram.malformed', {
            agent_name: agent,
        });
        return;
    }
    if (await options.telegramStore.get(agent)) {
        result.skipped += 1;
    }
    else {
        // Bind offline via the store: the API's bind() performs a live getMe
        // network call, which must never run at startup migration time.
        await options.telegramStore.bind({
            agentName: agent,
            botToken,
            botName: readFirstString(cred, ['botName', 'bot_name', 'username']),
            mode: 'sdk',
            suppressFamilyMutation: true,
        });
        result.migrated += 1;
    }
    await ensureRoute({
        options,
        platform: 'telegram',
        agent,
        clientId: telegramClientId(agent),
        result,
    });
}
async function migrateWeChat(options, agent, result) {
    const cred = await readLegacyCredential(options.dataDir, agent, 'wechat');
    if (!cred)
        return;
    const botToken = readFirstString(cred, ['botToken', 'bot_token', 'token']);
    // Best-effort: an un-scanned QR bind (`pending:<session>`) carries no real
    // credential, so there is nothing durable to migrate.
    if (!botToken || botToken.startsWith('pending:')) {
        result.skipped += 1;
        options.observability.warn('channel.legacy_im_migration.wechat.pending_skipped', {
            agent_name: agent,
        });
        return;
    }
    const existing = await options.wechatStore.get(agent);
    if (existing?.botToken && !existing.botToken.startsWith('pending:')) {
        result.skipped += 1;
    }
    else {
        await options.wechatStore.bind({
            agentName: agent,
            botToken,
            ilinkBotId: readFirstString(cred, ['ilinkBotId', 'ilink_bot_id']),
            baseUrl: readFirstString(cred, ['baseUrl', 'base_url']),
            webhookToken: readFirstString(cred, ['webhookToken', 'webhook_token']),
            botName: readFirstString(cred, ['botName', 'bot_name']),
            mode: 'polling',
            connected: true,
            suppressFamilyMutation: true,
        });
        result.migrated += 1;
    }
    await ensureRoute({
        options,
        platform: 'wechat',
        agent,
        clientId: wechatClientId(agent),
        result,
    });
}
/**
 * Ensure a default route rule exists so inbound messages for `clientId`
 * resolve to `agent`. Idempotent: skips when a rule already targets that
 * clientName, and treats a duplicate-id 409 as a no-op.
 */
async function ensureRoute(route) {
    const { options, platform, agent, clientId, result } = route;
    if (!AGENT_ID_REGEX.test(agent)) {
        // Rule id + target agentId share this charset; a non-conforming agent name
        // cannot form a valid rule. The binding itself still succeeded.
        options.observability.warn(`channel.legacy_im_migration.${platform}.route_skipped_invalid_agent`, {
            agent_name: agent,
        });
        return;
    }
    if (options.routeStore.getRules(platform).some((rule) => rule.match.clientName === clientId)) {
        return;
    }
    const now = options.nowMs();
    const rule = {
        id: `legacy-${platform}-${agent}`,
        platform,
        match: { chatType: '*', chatId: '', senderId: '', clientName: clientId },
        target: {
            agentId: agent,
            sessionStrategy: 'root',
            sessionTitle: PLATFORM_SESSION_TITLE[platform],
            exactOwnerName: agent,
            projectKey: 'default',
            routingMode: 'project-main',
            generation: 0,
        },
        enabled: true,
        priority: 100,
        createdAt: now,
        updatedAt: now,
    };
    const added = await options.routeStore.addRule(rule);
    if ('error' in added) {
        // 409 = id already exists (idempotent no-op). Anything else is a real
        // rejection worth surfacing.
        if (added.error.status === 409)
            return;
        throw new Error(`Legacy ${platform} route migration rejected for agent ${agent}`);
    }
    result.routesCreated += 1;
}
/**
 * Legacy pin compatibility no-op. The persisted binding field is intentionally
 * not read or rewritten now that route resolution ignores it.
 */
async function repairPinnedSessions(options) {
    void options;
    return { preserved: 0, degraded: 0 };
}
//# sourceMappingURL=legacy-im-migration.js.map