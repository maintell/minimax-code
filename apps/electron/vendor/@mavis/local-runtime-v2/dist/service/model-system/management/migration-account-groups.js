import { readModelAccessMetadata } from '../model-access/projection.js';
import { groupsNeedingReselection, joinSubscriptionGroup, reselectGroupAccounts, } from '../failover/pool-groups.js';
import { logger } from '@mavis/shared/local-runtime-logging';
/**
 * Group only proven matching namespaces; unknown borrowed identities wait for explicit refresh.
 * Also repairs a group whose selection lost every account by promoting the next account.
 */
export async function migrateSubscriptionGroups(packages, config) {
    const pending = (tree) => Object.keys(tree).filter((key) => {
        const metadata = readModelAccessMetadata(tree[key]);
        const binding = packages.bindingFacts.peek(key);
        return (metadata && !metadata.groupEntryKey && binding?.kind !== 'public' && binding?.namespaceHash);
    });
    const peek = (id) => packages.bindingFacts.peek(id);
    try {
        const current = config.read().custom_provider ?? {};
        if (!pending(current).length && !groupsNeedingReselection(current, peek).length)
            return;
        await config.updateByok((draft) => {
            const tree = (draft.custom_provider ?? {});
            // A group left without a selected account promotes the next account it still has.
            for (const root of groupsNeedingReselection(tree, peek))
                reselectGroupAccounts(tree, root, peek);
            for (const key of pending(tree))
                joinSubscriptionGroup(tree, key, peek);
            draft.custom_provider = tree;
        });
    }
    catch {
        logger.warn({ event: 'model_access_group_migration_pending' }, 'Account grouping deferred; original connections retained');
    }
}
//# sourceMappingURL=migration-account-groups.js.map