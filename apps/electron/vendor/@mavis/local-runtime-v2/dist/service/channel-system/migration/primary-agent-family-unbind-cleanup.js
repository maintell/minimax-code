/**
 * Migration copy (MR1) of v1 `channels/primary-agent-family-unbind-cleanup.ts`.
 */
import { imLogger as logger } from '@mavis/shared/local-runtime-logging/im-logger';
import { clearOwnerAllConventions, } from '../binding/storage/owner-store.js';
import { LocalChannelRouteStore } from '../routing/route-rules.js';
/**
 * Clean up the exact client a primary-family unbind just deleted, before the
 * follow-up reconcile. Route cleanup is intentionally scoped to the matched
 * client ID: a sibling client may legitimately route to the same Agent.
 */
export async function cleanupPrimaryFamilyUnbound(cleanup) {
    const { input, platform, port, agentName, family } = cleanup;
    const clientId = port.clientId(agentName);
    await input.teardownTransport(platform, agentName);
    input.unregisterTransport(platform, clientId);
    const routeStore = await LocalChannelRouteStore.load(input.dataDir(), input.defaultAgentName, input.nowMs);
    const routeIds = routeStore
        .getRules(platform)
        .filter((rule) => rule.match.clientName === clientId)
        .map((rule) => rule.id);
    let removedRoutes = 0;
    for (const routeId of routeIds) {
        if (await routeStore.deleteRule(routeId))
            removedRoutes += 1;
    }
    const removedBindings = await input.bindingStore.deleteByAgentPlatform(agentName, platform);
    const clearedOwners = await clearOwnerAllConventions(input.ownerStore, agentName, platform, clientId);
    await input.accessControlStore?.delete(platform, clientId);
    logger.info({
        platform,
        ...(family ? { canonical_agent: family.canonicalName, winner_agent: family.winnerName } : {}),
        agentName,
        clientId,
        reason: 'exact_unbind_cleanup',
        removedRoutes,
        removedBindings,
        clearedOwners,
    }, 'primary_agent_channel_unbind_cleanup');
}
/**
 * A second explicit physical-winner unbind may encounter only the disabled shadow
 * left by its own successful migration. Delete that exact shadow before the
 * normal scan so it cannot become a new migration source. Every other state
 * keeps the existing reconcile path: identity is evidence, never a guess.
 */
export async function cleanupSettledPrimaryFamilyShadow(cleanup) {
    const { input, platform, port, family, agentName, unbound } = cleanup;
    if (agentName !== family.winnerName || unbound?.enabled !== true || !unbound.identity)
        return;
    const shadow = await findSettledShadow(port, family, unbound.identity);
    if (!shadow)
        return;
    if (!(await port.deleteCredential(shadow.agentName)))
        return;
    await cleanupPrimaryFamilyUnbound({ input, platform, port, agentName: shadow.agentName, family });
}
/**
 * The one deletable shadow: winner row gone, exactly one legacy row left,
 * disabled, and provably the same platform identity the unbind removed.
 */
async function findSettledShadow(port, family, unboundIdentity) {
    const records = await port.list();
    if (records.some((record) => record.agentName === family.winnerName))
        return undefined;
    const legacies = records.filter((record) => family.legacyNames.includes(record.agentName));
    if (legacies.length !== 1)
        return undefined;
    const [shadow] = legacies;
    if (!shadow || shadow.enabled || !shadow.identity || shadow.identity !== unboundIdentity)
        return undefined;
    return shadow;
}
//# sourceMappingURL=primary-agent-family-unbind-cleanup.js.map