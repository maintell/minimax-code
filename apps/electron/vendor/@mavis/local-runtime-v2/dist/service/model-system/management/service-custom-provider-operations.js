import { settleInBackground } from '../../../infra/async/settle.js';
import { CUSTOM_PROVIDER_ID_PREFIX, formatModelKey } from '../resolution/model-key.js';
import { LocalModelProviderError, } from '../contracts.js';
import { generateProviderKey } from './provider-key.js';
import {} from '../catalog/provider-views.js';
import { ModelProviderServiceContext } from './service-context.js';
import { modelAccessProviderReadOnlyError, assertCustomProviderEffortOptions, nextDuplicateProviderName, removeLegacyCustomProviderNpm, resetUnavailableCustomDefaultModel, } from './service-helpers.js';
import { failoverPlan, readFailoverConfig } from '../failover/pool-config.js';
import { groupHasAccount, reselectGroupAccounts } from '../failover/pool-groups.js';
import { isModelAccessProvider, readModelAccessMetadata, readRemovedModels, } from '../model-access/projection.js';
import { assertModelAccessSelectable, refreshModelAccessCatalog, } from '../model-access/operations.js';
import { assertValidRawApiKey, mergeModelsFromInputs, modelsFromInputs, normalizeApiFormat, normalizeProviderCredentialUpdate, normalizeHeaderNames, normalizeHeaders, removeHeaderCaseInsensitive, } from './service-input.js';
import { readApiKeys, replaceFirstApiKey, writeApiKeys } from '../byok-keys/key-list.js';
import { byokKeyPoolOf, forgetDroppedApiKeys } from '../byok-keys/operations.js';
export async function createUserProvider(context, input) {
    if (input.saveAndUse) {
        throw new LocalModelProviderError(409, 'Test the saved provider configuration before activating it', 'TEST_REQUIRED');
    }
    const apiKey = assertValidRawApiKey(input.apiKey);
    const baseUrl = input.baseUrl?.trim();
    if (!baseUrl) {
        throw new LocalModelProviderError(400, 'base_url must not be empty', 'VALIDATION_ERROR');
    }
    const apiFormat = normalizeApiFormat(input.apiFormat);
    const headers = normalizeHeaders(input.headers);
    const name = input.name?.trim();
    let providerKey = '';
    await context.deps.updateByokConfig((draft) => {
        const tree = (draft.custom_provider ?? {});
        providerKey = generateProviderKey({
            displayName: name,
            existingKeys: Object.keys(tree),
            ...(context.deps.randomHex ? { randomHex: context.deps.randomHex } : {}),
        });
        const provider = {
            ...(name ? { name } : {}),
            kind: 'custom',
            enabled: true,
            ...(apiFormat ? { api: apiFormat } : {}),
            options: {
                apiKey,
                baseURL: baseUrl,
                authMode: 'api-key',
                ...(headers ? { headers } : {}),
            },
            ...(input.models
                ? {
                    models: modelsFromInputs(input.models, undefined, context.deps.implicitCustomProviderThinking === true),
                }
                : {}),
        };
        assertCustomProviderEffortOptions(provider);
        tree[providerKey] = provider;
        draft.custom_provider = tree;
    });
    return context.requireCustomProviderView(providerKey);
}
export async function updateUserProvider(context, input) {
    const providerKey = context.requireExistingProviderKey(input.providerId);
    assertModelAccessUpdateAllowed(context.deps.configGetter().custom_provider?.[providerKey], input);
    // Tri-state api_key: absent keeps the stored key, empty string clears it,
    // masked placeholders are rejected so a sanitized read can't be written back.
    const apiKeyUpdate = normalizeProviderCredentialUpdate({ apiKey: input.apiKey });
    const baseUrl = input.baseUrl?.trim();
    if (input.baseUrl !== undefined && !baseUrl) {
        throw new LocalModelProviderError(400, 'base_url must not be empty', 'VALIDATION_ERROR');
    }
    const apiFormat = input.apiFormat !== undefined ? normalizeApiFormat(input.apiFormat) : undefined;
    const headers = input.headers !== undefined ? normalizeHeaders(input.headers) : undefined;
    const removeHeaders = normalizeHeaderNames(input.removeHeaders);
    const prepared = {
        apiKeyUpdate,
        ...(baseUrl ? { baseUrl } : {}),
        ...(apiFormat ? { apiFormat } : {}),
        ...(headers ? { headers } : {}),
        removeHeaders,
        implicitCustomProviderThinking: context.deps.implicitCustomProviderThinking === true,
    };
    const removedBefore = groupRemovedModels(context.deps.configGetter(), providerKey);
    const keysBefore = readApiKeys(context.deps.configGetter().custom_provider?.[providerKey]);
    await context.deps.updateByokConfig((draft, currentConfig) => {
        const stored = draft.custom_provider?.[providerKey];
        if (stored &&
            isModelAccessProvider(stored) &&
            readFailoverConfig(stored).members &&
            input.models) {
            updateGroupedModels(context, { tree: draft.custom_provider, providerKey, stored }, input.models);
            applyUserProviderUpdate(draft, providerKey, { ...input, models: undefined }, prepared);
        }
        else
            applyUserProviderUpdate(draft, providerKey, input, prepared);
        if (!isModelAccessProvider(stored))
            resetUnavailableCustomDefaultModel(draft, currentConfig);
    });
    forgetDroppedApiKeys(context, providerKey, keysBefore);
    await activateUpdatedProvider(context, providerKey, input.saveAndUse === true);
    const removedAfter = groupRemovedModels(context.deps.configGetter(), providerKey);
    // Not awaited: the save returns now and the refresh never rejects.
    if (removedBefore.some((id) => !removedAfter.includes(id)))
        settleInBackground(refreshRestoredModels(context, providerKey));
    return context.requireCustomProviderView(providerKey);
}
/** The deleted model IDs of a subscription (kept on its group root). */
function groupRemovedModels(config, providerKey) {
    const tree = config.custom_provider ?? {};
    const provider = tree[providerKey];
    if (!isModelAccessProvider(provider))
        return [];
    const root = readModelAccessMetadata(provider)?.groupEntryKey ?? providerKey;
    return readModelAccessMetadata(tree[root])?.removedModels?.slice() ?? [];
}
/**
 * A deleted listed model typed back in is held as a hand-added entry until the extension is
 * asked again; that refresh restores the extension's entry. It runs after the save returns and
 * a failure only leaves the hand-added entry in place.
 */
async function refreshRestoredModels(context, providerKey) {
    const access = context.deps.modelAccess;
    if (!access)
        return;
    try {
        await refreshModelAccessCatalog({
            access,
            configGetter: context.deps.configGetter,
            updateByokConfig: context.deps.updateByokConfig,
        }, providerKey);
    }
    catch {
        // The hand-added entry stays until the next refresh; the save already succeeded.
    }
}
function updateGroupedModels(context, { tree, providerKey, stored, }, models) {
    const catalog = context.deps.modelAccess?.catalog?.(providerKey) ?? stored.models ?? {};
    const members = groupMemberKeys(context, tree, providerKey);
    // A model an account lists (not one added by hand) comes back with that account's entry.
    const listedByMember = (id) => members.some((key) => {
        const model = tree[key]?.models?.[id];
        return !!model && model.configuration_source !== 'manual';
    });
    addGroupedManualModels(stored, catalog, models, listedByMember);
    dropGroupedManualModels(stored, models);
    const access = stored.options?.modelAccess;
    const enabled = { ...(access.modelEnabled ?? {}) };
    for (const m of models)
        if (m.enabled !== undefined)
            enabled[m.modelId] = m.enabled;
    for (const model of models) {
        const own = stored.models?.[model.modelId];
        if (own && model.enabled !== undefined)
            own.enabled = model.enabled;
    }
    enableGroupedMemberModels(context, tree, providerKey, models);
    stored.options = {
        ...stored.options,
        modelAccess: { ...access, ...groupedModelPreferences(access, catalog, models, enabled) },
    };
}
/**
 * A model typed in that is not in the group's union: a deleted ID is undeleted (shown again from
 * the accounts that list it); any other is added by hand on the root, which the union reads.
 */
function addGroupedManualModels(root, catalog, models, listedByMember) {
    const removed = removedModelIds(root);
    const own = { ...(root.models ?? {}) };
    const restored = [];
    for (const input of models) {
        const modelId = input.modelId.trim();
        const kept = own[modelId];
        if (kept?.configuration_source === 'manual' && input.api?.trim())
            own[modelId] = { ...kept, provider: { ...kept.provider, api: input.api.trim() } };
        if (catalog[modelId])
            continue;
        if (removed.includes(modelId))
            restored.push(modelId);
        if (!kept && !(removed.includes(modelId) && listedByMember(modelId)))
            own[modelId] = manualModelConfig(input, root);
    }
    root.models = own;
    rememberRemovedModels(root, { deleted: [], restored, previous: {} });
}
/** A hand-added model left out of the save is gone; it leaves no deletion record. */
function dropGroupedManualModels(root, models) {
    const submitted = new Set(models.map((model) => model.modelId.trim()));
    const own = { ...(root.models ?? {}) };
    for (const [id, model] of Object.entries(own))
        if (model.configuration_source === 'manual' && !submitted.has(id))
            delete own[id];
    root.models = own;
}
function groupMemberKeys(context, tree, providerKey) {
    const plan = failoverPlan({
        config: () => ({ ...context.deps.configGetter(), custom_provider: tree }),
        binding: (key) => context.deps.modelAccess?.bindings?.peek(key),
        installationActive: context.deps.modelAccess?.installationActive,
    }, providerKey);
    return plan?.members.map((member) => member.providerKey) ?? [providerKey];
}
/**
 * The submitted list is the whole union: a model left out is deleted for every account of the
 * group. Members keep their own listings; the root's `removedModels` filters the union.
 */
function groupedModelPreferences(access, catalog, models, enabled) {
    const submitted = new Set(models.map((model) => model.modelId.trim()));
    const deleted = Object.keys(catalog).filter((id) => !submitted.has(id));
    const removedModels = readRemovedModels([
        ...readRemovedModels(access.removedModels),
        ...deleted.filter((id) => catalog[id]?.configuration_source !== 'manual'),
    ]);
    for (const id of deleted)
        delete enabled[id];
    return {
        modelEnabled: enabled,
        modelOrder: models.map((model) => model.modelId.trim()),
        ...(removedModels.length ? { removedModels } : {}),
    };
}
function enableGroupedMemberModels(context, tree, providerKey, models) {
    const plan = failoverPlan({
        config: () => ({ ...context.deps.configGetter(), custom_provider: tree }),
        binding: (key) => context.deps.modelAccess?.bindings?.peek(key),
        installationActive: context.deps.modelAccess?.installationActive,
    }, providerKey);
    for (const member of plan?.members ?? []) {
        for (const model of models) {
            const own = tree[member.providerKey]?.models?.[model.modelId];
            if (own && model.enabled === true)
                own.enabled = true;
        }
    }
}
async function activateUpdatedProvider(context, providerKey, saveAndUse) {
    if (!saveAndUse)
        return;
    const provider = context.deps.configGetter().custom_provider?.[providerKey];
    const firstModelId = Object.keys(provider?.models ?? {})[0];
    if (!firstModelId)
        return;
    const providerId = `${CUSTOM_PROVIDER_ID_PREFIX}${providerKey}`;
    if (provider && isModelAccessProvider(provider))
        assertModelAccessSelectable(context.deps.modelAccess, providerKey, provider, firstModelId);
    else
        context.resolveTestTarget(providerId, firstModelId);
    await context.deps.selectModel(formatModelKey(providerId, firstModelId));
}
function applyUserProviderUpdate(draft, providerKey, input, prepared) {
    const tree = (draft.custom_provider ?? {});
    const provider = tree[providerKey];
    if (!provider)
        return;
    assertModelAccessUpdateAllowed(provider, input);
    removeLegacyCustomProviderNpm(provider);
    applyProviderFields(provider, input, prepared.apiFormat, prepared.implicitCustomProviderThinking);
    assertCustomProviderEffortOptions(provider);
    provider.options = updatedProviderOptions(provider, input, prepared);
    draft.custom_provider = tree;
}
function applyProviderFields(provider, input, apiFormat, implicitCustomProviderThinking) {
    // provider_key is immutable: renames only change the display name.
    if (input.name !== undefined)
        provider.name = input.name.trim();
    if (input.enabled !== undefined)
        provider.enabled = input.enabled;
    if (apiFormat !== undefined)
        provider.api = apiFormat;
    if (input.models !== undefined && isModelAccessProvider(provider)) {
        applyModelAccessModelToggles(provider, input.models);
    }
    else if (input.models !== undefined) {
        provider.models = mergeModelsFromInputs(provider.models, input.models, implicitCustomProviderThinking);
    }
}
function updatedProviderOptions(provider, input, prepared) {
    const options = { ...(provider.options ?? {}) };
    if (prepared.baseUrl !== undefined)
        options.baseURL = prepared.baseUrl;
    // A single-key write replaces the first key and keeps the others; clear drops them all.
    if (prepared.apiKeyUpdate.kind === 'set')
        writeApiKeys(options, replaceFirstApiKey(readApiKeys(provider), prepared.apiKeyUpdate.apiKey));
    if (prepared.apiKeyUpdate.kind === 'clear')
        writeApiKeys(options, []);
    applyProviderHeaderUpdate(options, input, prepared);
    return options;
}
function applyProviderHeaderUpdate(options, input, prepared) {
    if (input.headers === undefined && prepared.removeHeaders.length === 0)
        return;
    const nextHeaders = { ...(options.headers ?? {}) };
    for (const name of prepared.removeHeaders)
        removeHeaderCaseInsensitive(nextHeaders, name);
    for (const [name, value] of Object.entries(prepared.headers ?? {})) {
        removeHeaderCaseInsensitive(nextHeaders, name);
        nextHeaders[name] = value;
    }
    if (Object.keys(nextHeaders).length > 0)
        options.headers = nextHeaders;
    else
        delete options.headers;
}
export async function duplicateUserProvider(context, input) {
    const sourceProviderKey = context.requireExistingProviderKey(input.providerId);
    let duplicateProviderKey = '';
    await context.deps.updateByokConfig((draft) => {
        const tree = (draft.custom_provider ?? {});
        const source = tree[sourceProviderKey];
        if (!source) {
            throw new LocalModelProviderError(404, 'Model provider not found', 'PROVIDER_NOT_FOUND');
        }
        // A copy would have no binding and could never route; one provider owns one account.
        if (isModelAccessProvider(source))
            throw modelAccessProviderReadOnlyError();
        const duplicateName = nextDuplicateProviderName({
            requestedName: input.name,
            sourceName: source.name,
            sourceProviderKey,
            providers: tree,
        });
        duplicateProviderKey = generateProviderKey({
            displayName: duplicateName,
            existingKeys: Object.keys(tree),
            ...(context.deps.randomHex ? { randomHex: context.deps.randomHex } : {}),
        });
        const duplicate = structuredClone(source);
        removeLegacyCustomProviderNpm(duplicate);
        tree[duplicateProviderKey] = { ...duplicate, name: duplicateName };
        draft.custom_provider = tree;
    });
    return context.requireCustomProviderView(duplicateProviderKey);
}
/**
 * Removes one provider entry. For a subscription this is one account of its group: the next
 * account becomes first (the anchor key stays the stable route but is no placeholder account),
 * and the provider disappears with its last account. Deleting a whole provider removes every
 * account (the UI removes the members, then the anchor).
 */
export async function deleteUserProvider(context, input) {
    const providerKey = context.requireExistingProviderKey(input.providerId);
    await removeModelAccessBinding(context, providerKey);
    await context.deps.updateByokConfig(async (draft, currentConfig) => {
        const tree = (draft.custom_provider ?? {});
        const provider = tree[providerKey];
        if (provider?.kind === 'oauth') {
            const removeCredentials = context.deps.removeProviderCredentials;
            if (!removeCredentials) {
                throw new LocalModelProviderError(503, 'OAuth credential removal is unavailable', 'PROVIDER_AUTH_UNAVAILABLE');
            }
            try {
                await removeCredentials(providerKey);
            }
            catch {
                throw new LocalModelProviderError(500, 'Failed to delete OAuth credentials', 'PROVIDER_CREDENTIAL_DELETE_FAILED');
            }
        }
        if (isModelAccessProvider(provider))
            removeSubscriptionAccount(context, tree, providerKey, provider);
        else
            delete tree[providerKey];
        draft.custom_provider =
            Object.keys(tree).length > 0 ? tree : undefined;
        // A subscription selection is a stable route, not the deleted account's credential.
        // Preserve it (or fail explicitly if empty), never silently switch billing providers.
        if (!isModelAccessProvider(provider))
            resetUnavailableCustomDefaultModel(draft, currentConfig);
    });
    await context.deps.cache.removeProvider(`${CUSTOM_PROVIDER_ID_PREFIX}${providerKey}`);
    byokKeyPoolOf(context).clearProvider(providerKey);
}
function removeSubscriptionAccount(context, tree, providerKey, provider) {
    const root = readModelAccessMetadata(provider)?.groupEntryKey;
    // The binding was removed just before; nothing of this key counts as an account any more.
    const binding = (key) => key === providerKey ? undefined : context.deps.modelAccess?.bindings?.peek(key);
    if (!root || !tree[root] || !groupHasAccount(tree, root, binding, providerKey)) {
        // An ungrouped entry, or the group's last account: the provider goes with all its entries.
        for (const key of Object.keys(tree))
            if (key === providerKey ||
                (root && (key === root || readModelAccessMetadata(tree[key])?.groupEntryKey === root)))
                delete tree[key];
        return;
    }
    reselectGroupAccounts(tree, root, binding, providerKey);
    if (providerKey === root) {
        // The stable route stays; its catalog is the remaining accounts' union.
        tree[root] = { ...tree[root], models: {} };
    }
    else
        delete tree[providerKey];
}
/**
 * Extension providers keep a host-owned name, route and catalog; only enabled and model toggles
 * are editable. The vendor name is fixed so every account of a subscription reads the same; an
 * unchanged name (forms resend it) is accepted.
 */
function assertModelAccessUpdateAllowed(provider, input) {
    if (!isModelAccessProvider(provider))
        return;
    if (editsExtensionOwnedFields(provider, input))
        throw modelAccessProviderReadOnlyError();
    if (input.models)
        assertManualModelIds(input.models);
}
/** The name, credentials, route and headers of an extension provider belong to the extension. */
function editsExtensionOwnedFields(provider, input) {
    if (input.name !== undefined && input.name.trim() !== (provider?.name ?? ''))
        return true;
    const routed = [input.apiKey, input.baseUrl, input.apiFormat, input.headers];
    return routed.some((value) => value !== undefined) || (input.removeHeaders?.length ?? 0) > 0;
}
const MANUAL_MODEL_ID_MAX = 256;
/** IDs typed by hand: trimmed, non-empty, bounded and unique within the submitted list. */
function assertManualModelIds(models) {
    const seen = new Set();
    for (const model of models) {
        const id = model.modelId.trim();
        if (!id || id.length > MANUAL_MODEL_ID_MAX || seen.has(id))
            throw new LocalModelProviderError(400, 'Invalid or duplicate model ID', 'VALIDATION_ERROR');
        seen.add(id);
    }
}
/**
 * The submitted list is the whole list, as for ordinary BYOK: a model left out is deleted and
 * its ID kept in `removedModels`, so a refresh does not bring it back. The extension still owns
 * each listed model's limits; only `enabled` and the order are taken from the input.
 */
function applyModelAccessModelToggles(provider, models) {
    const current = provider.models ?? {};
    const next = {};
    const restored = [];
    const removed = removedModelIds(provider);
    for (const input of models) {
        const modelId = input.modelId.trim();
        const model = current[modelId];
        if (next[modelId])
            continue;
        if (model) {
            next[modelId] = updatedListedModel(model, input);
            continue;
        }
        next[modelId] = manualModelConfig(input, provider);
        if (removed.includes(modelId))
            restored.push(modelId);
    }
    const deleted = Object.keys(current).filter((id) => !next[id]);
    provider.models = next;
    rememberRemovedModels(provider, { deleted, restored, previous: current });
    return { restored };
}
/** A listed model keeps the extension's fields; a hand-added one may also change its protocol. */
function updatedListedModel(model, input) {
    const api = model.configuration_source === 'manual' && input.api?.trim() ? input.api.trim() : undefined;
    return {
        ...model,
        ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
        ...(api ? { provider: { ...model.provider, api } } : {}),
    };
}
/**
 * A model the extension does not list, typed in by the user: named by its ID, asked on the
 * protocol given or the subscription's first listed model's; limits come from resolver defaults.
 */
function manualModelConfig(input, provider) {
    const modelId = input.modelId.trim();
    const api = input.api?.trim() || defaultManualApi(provider);
    if (!api)
        throw new LocalModelProviderError(400, 'Choose an API format for this model', 'VALIDATION_ERROR');
    return {
        name: input.displayName?.trim() || modelId,
        configuration_source: 'manual',
        provider: { api },
        ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
    };
}
function defaultManualApi(provider) {
    const listed = Object.values(provider.models ?? {}).find((model) => model.configuration_source !== 'manual' && typeof model.provider?.api === 'string');
    const api = listed?.provider?.api ?? provider.api;
    return typeof api === 'string' && api ? api : undefined;
}
function removedModelIds(provider) {
    return readRemovedModels(provider.options?.modelAccess?.removedModels);
}
/**
 * Extension-listed models a user deleted are remembered; a model they added by hand leaves no
 * trace. An ID typed back in is no longer deleted.
 */
function rememberRemovedModels(provider, change) {
    const listed = change.deleted.filter((id) => change.previous[id]?.configuration_source !== 'manual');
    if (!listed.length && !change.restored.length)
        return;
    const access = (provider.options?.modelAccess ?? {});
    const removedModels = readRemovedModels([
        ...readRemovedModels(access.removedModels),
        ...listed,
    ]).filter((id) => !change.restored.includes(id));
    const rest = { ...access };
    delete rest.removedModels;
    provider.options = {
        ...provider.options,
        modelAccess: { ...rest, ...(removedModels.length ? { removedModels } : {}) },
    };
}
/**
 * Remove the binding before the config entry: a deleted provider must not keep
 * routing, and a borrowed binding removal also stops that host agent's borrow.
 * Only the named binding is removed; external client logins are untouched.
 */
async function removeModelAccessBinding(context, providerKey) {
    const bindings = context.deps.modelAccess?.bindings;
    const binding = bindings?.peek(providerKey);
    if (!bindings || !binding)
        return;
    try {
        await bindings.remove(providerKey);
    }
    catch {
        throw new LocalModelProviderError(409, 'Extension binding changed or could not be removed', 'MODEL_ACCESS_BINDING_CONFLICT');
    }
}
//# sourceMappingURL=service-custom-provider-operations.js.map