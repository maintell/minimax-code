import { LocalModelProviderError, } from '../../contracts.js';
import { poolCatalog } from '../../failover/pool-catalog.js';
import { failoverPlan } from '../../failover/pool-config.js';
import { readModelAccessMetadata } from '../../model-access/projection.js';
const DEFAULT_VISIBLE_MODELS = 5;
const CATALOG_PROVIDERS = {
    codex: ['openai'],
    copilot: ['github-copilot'],
    gemini: ['google'],
    antigravity: ['google'],
    zcode: ['zai', 'zhipuai', 'zai-coding-plan', 'zhipuai-coding-plan'],
    grok: ['xai'],
    kiro: ['anthropic', 'amazon-bedrock'],
};
/** Called only by explicit sign-in/borrow commits, never by ordinary catalog refresh. */
export async function resetSubscriptionModelDefaults(deps, tree, providerKey, signal) {
    const metadata = readModelAccessMetadata(tree[providerKey]);
    if (!metadata || metadata.bindingKind === 'public')
        return;
    const root = metadata.groupEntryKey ?? providerKey;
    const owner = tree[root];
    if (!owner)
        return;
    const plan = failoverPlan(deps, root);
    const members = plan?.grouped ? plan.members.map((m) => m.providerKey) : [providerKey];
    const catalog = plan?.grouped ? poolCatalog(deps, root) : (owner.models ?? {});
    const ids = Object.keys(catalog);
    const assertMembers = memberGuard(deps, members, signal);
    const ordered = await rankDefaults(deps.rankModelsByRecency, metadata.providerId, ids, signal);
    assertMembers();
    const visible = new Set(ordered.slice(0, DEFAULT_VISIBLE_MODELS));
    if (!plan?.grouped) {
        owner.models = Object.fromEntries(ordered.map((id) => [id, { ...catalog[id], enabled: visible.has(id) }]));
        return assertMembers;
    }
    applyGroupDefaults(tree, root, ordered, members);
    return assertMembers;
}
function subjectStamp(binding) {
    return JSON.stringify(binding && [
        binding.kind,
        binding.installationId,
        binding.providerId,
        binding.identityRevision,
        binding.identityHash,
        binding.namespaceHash,
    ]);
}
function memberGuard(deps, members, signal) {
    const stamps = members.map((key) => subjectStamp(deps.binding(key)));
    return () => {
        signal.throwIfAborted();
        if (members.some((key, index) => subjectStamp(deps.binding(key)) !== stamps[index]))
            throw new LocalModelProviderError(409, 'Extension account changed while selecting model defaults', 'MODEL_ACCESS_IDENTITY_CHANGED');
    };
}
async function rankDefaults(rank, providerId, ids, signal) {
    try {
        const ranked = await rank?.({
            modelIds: ids,
            preferredProviders: CATALOG_PROVIDERS[providerId] ?? [],
            signal,
        });
        // Ranking only reorders; an invalid or unavailable catalog keeps source order.
        return ranked?.length === ids.length &&
            new Set(ranked).size === ids.length &&
            ranked.every((id) => ids.includes(id))
            ? ranked
            : ids;
    }
    catch {
        signal.throwIfAborted();
        return ids;
    }
}
function applyGroupDefaults(tree, root, ordered, members) {
    const owner = tree[root];
    if (!owner)
        return;
    const visible = new Set(ordered.slice(0, DEFAULT_VISIBLE_MODELS));
    const access = owner.options?.modelAccess;
    owner.options = {
        ...owner.options,
        modelAccess: {
            ...access,
            modelOrder: ordered,
            modelEnabled: {
                ...access.modelEnabled,
                ...Object.fromEntries(ordered.map((id) => [id, visible.has(id)])),
            },
        },
    };
    // Re-enable the selected defaults on capable members too; display is not a routing grant.
    for (const key of members)
        for (const id of visible) {
            const model = tree[key]?.models?.[id];
            if (model)
                model.enabled = true;
        }
}
//# sourceMappingURL=subscription-defaults.js.map