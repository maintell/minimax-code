import { readModelAccessMetadata } from '../model-access/projection.js';
import { readFailoverConfig } from './pool-config.js';
/** Internal connections keep their identity. The first entry remains a stable route key. */
export function joinSubscriptionGroup(tree, key, binding) {
    const current = tree[key];
    const facts = binding(key);
    if (!current || !facts?.identityHash)
        return;
    const meta = readModelAccessMetadata(current);
    if (meta?.groupEntryKey)
        return;
    const existing = Object.keys(tree).find((other) => {
        if (Object.keys(tree).indexOf(other) >= Object.keys(tree).indexOf(key))
            return false;
        const candidate = binding(other);
        return (!!readModelAccessMetadata(tree[other]) &&
            candidate?.kind !== 'public' &&
            candidate?.installationId === facts.installationId &&
            candidate?.providerId === facts.providerId &&
            !!facts.namespaceHash &&
            candidate?.namespaceHash === facts.namespaceHash);
    });
    const root = existing
        ? (readModelAccessMetadata(tree[existing])?.groupEntryKey ?? existing)
        : key;
    const owner = tree[root];
    if (!owner)
        return;
    const old = readFailoverConfig(owner);
    const selected = old.members ?? [root, ...(old.enabled ? old.backups : [])];
    const members = appendAccount(selected, key, facts.identityHash, binding);
    current.options = {
        ...current.options,
        modelAccess: {
            ...current.options?.modelAccess,
            groupEntryKey: root,
            groupNamespace: facts.namespaceHash,
        },
    };
    owner.options = {
        ...owner.options,
        modelAccess: {
            ...owner.options?.modelAccess,
            groupEntryKey: root,
            groupNamespace: facts.namespaceHash,
            failover: {
                enabled: members.length > 1,
                backups: members.filter((id) => id !== root),
                members,
            },
        },
    };
}
function appendAccount(selected, key, hash, binding) {
    const duplicate = selected.some((id) => id !== key && binding(id)?.identityHash === hash);
    return selected.includes(key) || duplicate || selected.length >= 6
        ? selected
        : [...selected, key];
}
/** Entries that joined this group (the anchor itself included). */
function groupEntries(tree, root) {
    return Object.keys(tree).filter((key) => key === root || readModelAccessMetadata(tree[key])?.groupEntryKey === root);
}
/** Distinct accounts in order: an entry without a credential is not an account. */
function distinctAccounts(keys, binding) {
    const seen = new Set();
    return keys.filter((key) => {
        const facts = binding(key);
        if (!facts || facts.kind === 'public')
            return false;
        const identity = facts.identityHash ?? key;
        if (seen.has(identity))
            return false;
        seen.add(identity);
        return true;
    });
}
/**
 * Account selection of a group after `removed` left it (or lost its credential). The next
 * selected account becomes first; when no selected account is left the
 * next joined account is promoted, so a group never serves nothing while it still has one.
 * The anchor key stays the provider's stable route; it is never a placeholder account.
 */
export function reselectGroupAccounts(tree, root, binding, removed) {
    const owner = tree[root];
    const joined = groupEntries(tree, root).filter((key) => key !== removed);
    const config = readFailoverConfig(owner);
    const selected = distinctAccounts((config.members ?? [root, ...(config.enabled ? config.backups : [])]).filter((key) => joined.includes(key)), binding);
    const members = selected.length ? selected : distinctAccounts(joined, binding).slice(0, 1);
    if (owner)
        owner.options = {
            ...owner.options,
            modelAccess: {
                ...owner.options?.modelAccess,
                groupEntryKey: root,
                failover: {
                    enabled: members.length > 1,
                    backups: members.filter((key) => key !== root),
                    members: [...members],
                },
            },
        };
    return members;
}
/** Whether any entry of the group still holds an account. */
export function groupHasAccount(tree, root, binding, removed) {
    return (distinctAccounts(groupEntries(tree, root).filter((key) => key !== removed), binding).length > 0);
}
/** Groups whose selection holds no account although one of their entries still does. */
export function groupsNeedingReselection(tree, binding) {
    return Object.keys(tree).filter((key) => {
        const meta = readModelAccessMetadata(tree[key]);
        const members = readFailoverConfig(tree[key]).members;
        return (meta?.groupEntryKey === key &&
            meta.bindingKind !== 'public' &&
            members !== undefined &&
            distinctAccounts(members, binding).length === 0 &&
            groupHasAccount(tree, key, binding));
    });
}
//# sourceMappingURL=pool-groups.js.map