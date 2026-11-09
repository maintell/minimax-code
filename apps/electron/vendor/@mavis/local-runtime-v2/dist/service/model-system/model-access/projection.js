import { MODEL_ACCESS_PROVIDER_KIND } from '../identity.js';
const BINDING_KINDS = new Set(['direct-owned', 'borrowed-current', 'public']);
const EFFORT = /^[a-z][a-z0-9_-]{0,39}$/u;
/** At most this many deleted model IDs are kept; an extension never lists more models. */
const REMOVED_MODELS_LIMIT = 2048;
/** Deleted model IDs as stored: strings only, trimmed, unique, bounded. */
export function readRemovedModels(value) {
    if (!Array.isArray(value))
        return [];
    const ids = [];
    for (const item of value) {
        const id = typeof item === 'string' ? item.trim() : '';
        if (id && id.length <= 256 && !ids.includes(id))
            ids.push(id);
        if (ids.length >= REMOVED_MODELS_LIMIT)
            break;
    }
    return ids;
}
export function isModelAccessProvider(provider) {
    return provider?.kind === MODEL_ACCESS_PROVIDER_KIND;
}
export function readModelAccessMetadata(provider) {
    if (!isModelAccessProvider(provider))
        return undefined;
    const record = plainRecord(provider?.options?.modelAccess);
    if (!record)
        return undefined;
    const installationId = text(record.installationId);
    const providerId = text(record.providerId);
    const bindingKind = bindingKindOf(record.bindingKind);
    if (!installationId || !providerId || !bindingKind)
        return undefined;
    return { installationId, providerId, bindingKind, ...optionalMetadata(record) };
}
function optionalMetadata(record) {
    const groupNamespace = text(record.groupNamespace);
    const groupEntryKey = text(record.groupEntryKey);
    const hostAgentId = text(record.hostAgentId);
    const revision = positive(record.catalogIdentityRevision);
    const removedModels = readRemovedModels(record.removedModels);
    return {
        ...(groupNamespace ? { groupNamespace } : {}),
        ...(groupEntryKey ? { groupEntryKey } : {}),
        ...(hostAgentId ? { hostAgentId } : {}),
        ...(revision ? { catalogIdentityRevision: revision } : {}),
        ...(removedModels.length ? { removedModels } : {}),
    };
}
function plainRecord(value) {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value
        : undefined;
}
function bindingKindOf(value) {
    const kind = text(value);
    return kind && BINDING_KINDS.has(kind)
        ? kind
        : undefined;
}
/**
 * Build the config entry for a committed binding. A catalog from a different
 * identity revision replaces old models; the same subject keeps user toggles.
 */
export function modelAccessProviderConfig(input) {
    const previousMeta = readModelAccessMetadata(input.previous);
    const sameSubject = previousMeta?.catalogIdentityRevision === input.binding.identityRevision &&
        previousMeta.providerId === input.binding.providerId;
    const keep = sameSubject ? (input.previous?.models ?? {}) : {};
    const listed = withoutRemoved(input.models, previousMeta);
    const api = input.models[0]?.api;
    // The primary's failover pool (provider keys only) survives a re-login or catalog refresh.
    const previousAccess = plainRecord(input.previous?.options?.modelAccess);
    const failover = plainRecord(previousAccess?.failover);
    return {
        kind: MODEL_ACCESS_PROVIDER_KIND,
        name: input.previous?.name ?? input.name,
        enabled: input.previous?.enabled ?? true,
        ...(api ? { api } : {}),
        options: {
            modelAccess: {
                installationId: input.binding.installationId,
                providerId: input.binding.providerId,
                bindingKind: input.binding.kind,
                ...groupPreferences(previousMeta, previousAccess),
                ...(input.hostAgentId ? { hostAgentId: input.hostAgentId } : {}),
                catalogIdentityRevision: input.binding.identityRevision,
                ...(failover && input.binding.kind !== 'public'
                    ? { failover: structuredClone(failover) }
                    : {}),
            },
        },
        models: {
            ...modelAccessCatalogModels(listed, keep),
            ...manualModels(input.previous?.models, input.models, sameSubject),
        },
    };
}
/**
 * Models the user added by hand belong to the subscription: they survive refreshes and
 * re-logins. One the extension now lists becomes an ordinary listed model (the extension's
 * entry wins). After an account change only its enabled state resets, as for listed models.
 */
function manualModels(previous, listed, sameSubject) {
    const ids = new Set(listed.map((model) => model.id));
    const out = {};
    for (const [id, model] of Object.entries(previous ?? {})) {
        if (model.configuration_source !== 'manual' || ids.has(id))
            continue;
        const { enabled, ...rest } = model;
        out[id] = sameSubject && enabled === false ? { ...rest, enabled } : rest;
    }
    return out;
}
/** Deleted models belong to the subscription, not an account: they stay out after a re-login. */
function withoutRemoved(models, meta) {
    const removed = new Set(meta?.removedModels ?? []);
    return removed.size ? models.filter((model) => !removed.has(model.id)) : models;
}
function groupPreferences(meta, access) {
    return {
        ...(meta?.groupNamespace ? { groupNamespace: meta.groupNamespace } : {}),
        ...(meta?.groupEntryKey ? { groupEntryKey: meta.groupEntryKey } : {}),
        ...(access?.modelEnabled ? { modelEnabled: structuredClone(access.modelEnabled) } : {}),
        ...(Array.isArray(access?.modelOrder) ? { modelOrder: [...access.modelOrder] } : {}),
        ...(meta?.removedModels?.length ? { removedModels: [...meta.removedModels] } : {}),
    };
}
/** The new catalog decides membership and order; kept models keep user enablement only. */
function modelAccessCatalogModels(models, previous = {}) {
    return Object.fromEntries(models.map((model) => {
        const kept = previous[model.id];
        return [
            model.id,
            {
                ...accessModelConfig(model),
                ...(kept?.enabled === false ? { enabled: false } : {}),
            },
        ];
    }));
}
function accessModelConfig(model) {
    return {
        name: model.name?.trim() || model.id,
        // The extension catalog states the real wire protocol for each model.
        provider: { api: model.api },
        configuration_source: 'discovered',
        ...modelLimitConfig(model),
        ...modelInputConfig(model),
        ...modelReasoningConfig(model),
        ...(model.tools === undefined ? {} : { tool_call: model.tools }),
        ...modelCreditConfig(model),
    };
}
function modelLimitConfig(model) {
    const context = positive(model.contextWindow);
    const output = positive(model.maxOutputTokens);
    if (!context && !output)
        return {};
    return { limit: { ...(context ? { context } : {}), ...(output ? { output } : {}) } };
}
function modelInputConfig(model) {
    const input = model.input?.filter((value) => value === 'text' || value === 'image' || value === 'audio' || value === 'video');
    if (!input?.length)
        return {};
    return { modalities: { input: [...new Set(input)] }, attachment: input.includes('image') };
}
function modelReasoningConfig(model) {
    const efforts = [...new Set(model.reasoning?.filter((value) => EFFORT.test(value)) ?? [])];
    if (!efforts.length)
        return {};
    return {
        reasoning: efforts.some((effort) => effort !== 'none' && effort !== 'off'),
        thinking: { effortOptions: efforts },
    };
}
function modelCreditConfig(model) {
    const multiplier = model.creditMultiplier;
    return typeof multiplier === 'number' && Number.isFinite(multiplier) && multiplier >= 0
        ? { creditMultiplier: multiplier }
        : {};
}
/** Committed binding facts vs. config metadata. Missing binding is shown, never hidden. */
export function modelAccessProviderView(provider, binding) {
    const meta = readModelAccessMetadata(provider);
    if (!meta)
        return undefined;
    const matches = !!binding &&
        binding.installationId === meta.installationId &&
        binding.providerId === meta.providerId;
    const status = providerStatus(meta, binding, matches);
    return {
        installationId: meta.installationId,
        providerId: meta.providerId,
        bindingKind: matches ? binding.kind : meta.bindingKind,
        ...(meta.groupEntryKey ? { groupProviderId: `custom_provider:${meta.groupEntryKey}` } : {}),
        ...(meta.hostAgentId ? { hostAgentId: meta.hostAgentId } : {}),
        status,
        ...(matches && binding.accountMasked ? { accountMasked: binding.accountMasked } : {}),
        ...(matches ? { identityRevision: binding.identityRevision } : {}),
    };
}
function providerStatus(meta, binding, matches) {
    if (!binding)
        return 'binding_missing';
    if (!matches)
        return 'binding_mismatch';
    return meta.catalogIdentityRevision === binding.identityRevision ? 'ready' : 'catalog_stale';
}
/**
 * Project extension usage for the renderer. Windows without a stated value
 * stay without one: a missing `used` is unknown, never 0%.
 */
export function modelAccessUsageView(usage, identityRevision) {
    if (usage.status !== 'available') {
        return { status: usage.status, queriedAt: usage.queriedAt, identityRevision, windows: [] };
    }
    return {
        status: 'available',
        queriedAt: usage.queriedAt,
        identityRevision,
        ...(usage.plan ? { plan: usage.plan } : {}),
        expiryStatus: usage.expiryStatus,
        windows: usage.windows.map((window) => ({
            name: window.name,
            unit: window.unit,
            ...(window.used === undefined ? {} : { used: window.used }),
            ...(window.amount === undefined ? {} : { amount: window.amount }),
            ...(window.limit === undefined ? {} : { limit: window.limit }),
            ...(window.resetAt === undefined ? {} : { resetAt: window.resetAt }),
            ...(window.runsOutAt === undefined ? {} : { runsOutAt: window.runsOutAt }),
        })),
    };
}
function text(value) {
    return typeof value === 'string' && value.trim() && value.length <= 256 ? value : undefined;
}
function positive(value) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}
//# sourceMappingURL=projection.js.map