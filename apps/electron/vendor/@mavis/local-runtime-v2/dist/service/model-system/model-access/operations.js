import { joinSubscriptionGroup } from '../failover/pool-groups.js';
import { resetSubscriptionModelDefaults } from '../catalog/provider-presets/subscription-defaults.js';
import { randomUUID } from 'node:crypto';
import { streamSimple } from '@earendil-works/pi-ai';
import { withLLMRetry } from '@mavis/agent-core/pi-turn-runner';
import { ModelAccessRequestError } from '../../model-access-extension/index.js';
import { LocalModelProviderError, } from '../contracts.js';
import { parseProviderId } from '../resolution/model-key.js';
import { isModelAccessApi, isModelProviderApi } from '../identity.js';
import { openModelAccessCall, requireModelAccessAttempt } from './lifecycle.js';
import { isModelAccessProvider, modelAccessProviderConfig, modelAccessUsageView, readModelAccessMetadata, } from './projection.js';
/** The package owner rereads and commits; imported APIs remain ordinary, independent BYOK. */
export function importModelAccessApi(scanner, providers, input) {
    const writer = {
        commit: async ({ candidate, provenance, assertCurrent }) => {
            if (!isModelProviderApi(candidate.api))
                throw new LocalModelProviderError(400, 'Unsupported API import protocol', 'INVALID_API_FORMAT');
            assertCurrent();
            const result = await providers.saveUserModelProviderCandidate({
                candidate: {
                    name: candidate.upstream,
                    baseUrl: candidate.baseUrl,
                    apiKey: candidate.apiKey,
                    apiFormat: candidate.api,
                    headers: candidate.headers ? { ...candidate.headers } : undefined,
                    models: candidate.models.map((model) => ({
                        modelId: model.id,
                        name: model.name,
                        ...(model.contextWindow === undefined && model.maxOutputTokens === undefined
                            ? {}
                            : { limit: { context: model.contextWindow, output: model.maxOutputTokens } }),
                        ...(model.input ? { modalities: { input: [...model.input] } } : {}),
                        ...(model.reasoning ? { effortOptions: [...model.reasoning] } : {}),
                    })),
                },
                skipConnectionTest: true,
                importIfExisting: true,
                apiImport: provenance,
                beforeCommit: assertCurrent,
            });
            if (!result.ok || !result.provider)
                throw new LocalModelProviderError(500, 'API import failed', 'MODEL_ACCESS_IMPORT_FAILED');
            return result.provider.providerId;
        },
    };
    return scanner.importCandidate(input, writer);
}
/** Metadata-only routing; disabled/missing packages still own their bindings. */
export function modelAccessProviderKey(access, providerId) {
    const key = parseProviderId(providerId)?.providerKey;
    return key && access?.requests.owns(key) ? key : undefined;
}
/** One explicit, tool-free probe. Never stores rotating credentials or a legacy cache fingerprint. */
export async function testModelAccessProvider(access, providerKey, modelId, options = {}) {
    const manual = options.manual;
    const budget = operationBudget(options);
    try {
        budget.assertCurrent();
        const { call, lease } = await openModelAccessCall(access, providerKey, budget.signal);
        try {
            budget.assertCurrent();
            const models = await call.models();
            budget.assertCurrent();
            const selected = modelId === undefined
                ? models[0]
                : (models.find((model) => model.id === modelId) ??
                    (manual?.id === modelId ? manual : undefined));
            if (!selected)
                throw new LocalModelProviderError(404, 'Model not found in the extension catalog', 'MODEL_NOT_FOUND');
            const model = probeModel(providerKey, selected);
            const stream = withLLMRetry(requireModelAccessAttempt(streamSimple), {
                sessionId: 'model-access:probe',
                turnId: `probe_${randomUUID()}`,
                scope: 'probe',
                lifecycle: { open: async () => lease },
                policy: { maxRetries: 0 },
            });
            const response = await stream(model, {
                messages: [{ role: 'user', content: 'ping', timestamp: Date.now() }],
                tools: [],
            }, { signal: lease.signal, maxTokens: model.maxTokens, maxRetries: 0 });
            const final = await response.result();
            budget.assertCurrent();
            // Provider text may contain credentials. Do not project it into diagnostics/status.
            if (final.stopReason === 'error' || final.stopReason === 'aborted') {
                return {
                    ok: false,
                    errorCode: 'provider_error',
                    errorMessage: 'Model access probe failed',
                };
            }
            return { ok: true };
        }
        finally {
            await lease.close();
            budget.assertCurrent();
        }
    }
    catch (error) {
        const stopped = budget.failure();
        return {
            ok: false,
            errorCode: stopped?.code ?? safeErrorCode(error),
            errorMessage: stopped?.message ?? 'Model access probe failed',
        };
    }
    finally {
        budget.close();
    }
}
/** A committed model the user added by hand, as a request model; undefined for any other. */
export function manualAccessModel(modelId, model) {
    const api = model?.provider?.api;
    if (model?.configuration_source !== 'manual' || typeof api !== 'string')
        return undefined;
    return {
        id: modelId,
        api,
        ...(model.name ? { name: model.name } : {}),
        ...(model.limit?.context ? { contextWindow: model.limit.context } : {}),
        ...(model.limit?.output ? { maxOutputTokens: model.limit.output } : {}),
    };
}
/** Query the owner catalog without mutating BYOK or reading its old credentials. @internal */
export async function discoverModelAccessModels(access, providerKey, options = {}) {
    return (await readModelAccessCatalog(access, providerKey, options)).models.map(discoveredModel);
}
/**
 * Read one catalog under a single call. The binding identity is compared before
 * and after, so a catalog fetched while the external account changed is never
 * committed under the new subject (and vice versa).
 */
async function readModelAccessCatalog(access, providerKey, options = {}) {
    const budget = operationBudget(options);
    try {
        budget.assertCurrent();
        const before = access.bindings?.peek(providerKey);
        const { call, lease } = await openModelAccessCall(access, providerKey, budget.signal);
        try {
            budget.assertCurrent();
            const models = await call.models();
            budget.assertCurrent();
            const after = access.bindings?.peek(providerKey);
            if (access.bindings)
                assertSameSubject(before, after);
            return { models, ...(after ? { binding: after } : {}) };
        }
        finally {
            await lease.close();
            budget.assertCurrent();
        }
    }
    catch (error) {
        throw budget.failure() ?? error;
    }
    finally {
        budget.close();
    }
}
/**
 * Discover and commit the extension catalog for an existing provider entry.
 * Same subject keeps user toggles; a changed subject replaces the catalog.
 */
export async function refreshModelAccessCatalog(deps, providerKey, options = {}) {
    const { models, binding } = await readModelAccessCatalog(deps.access, providerKey, options);
    // Resolver-only ports carry no binding metadata and therefore cannot commit a catalog.
    if (!deps.access.bindings)
        return models.map(discoveredModel);
    if (!binding)
        throw bindingMissing();
    // A binding without a model-access entry (or one shadowing an ordinary entry)
    // is listed but never written over: upsert is the only entry creator.
    if (!isModelAccessProvider(deps.configGetter().custom_provider?.[providerKey]))
        return models.map(discoveredModel);
    await deps.updateByokConfig((draft) => {
        const tree = (draft.custom_provider ?? {});
        const current = tree[providerKey];
        if (!isModelAccessProvider(current) || !current) {
            throw new LocalModelProviderError(409, 'Extension provider was removed', 'PROVIDER_CHANGED');
        }
        assertBindingOwnsEntry(current, binding);
        assertBindingUnchanged(deps.access, providerKey, binding);
        tree[providerKey] = modelAccessProviderConfig({
            binding,
            models,
            name: current.name ?? providerKey,
            previous: current,
            ...hostAgent(current),
        });
        draft.custom_provider = tree;
    });
    return models.map(discoveredModel);
}
/**
 * After official delivery moved bindings to another installation (a package split), point each
 * provider entry at the binding's new installation. Catalog, toggles and failover stay: the
 * account and identity revision are unchanged. Entries whose binding did not move are skipped.
 */
export async function adoptModelAccessInstallations(deps, providerKeys) {
    const adopted = [];
    if (!deps.access.bindings || providerKeys.length === 0)
        return adopted;
    await deps.updateByokConfig((draft) => {
        const tree = (draft.custom_provider ?? {});
        for (const key of providerKeys) {
            const current = tree[key];
            const meta = readModelAccessMetadata(current);
            const binding = deps.access.bindings?.peek(key);
            if (!current || !meta || !binding || binding.providerId !== meta.providerId)
                continue;
            if (binding.installationId === meta.installationId)
                continue;
            const access = (current.options?.modelAccess ?? {});
            tree[key] = {
                ...current,
                options: {
                    ...current.options,
                    modelAccess: { ...access, installationId: binding.installationId },
                },
            };
            adopted.push(key);
        }
        draft.custom_provider = tree;
    });
    return adopted;
}
/**
 * Create or update the provider entry after login/borrow committed a binding.
 * The entry is metadata only; credentials remain inside the binding owner.
 */
export async function upsertModelAccessProvider(deps, providerKey, input, options = {}) {
    const budget = operationBudget(options);
    try {
        const { models, binding } = await readModelAccessCatalog(deps.access, providerKey, {
            ...options,
            signal: budget.signal,
        });
        if (!binding)
            throw bindingMissing();
        if (models.length === 0) {
            throw new LocalModelProviderError(409, 'Extension catalog is empty', 'MODEL_ACCESS_CATALOG_EMPTY');
        }
        let assertMembers;
        const assertCurrent = () => {
            budget.assertCurrent();
            assertMembers?.();
            assertBindingUnchanged(deps.access, providerKey, binding);
            if (deps.access.installationActive?.(binding.installationId) === false)
                throw new ModelAccessRequestError('request_unavailable');
            if (deps.access.subscriptionAllowed?.(providerKey) === false)
                throw new LocalModelProviderError(403, 'Agent subscriptions are disabled', 'MODEL_ACCESS_SUBSCRIPTION_DISABLED');
        };
        await deps.updateByokConfig(async (draft, current) => {
            const tree = (draft.custom_provider ?? {});
            const previous = tree[providerKey];
            // Never take over an ordinary BYOK/OAuth/borrowed entry under the same key.
            if (previous && !isModelAccessProvider(previous)) {
                throw new LocalModelProviderError(409, 'Provider key is owned by another provider', 'PROVIDER_CONFLICT');
            }
            assertBindingUnchanged(deps.access, providerKey, binding);
            tree[providerKey] = modelAccessProviderConfig({
                binding,
                models,
                name: input.name,
                ...(previous ? { previous } : {}),
                ...(input.hostAgentId ? { hostAgentId: input.hostAgentId } : hostAgent(previous)),
            });
            joinSubscriptionGroup(tree, providerKey, (key) => deps.access.bindings?.peek(key));
            assertMembers = await resetSubscriptionModelDefaults({
                config: () => ({ ...current, custom_provider: tree }),
                binding: (key) => deps.access.bindings?.peek(key),
                installationActive: deps.access.installationActive,
                rankModelsByRecency: deps.rankModelsByRecency,
            }, tree, providerKey, budget.signal);
            assertCurrent();
            draft.custom_provider = tree;
        }, assertCurrent);
    }
    catch (error) {
        throw budget.failure() ?? error;
    }
    finally {
        budget.close();
    }
}
/** Explicit, non-persisted usage lookup; vendor text never reaches the caller. */
export async function queryModelAccessUsage(access, providerKey, options = {}) {
    const budget = operationBudget(options);
    try {
        budget.assertCurrent();
        const before = access.bindings?.peek(providerKey);
        const { call, lease } = await openModelAccessCall(access, providerKey, budget.signal);
        try {
            budget.assertCurrent();
            const usage = await call.usage();
            budget.assertCurrent();
            const after = access.bindings?.peek(providerKey);
            if (access.bindings)
                assertSameSubject(before, after);
            return modelAccessUsageView(usage, after?.identityRevision ?? call.binding.identityRevision);
        }
        finally {
            await lease.close();
            budget.assertCurrent();
        }
    }
    catch (error) {
        const stopped = budget.failure();
        if (stopped)
            throw stopped;
        if (error instanceof LocalModelProviderError && error.code === 'MODEL_ACCESS_IDENTITY_CHANGED')
            throw error;
        throw new LocalModelProviderError(502, 'Extension usage query failed', 'MODEL_ACCESS_USAGE_FAILED');
    }
    finally {
        budget.close();
    }
}
/** Selection checks metadata only: no credential read, no vendor request. */
export function assertModelAccessSelectable(access, providerKey, provider, modelId) {
    if (provider.enabled === false) {
        throw new LocalModelProviderError(400, 'Model provider is disabled', 'PROVIDER_DISABLED');
    }
    if (access?.subscriptionAllowed?.(providerKey) === false)
        throw new LocalModelProviderError(403, 'Agent subscriptions are disabled; enable them or choose another model', 'MODEL_ACCESS_SUBSCRIPTION_DISABLED');
    if (!access?.requests.owns(providerKey) && !access?.failover?.plan(providerKey)?.grouped)
        throw bindingMissing();
    if (!modelAccessCatalogCurrent(access, providerKey, provider)) {
        throw new LocalModelProviderError(409, 'Extension account changed; refresh its models first', 'MODEL_ACCESS_CATALOG_STALE');
    }
    const model = access.catalog
        ? access.catalog(providerKey)?.[modelId]
        : provider.models?.[modelId];
    if (!model || model.enabled === false) {
        throw new LocalModelProviderError(404, 'Model not found in the extension catalog', 'MODEL_NOT_FOUND');
    }
}
/**
 * The committed catalog belongs to the current subject. Resolver-only ports
 * without binding metadata cannot tell and defer to the per-call identity check.
 */
export function modelAccessCatalogCurrent(access, providerKey, provider) {
    if (access?.subscriptionAllowed?.(providerKey) === false)
        return false;
    const plan = access?.failover?.plan(providerKey);
    if (plan?.grouped)
        return plan.members.length > 0;
    if (!access?.bindings)
        return access?.requests.owns(providerKey) === true;
    const binding = access.bindings.peek(providerKey);
    const meta = readModelAccessMetadata(provider);
    return (!!binding &&
        !!meta &&
        access.subscriptionAllowed?.(providerKey) !== false &&
        access.installationActive?.(binding.installationId) !== false &&
        binding.installationId === meta.installationId &&
        binding.providerId === meta.providerId &&
        binding.identityRevision === meta.catalogIdentityRevision);
}
function discoveredModel(model) {
    return {
        modelId: model.id,
        ...(model.name === undefined ? {} : { displayName: model.name }),
        ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
        ...(model.maxOutputTokens === undefined ? {} : { maxOutputTokens: model.maxOutputTokens }),
        // Legacy DTO can represent text/image only; the extension catalog remains authoritative.
        ...(model.input
            ? {
                input: model.input.filter((kind) => kind === 'text' || kind === 'image'),
            }
            : {}),
        ...(model.reasoning ? { reasoningEfforts: model.reasoning } : {}),
        ...(model.creditMultiplier === undefined ? {} : { creditMultiplier: model.creditMultiplier }),
    };
}
function assertSameSubject(before, after) {
    if (!before || !after)
        throw bindingMissing();
    if (before.kind !== after.kind || before.identityRevision !== after.identityRevision) {
        throw new LocalModelProviderError(409, 'Extension account changed during the operation', 'MODEL_ACCESS_IDENTITY_CHANGED');
    }
}
function assertBindingUnchanged(access, providerKey, expected) {
    assertSameSubject(expected, access.bindings?.peek(providerKey));
}
function assertBindingOwnsEntry(provider, binding) {
    const meta = readModelAccessMetadata(provider);
    if (meta &&
        (meta.installationId !== binding.installationId || meta.providerId !== binding.providerId)) {
        throw new LocalModelProviderError(409, 'Extension binding does not own this provider', 'MODEL_ACCESS_BINDING_MISMATCH');
    }
}
function hostAgent(provider) {
    const hostAgentId = readModelAccessMetadata(provider)?.hostAgentId;
    return hostAgentId ? { hostAgentId } : {};
}
function bindingMissing() {
    return new LocalModelProviderError(409, 'Extension provider has no current binding; sign in again or remove it', 'MODEL_ACCESS_BINDING_MISSING');
}
/** One deadline spans admission, credential resolution, catalog, generation and cleanup. */
function operationBudget(options) {
    const caller = options.signal;
    const deadlineAt = options.deadlineAt;
    if (deadlineAt !== undefined && !Number.isSafeInteger(deadlineAt))
        throw new ModelAccessRequestError('request_invalid');
    const expiresAt = Math.min(Date.now() + 10_000, deadlineAt ?? Infinity);
    const controller = new AbortController();
    const signal = caller ? AbortSignal.any([caller, controller.signal]) : controller.signal;
    const expire = () => {
        controller.abort();
    };
    const remaining = Math.max(0, expiresAt - Date.now());
    const timer = setTimeout(expire, remaining);
    timer.unref();
    if (remaining === 0)
        expire();
    const failure = () => {
        if (Date.now() >= expiresAt)
            expire();
        if (!signal.aborted)
            return undefined;
        return caller?.aborted
            ? new LocalModelProviderError(499, 'Model access operation cancelled', 'cancelled')
            : new LocalModelProviderError(408, 'Model access operation timed out', 'timeout');
    };
    return {
        signal,
        failure,
        assertCurrent: () => {
            const error = failure();
            if (error)
                throw error;
        },
        close: () => clearTimeout(timer),
    };
}
function probeModel(provider, model) {
    if (!isModelAccessApi(model.api))
        throw new ModelAccessRequestError('request_transport_invalid');
    if (model.input && !model.input.includes('text'))
        throw new ModelAccessRequestError('request_transport_invalid');
    return {
        id: model.id,
        name: model.name ?? model.id,
        provider,
        api: model.api,
        baseUrl: 'https://model-access.invalid',
        reasoning: false,
        input: ['text'],
        contextWindow: model.contextWindow ?? 200_000,
        maxTokens: model.maxOutputTokens ?? 1_024,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
}
function safeErrorCode(error) {
    if (error instanceof ModelAccessRequestError)
        return error.code;
    if (error instanceof LocalModelProviderError && error.code === 'MODEL_NOT_FOUND')
        return error.code;
    return 'request_unavailable';
}
//# sourceMappingURL=operations.js.map