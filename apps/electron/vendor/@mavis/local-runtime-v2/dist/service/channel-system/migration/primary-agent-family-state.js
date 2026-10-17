/**
 * Migration copy (MR1) of v1 `channels/primary-agent-family-state.ts`.
 */
import { LocalChannelRouteStore } from '../routing/route-rules.js';
import { imGatewayInboundClientName, } from '../binding/storage/owner-store.js';
import { buildAccessControlKey, } from '../access-control/access-control-store.js';
import { imLogger as logger } from '@mavis/shared/local-runtime-logging/im-logger';
/**
 * Decide (`inspect`) or perform (`apply`) the whole associated-state migration.
 *
 * `inspect` must run — and come back clean — before `apply`, because the four
 * stores cannot be written atomically: refusing up front is what keeps a
 * conflicting family from ending up half-migrated with widened permissions.
 */
export async function migratePrimaryFamilyState(input, mode) {
    const conflicts = [];
    let moved = 0;
    let deduped = 0;
    const collect = (result) => {
        conflicts.push(...result.conflicts);
        moved += result.moved;
        deduped += result.deduped;
    };
    const routeStore = await LocalChannelRouteStore.load(input.dataDir(), input.defaultAgentName, input.nowMs);
    collect(await routeStore.rekeyPrimaryFamily({
        from: { clientName: input.legacy.clientId, agentId: input.legacy.agentName },
        to: { clientName: input.canonical.clientId, agentId: input.canonical.agentName },
        mode,
    }));
    collect(await input.bindingStore.rekeyPrimaryFamily({
        from: { clientName: input.legacy.clientId, agentName: input.legacy.agentName },
        to: { clientName: input.canonical.clientId, agentName: input.canonical.agentName },
        mode,
    }));
    // Both key conventions: the daemon `*ClientId` key and the imGateway inbound
    // `${agentName}:${platform}` key. Migrating only one leaves an owner record
    // that still names the legacy client and denies the surviving binding.
    collect(await input.ownerStore.rekeyPrimaryFamily({
        keys: [
            { from: input.legacy.clientId, to: input.canonical.clientId },
            {
                from: imGatewayInboundClientName(input.legacy.agentName, input.platform),
                to: imGatewayInboundClientName(input.canonical.agentName, input.platform),
            },
        ],
        mode,
    }));
    collect(await migrateAccessControl(input, mode));
    logger.info({
        platform: input.platform,
        mode,
        canonical_agent: input.canonical.agentName,
        legacy_agent: input.legacy.agentName,
        conflicts: conflicts.length,
        moved,
        deduped,
    }, 'primary_agent_channel_state_migration');
    return { conflicts, moved, deduped };
}
/**
 * Access Control (plan §6.3). Uses the store's public per-key surface, so no
 * extra store method is needed and the YAML map stays encapsulated.
 *
 * Same three-way rule as Owner: copy when canonical is empty, dedupe when both
 * sides are equal, conflict when they differ. Allowlists are NEVER unioned and
 * `ALL` is never chosen automatically — a merge that widens who can talk to the
 * surviving bot is exactly the failure this MR exists to prevent.
 */
async function migrateAccessControl(input, mode) {
    const store = input.accessControlStore;
    if (!store)
        return { conflicts: [], moved: 0, deduped: 0 };
    const legacyKey = buildAccessControlKey(input.platform, input.legacy.clientId);
    const canonicalKey = buildAccessControlKey(input.platform, input.canonical.clientId);
    const records = await store.list();
    const legacy = records.find((record) => record.key === legacyKey);
    if (!legacy)
        return { conflicts: [], moved: 0, deduped: 0 };
    const canonical = records.find((record) => record.key === canonicalKey);
    if (canonical && !policiesEqual(canonical.policy, legacy.policy)) {
        return { conflicts: [`access_control:${canonicalKey}`], moved: 0, deduped: 0 };
    }
    if (canonical) {
        if (mode === 'apply')
            await store.delete(input.platform, input.legacy.clientId);
        return { conflicts: [], moved: 0, deduped: 1 };
    }
    if (mode === 'apply') {
        await store.set(input.platform, input.canonical.clientId, legacy.policy);
        await store.delete(input.platform, input.legacy.clientId);
    }
    return { conflicts: [], moved: 1, deduped: 0 };
}
/** Structural policy equality — order-insensitive for the two allowlists. */
function policiesEqual(left, right) {
    return (left.groupMentionPolicy === right.groupMentionPolicy &&
        allowListEqual(left.allowedUsers, right.allowedUsers) &&
        allowListEqual(left.allowedGroups, right.allowedGroups));
}
function allowListEqual(left, right) {
    if (left === 'ALL' || right === 'ALL')
        return left === right;
    if (left.length !== right.length)
        return false;
    const sortedLeft = [...left].sort();
    const sortedRight = [...right].sort();
    return sortedLeft.every((value, index) => value === sortedRight[index]);
}
//# sourceMappingURL=primary-agent-family-state.js.map