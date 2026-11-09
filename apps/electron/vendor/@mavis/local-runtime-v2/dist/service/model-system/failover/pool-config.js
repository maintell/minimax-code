import { LocalModelProviderError } from '../contracts.js';
import { isModelAccessProvider, readModelAccessMetadata } from '../model-access/projection.js';
import { bindingStamp } from './pool-state.js';
/** At most this many backups follow the primary. */
export const FAILOVER_MAX_BACKUPS = 5;
const KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
export function readFailoverConfig(provider) {
    const access = provider?.options?.modelAccess;
    const raw = access && typeof access === 'object' && !Array.isArray(access)
        ? access.failover
        : undefined;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        return { enabled: false, backups: [] };
    const item = raw;
    const backups = Array.isArray(item.backups)
        ? [
            ...new Set(item.backups.filter((key) => typeof key === 'string' && KEY.test(key))),
        ]
        : [];
    const members = selectedMembers(item);
    return {
        enabled: item.enabled === true,
        backups: backups.slice(0, FAILOVER_MAX_BACKUPS),
        ...(members ? { members } : {}),
    };
}
function selectedMembers(item) {
    if (!Object.hasOwn(item, 'members'))
        return undefined;
    if (!Array.isArray(item.members))
        return [];
    return item.members
        .filter((key) => typeof key === 'string' && KEY.test(key))
        .slice(0, FAILOVER_MAX_BACKUPS + 1);
}
/** The configured entry is a model-access provider of the primary's extension provider. */
function entryProblem(tree, primaryKey, providerKey) {
    const provider = tree[providerKey];
    const meta = readModelAccessMetadata(provider);
    const primary = readModelAccessMetadata(tree[primaryKey]);
    if (!provider || !meta || !primary)
        return 'provider_missing';
    if (provider.enabled === false)
        return 'provider_disabled';
    return meta.installationId === primary.installationId && meta.providerId === primary.providerId
        ? undefined
        : 'provider_mismatch';
}
/** The committed binding still owns the entry's catalog and its package is active. */
function bindingProblem(deps, provider, binding) {
    const meta = readModelAccessMetadata(provider);
    if (!binding || !meta)
        return 'binding_missing';
    if (binding.kind === 'public')
        return 'public_provider';
    if (binding.installationId !== meta.installationId || binding.providerId !== meta.providerId)
        return 'binding_mismatch';
    if (binding.identityRevision !== meta.catalogIdentityRevision)
        return 'catalog_stale';
    return deps.installationActive?.(binding.installationId) === false
        ? 'installation_inactive'
        : undefined;
}
/** Why a configured member cannot serve; undefined when it is a valid pool member now. */
function memberProblem(deps, primaryKey, providerKey) {
    const tree = deps.config().custom_provider ?? {};
    const a = deps.binding(primaryKey);
    const b = deps.binding(providerKey);
    const namespace = readModelAccessMetadata(tree[primaryKey])?.groupNamespace ?? a?.namespaceHash;
    if ((namespace || b?.namespaceHash) && namespace !== b?.namespaceHash)
        return 'namespace_mismatch';
    return (entryProblem(tree, primaryKey, providerKey) ??
        bindingProblem(deps, tree[providerKey], deps.binding(providerKey)));
}
/** The primary may head a pool: a committed, non-public model-access binding of its own. */
function primaryProblem(deps, primaryKey) {
    const provider = deps.config().custom_provider?.[primaryKey];
    if (!provider || !isModelAccessProvider(provider))
        return 'provider_missing';
    const meta = readModelAccessMetadata(provider);
    const binding = deps.binding(primaryKey);
    if (!meta)
        return 'binding_missing';
    if (readFailoverConfig(provider).members)
        return groupedPrimaryProblem(meta);
    if (!binding)
        return 'binding_missing';
    if (binding.kind === 'public' || meta.bindingKind === 'public')
        return 'public_provider';
    if (binding.installationId !== meta.installationId || binding.providerId !== meta.providerId)
        return 'binding_mismatch';
    return undefined;
}
function groupedPrimaryProblem(meta) {
    return meta.bindingKind === 'public' ? 'public_provider' : undefined;
}
/**
 * The pool for one call: the primary, then each configured backup that is still a valid member
 * and a different account (identity hash) than everyone before it. Undefined when failover is
 * off or no backup is valid, so the call runs exactly as a single provider.
 */
export function failoverPlan(deps, primaryKey) {
    const config = readFailoverConfig(deps.config().custom_provider?.[primaryKey]);
    if (config.members)
        return selectedPlan(deps, primaryKey, config.members);
    if (!config.enabled || config.backups.length === 0)
        return undefined;
    if (primaryProblem(deps, primaryKey))
        return undefined;
    const primaryBinding = deps.binding(primaryKey);
    const members = [
        {
            providerKey: primaryKey,
            installationId: primaryBinding.installationId,
            providerId: primaryBinding.providerId,
            primary: true,
        },
    ];
    const seen = new Set([identityOf(primaryBinding, primaryKey)]);
    for (const key of config.backups) {
        if (key === primaryKey || memberProblem(deps, primaryKey, key))
            continue;
        const binding = deps.binding(key);
        const identity = identityOf(binding, key);
        if (seen.has(identity))
            continue;
        seen.add(identity);
        members.push({
            providerKey: key,
            installationId: binding.installationId,
            providerId: binding.providerId,
            primary: false,
        });
    }
    return members.length > 1 ? { primaryKey, members } : undefined;
}
function selectedPlan(deps, primaryKey, selected) {
    if (deps.config().custom_provider?.[primaryKey]?.enabled === false)
        return { primaryKey, members: [], grouped: true };
    const seen = new Set();
    const members = selected.flatMap((key) => {
        if (memberProblem(deps, primaryKey, key))
            return [];
        const binding = deps.binding(key);
        if (!binding || seen.has(identityOf(binding, key)))
            return [];
        seen.add(identityOf(binding, key));
        return [
            {
                providerKey: key,
                installationId: binding.installationId,
                providerId: binding.providerId,
                primary: key === primaryKey,
            },
        ];
    });
    return { primaryKey, members, grouped: true };
}
/** Two members with the same identity hash are one account. */
function identityOf(binding, providerKey) {
    return binding.identityHash ?? `key:${providerKey}`;
}
function invalid(message, code) {
    return new LocalModelProviderError(400, message, code);
}
function assertPrimary(deps, primaryKey) {
    const problem = primaryProblem(deps, primaryKey);
    if (problem === 'provider_missing')
        throw new LocalModelProviderError(404, 'Provider not found', 'MODEL_ACCESS_FAILOVER_NOT_FOUND');
    if (problem)
        throw invalid('This provider cannot use backup accounts', 'MODEL_ACCESS_FAILOVER_UNSUPPORTED');
}
function assertMember(deps, primaryKey, key) {
    if (!KEY.test(key))
        throw invalid('Invalid backup account', 'MODEL_ACCESS_FAILOVER_INVALID_MEMBER');
    if (key === primaryKey)
        throw invalid('The primary account cannot be its own backup', 'MODEL_ACCESS_FAILOVER_PRIMARY_MEMBER');
    if (memberProblem(deps, primaryKey, key))
        throw invalid('A backup must be another account of the same extension provider', 'MODEL_ACCESS_FAILOVER_INVALID_MEMBER');
}
/** Validates a requested pool against the member rules; returns the keys to persist. */
export function validateFailover(deps, primaryKey, backups) {
    assertPrimary(deps, primaryKey);
    if (backups.length > FAILOVER_MAX_BACKUPS)
        throw invalid('At most five backup accounts', 'MODEL_ACCESS_FAILOVER_TOO_MANY');
    if (new Set(backups).size !== backups.length)
        throw invalid('A backup account is listed twice', 'MODEL_ACCESS_FAILOVER_DUPLICATE_MEMBER');
    const primaryBinding = deps.binding(primaryKey);
    const seen = new Set(primaryBinding ? [identityOf(primaryBinding, primaryKey)] : []);
    for (const key of backups) {
        assertMember(deps, primaryKey, key);
        const identity = identityOf(deps.binding(key), key);
        if (seen.has(identity))
            throw invalid('The same account is already in the pool', 'MODEL_ACCESS_FAILOVER_DUPLICATE_ACCOUNT');
        seen.add(identity);
    }
    return [...backups];
}
/** Display state of one member; a configured member that no longer qualifies is "invalid". */
function memberView(deps, state, primaryKey, providerKey) {
    const provider = deps.config().custom_provider?.[providerKey];
    const binding = deps.binding(providerKey);
    const base = {
        providerKey,
        name: provider?.name ?? providerKey,
        ...(binding?.accountMasked ? { accountMasked: binding.accountMasked } : {}),
        ...(binding && binding.kind !== 'public' ? { bindingKind: binding.kind } : {}),
    };
    const problem = memberProblem(deps, primaryKey, providerKey);
    if (problem)
        return { ...base, state: 'invalid', reasonCode: problem };
    if (binding && state.needsReauth(providerKey, bindingStamp(binding)))
        return { ...base, state: 'reauth_required', reasonCode: 'reauth_required' };
    const cooling = state.cooldowns(providerKey);
    if (cooling.length > 0) {
        // The member rest (if any) governs every model; otherwise the soonest model to come back.
        const own = state.memberCooldown(providerKey);
        const shown = own ?? cooling.reduce((a, b) => (b.until < a.until ? b : a));
        return { ...base, state: 'cooling', retryAt: shown.until, reasonCode: shown.reason };
    }
    return { ...base, state: 'available' };
}
export function failoverView(deps, state, primaryKey) {
    const tree = deps.config().custom_provider ?? {};
    const supported = primaryProblem(deps, primaryKey) === undefined;
    const config = readFailoverConfig(tree[primaryKey]);
    if (!supported)
        return { supported: false, enabled: false, backups: [], candidates: [] };
    const primary = readModelAccessMetadata(tree[primaryKey]);
    const backups = config.backups
        .filter((key) => key !== primaryKey)
        .map((key) => memberView(deps, state, primaryKey, key));
    const listed = new Set([primaryKey, ...config.backups]);
    const candidates = Object.keys(tree)
        .filter((key) => !listed.has(key))
        .filter((key) => {
        const meta = readModelAccessMetadata(tree[key]);
        return (!!meta &&
            meta.bindingKind !== 'public' &&
            meta.installationId === primary.installationId &&
            meta.providerId === primary.providerId);
    })
        .map((key) => memberView(deps, state, primaryKey, key));
    return {
        supported,
        enabled: config.enabled,
        backups,
        candidates,
        ...(config.members ? { selected: config.members } : {}),
    };
}
//# sourceMappingURL=pool-config.js.map