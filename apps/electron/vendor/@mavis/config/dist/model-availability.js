// Route-aware model availability and retired-model replacement.
//
// Managed and MiniMax API-key routes share the official model catalog.
// Custom providers retain their own configured models. This module owns the
// one answer to "may this route call this model", so the local model list, the
// save entry (`selectModel`) and the Turn execution gate cannot disagree.
//
// It also owns the one replacement rule: a model reference the official
// catalog no longer lists is replaced by the next callable candidate, ending
// at the delivered default (`model_order`'s first listed model). Other routes
// are never replaced and never blocked here; their own upstream decides.
//
// Pure by contract: no fs, no process state, no runtime types. Callers pass a
// structured read-only view of the effective config plus the runtime PresetKey.
import { MINIMAX_FIRST_RUN_DEFAULT_MODEL_ID, MINIMAX_MODELS } from './minimax-model-catalog.js';
import { resolveProviderAuthMode } from './provider-auth-mode.js';
/** Reserved provider ids, mirrored by the local-runtime model-key parsers. */
export const MANAGED_MINIMAX_PROVIDER_ID = 'minimax';
export const MINIMAX_API_PROVIDER_ID = 'minimax_api';
export const CUSTOM_PROVIDER_ID_PREFIX = 'custom_provider:';
/** Shared cache-compatibility policy for MiniMax's first-party Messages route. */
export function isFirstPartyMinimaxMessagesRoute(api, providerId) {
    return (api === 'anthropic-messages' &&
        (providerId === MANAGED_MINIMAX_PROVIDER_ID || providerId === MINIMAX_API_PROVIDER_ID));
}
/**
 * The route a provider id resolves to. `provider.minimax` is not a fixed
 * route: with `minimaxModelSource = 'minimax_api_key'` the very same builtin
 * entry is called with the user's own key, using the same official catalog.
 */
export function resolveModelCallRoute(config, providerId) {
    if (providerId === MINIMAX_API_PROVIDER_ID)
        return 'minimax_api_key';
    if (providerId.startsWith(CUSTOM_PROVIDER_ID_PREFIX))
        return 'custom_provider';
    if (providerId !== MANAGED_MINIMAX_PROVIDER_ID)
        return 'configured_provider';
    if (config.minimaxModelSource === 'minimax_api_key')
        return 'minimax_api_key';
    const options = config.provider?.[providerId]?.options;
    const authMode = resolveProviderAuthMode({
        authMode: options?.authMode,
        baseURL: options?.baseURL,
    }).authMode;
    return authMode === 'managed-login' ? 'managed_token_plan' : 'configured_provider';
}
/**
 * Model ids the given provider id may actually call right now. Both MiniMax
 * routes follow the official catalog and ordering; custom providers keep
 * their user-owned model lists.
 */
export function listRouteModelIds(config, providerId, _preset) {
    const route = resolveModelCallRoute(config, providerId);
    switch (route) {
        case 'managed_token_plan': {
            return configuredModelIds(config.provider?.[providerId], true);
        }
        case 'minimax_api_key': {
            const provider = config.provider?.[MANAGED_MINIMAX_PROVIDER_ID];
            return configuredModelIds({ ...provider, models: provider?.models ?? MINIMAX_MODELS }, true);
        }
        case 'custom_provider': {
            const provider = config.custom_provider?.[providerId.slice(CUSTOM_PROVIDER_ID_PREFIX.length)];
            if (!provider || provider.enabled === false)
                return [];
            return configuredModelIds(provider);
        }
        case 'configured_provider':
            return configuredModelIds(config.provider?.[providerId]);
    }
}
/** The single availability answer shared by list, save and Turn execution. */
export function resolveModelAvailability(input) {
    const route = resolveModelCallRoute(input.config, input.providerId);
    const modelId = input.modelId.trim();
    if (modelId.length > 0 &&
        listRouteModelIds(input.config, input.providerId, input.preset).includes(modelId)) {
        return { available: true, route };
    }
    return {
        available: false,
        route,
        code: input.source === 'config_default'
            ? 'DEFAULT_MODEL_NOT_AVAILABLE_FOR_ROUTE'
            : 'MODEL_NOT_AVAILABLE_FOR_ROUTE',
        message: `Model "${input.providerId}/${input.modelId}" is not available for the "${route}" route (preset ${input.preset}).`,
    };
}
/** Only official-catalog routes have models that can be retired by delivery. */
export function isOfficialCatalogRoute(route) {
    return route === 'managed_token_plan' || route === 'minimax_api_key';
}
/**
 * The delivered default of one official MiniMax snapshot: the first
 * `model_order` entry still listed, then the first-run default, then the first
 * listed model. `undefined` only when the snapshot lists no enabled model.
 */
export function deliveredDefaultModelId(provider) {
    const ids = configuredModelIds(provider, true);
    const order = Array.isArray(provider?.model_order) ? provider.model_order : [];
    const ordered = order.find((id) => typeof id === 'string' && ids.includes(id));
    if (ordered)
        return ordered;
    return ids.includes(MINIMAX_FIRST_RUN_DEFAULT_MODEL_ID)
        ? MINIMAX_FIRST_RUN_DEFAULT_MODEL_ID
        : ids[0];
}
/**
 * Applies the replacement rule to one model reference.
 *
 * - Callable on its route → `available`.
 * - Official route, no longer listed → the first callable `fallbacks` entry
 *   (caller priority, e.g. Session model then Runtime default), else the
 *   delivered default on the same provider id → `replaced`.
 * - Any other route, or an official route that lists nothing → `passthrough`:
 *   the reference is sent unchanged and the upstream decides.
 *
 * Never throws: an unexpected reference degrades to `passthrough`.
 */
export function resolveModelReplacement(input) {
    const route = resolveModelCallRoute(input.config, input.providerId);
    const modelId = input.modelId.trim();
    if (listRouteModelIds(input.config, input.providerId, input.preset).includes(modelId)) {
        return { kind: 'available', route };
    }
    if (!isOfficialCatalogRoute(route))
        return { kind: 'passthrough', route, reason: 'unmanaged_route' };
    const fallback = input.fallbacks?.find((candidate) => candidate !== undefined &&
        !(candidate.providerId === input.providerId && candidate.modelId.trim() === modelId) &&
        listRouteModelIds(input.config, candidate.providerId, input.preset).includes(candidate.modelId.trim()));
    if (fallback) {
        return {
            kind: 'replaced',
            route,
            tier: 'fallback',
            model: { providerId: fallback.providerId, modelId: fallback.modelId.trim() },
        };
    }
    const deliveredDefault = deliveredDefaultModelId(officialCatalogView(input.config, input.providerId));
    if (!deliveredDefault)
        return { kind: 'passthrough', route, reason: 'no_official_model' };
    return {
        kind: 'replaced',
        route,
        tier: 'delivered_default',
        model: { providerId: input.providerId, modelId: deliveredDefault },
    };
}
/** The provider view whose models/order define an official route's catalog. */
function officialCatalogView(config, providerId) {
    const managed = config.provider?.[MANAGED_MINIMAX_PROVIDER_ID];
    if (providerId === MANAGED_MINIMAX_PROVIDER_ID &&
        resolveModelCallRoute(config, providerId) === 'managed_token_plan') {
        return managed;
    }
    return { ...managed, models: managed?.models ?? MINIMAX_MODELS };
}
function configuredModelIds(provider, applyModelOrder = false) {
    const configured = Object.entries(provider?.models ?? {})
        .filter(([, model]) => model?.enabled !== false)
        .map(([modelId]) => modelId);
    const order = provider?.model_order;
    if (!applyModelOrder || !Array.isArray(order) || !order.every((id) => typeof id === 'string')) {
        return configured;
    }
    const remaining = new Set(configured);
    const ordered = order.filter((modelId) => remaining.delete(modelId));
    return [...ordered, ...configured.filter((modelId) => remaining.has(modelId))];
}
//# sourceMappingURL=model-availability.js.map