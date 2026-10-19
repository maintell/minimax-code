/**
 * Migration copy (MR1) of v1 `channels/primary-agent-family-platforms.ts`.
 */
import { feishuClientId } from '../transport/feishu/feishu-store.js';
import { telegramClientId, } from '../transport/telegram/telegram-store.js';
import { wechatClientId } from '../transport/wechat/wechat-store.js';
/** Build the three platform ports over the host's live stores. */
export function createPrimaryFamilyPlatformPorts(stores) {
    return {
        feishu: {
            platform: 'feishu',
            clientId: feishuClientId,
            list: async () => 
            // Legacy mock/unknown records stay in the store so the user can
            // exact-unbind them, but must never be considered a family winner.
            // Otherwise the reconciler can re-enable a disabled compatibility row
            // without a transport capable of starting it.
            (await stores.feishu.list())
                .filter((record) => record.mode === 'webhook' || record.mode === 'websocket')
                .map((record) => ({
                agentName: record.agentName,
                clientId: record.clientId,
                enabled: record.enabled,
                updatedAt: record.updatedAt,
                ...(record.appId?.trim() ? { identity: record.appId.trim() } : {}),
            })),
            cloneCredential: async (input) => toView(await stores.feishu.cloneBindingForAgent(input), (record) => record.appId),
            setEnabled: async (agentName, enabled) => toView(await stores.feishu.setEnabled(agentName, enabled), (record) => record.appId),
            deleteCredential: (agentName) => stores.feishu.unbind(agentName, { suppressFamilyMutation: true }),
        },
        telegram: {
            platform: 'telegram',
            clientId: telegramClientId,
            list: async () => (await stores.telegram.list())
                .filter((record) => record.mode === 'sdk')
                .map((record) => ({
                agentName: record.agentName,
                clientId: record.clientId,
                enabled: record.enabled,
                updatedAt: record.updatedAt,
                ...(record.botToken?.trim() ? { identity: record.botToken.trim() } : {}),
            })),
            cloneCredential: async (input) => toView(await stores.telegram.cloneBindingForAgent(input), (record) => record.botToken),
            setEnabled: async (agentName, enabled) => toView(await stores.telegram.setEnabled(agentName, enabled), (record) => record.botToken),
            deleteCredential: (agentName) => stores.telegram.unbind(agentName, { suppressFamilyMutation: true }),
        },
        wechat: {
            platform: 'wechat',
            clientId: wechatClientId,
            list: async () => (await stores.wechat.list())
                .filter((record) => record.mode === 'polling' && !record.botToken.startsWith('pending:'))
                .map((record) => ({
                agentName: record.agentName,
                clientId: record.clientId,
                enabled: record.enabled,
                updatedAt: record.updatedAt,
                ...(wechatIdentity(record) ? { identity: wechatIdentity(record) } : {}),
            })),
            cloneCredential: async (input) => toView(await stores.wechat.cloneBindingForAgent(input), wechatIdentity),
            setEnabled: async (agentName, enabled) => toView(await stores.wechat.setEnabled(agentName, enabled), wechatIdentity),
            deleteCredential: (agentName) => stores.wechat.unbind(agentName, { suppressFamilyMutation: true }),
        },
    };
}
function wechatIdentity(record) {
    return record.ilinkBotId?.trim() || record.botToken?.trim() || undefined;
}
function toView(record, identityOf) {
    if (!record)
        return undefined;
    const identity = identityOf(record)?.trim();
    return {
        agentName: record.agentName,
        clientId: record.clientId,
        enabled: record.enabled,
        updatedAt: record.updatedAt,
        ...(identity ? { identity } : {}),
    };
}
/**
 * Same stable platform identity on both sides (plan §5.3). A missing identity
 * on either side is NOT a match: without it the two records cannot be proven to
 * be the same bot, and a display name is not an identity.
 */
export function identitiesMatch(left, right) {
    if (!left.identity || !right.identity)
        return false;
    return left.identity === right.identity;
}
/**
 * Credential rotation (plan §5.3): adopt the whole credential group of the
 * side updated most recently, canonical winning a tie. Never merged field by
 * field — half of one app's secret with half of another's authenticates as
 * neither.
 */
export function pickCredentialSource(canonical, legacy) {
    if (!canonical)
        return legacy;
    return legacy.updatedAt > canonical.updatedAt ? legacy : canonical;
}
//# sourceMappingURL=primary-agent-family-platforms.js.map