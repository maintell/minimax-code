import { getRuntimeRegion } from '@mavis/config';
import { normalizeProviderBaseUrl } from '../../connectivity/provider-request.js';
import { fetchModelsDevCatalog, fetchPinnedProviderIdsConfig, MODELS_DEV_URL, } from './provider-presets.client.js';
import { readProviderPresetSnapshotCandidates, resolveProviderPresetLocalCatalogPath, writeProviderPresetSnapshot, } from './provider-presets.repository.js';
const OPENAI_BASE_URL = 'https://api.openai.com/v1';
const MESSAGES_API_BASE_URL = 'https://api.anthropic.com';
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
// No provider id is filtered out of the catalog: MiniMax presets are offered
// through BYOK like any other vendor, alongside the built-in managed provider
// and the first-party `minimax_api` key entry. Display order (including whether
// MiniMax is pinned) is owned by Apollo `agent_byok_pinned_provider_ids`, with
// REGION_PINNED_PROVIDER_IDS as the local fallback.
const REGION_PINNED_PROVIDER_IDS = {
    cn: ['zhipuai-coding-plan', 'zhipuai', 'deepseek', 'moonshotai-cn', 'openai', 'anthropic'],
    en: ['zai-coding-plan', 'zai', 'deepseek', 'moonshotai', 'openai', 'anthropic'],
};
// These IDs belong to models.dev, not the bundled inference registry. Keep their
// URLs and IDs intact, and make the billing plan explicit at selection time.
const PROVIDER_PLAN_NAMES = new Map([
    ['zai', 'Z.AI API'],
    ['zai-coding-plan', 'Z.AI Coding Plan'],
    ['zhipuai', 'Zhipu AI API'],
    ['zhipuai-coding-plan', 'Zhipu AI Coding Plan'],
]);
const refreshInFlight = new Map();
export class ProviderPresetCatalog {
    options;
    constructor(options = {}) {
        this.options = options;
        const refreshKey = resolveProviderPresetLocalCatalogPath(options) ?? options.bundledCatalogPath ?? 'default';
        if (!refreshInFlight.has(refreshKey)) {
            const refresh = refreshModelsDevSnapshotInBackground(options, refreshKey);
            refreshInFlight.set(refreshKey, refresh);
        }
    }
    async listProviderPresets() {
        const latest = await latestCatalogSnapshot(this.options);
        if (!latest)
            throw new Error('No valid models.dev catalog snapshot is available');
        const pinnedProviderIds = (await resolvePinnedProviderIds({
            fetchImpl: this.options.commonConfigFetch,
            originGetter: this.options.commonConfigOriginGetter,
            timeoutMs: this.options.commonConfigTimeoutMs,
            previewSecret: this.options.previewSecret,
            lane: this.options.lane,
        })) ?? REGION_PINNED_PROVIDER_IDS[(this.options.regionGetter ?? getRuntimeRegion)()];
        return orderProviderPresets(latest.presets, pinnedProviderIds);
    }
}
async function resolvePinnedProviderIds(options) {
    try {
        return parsePinnedProviderIds(await fetchPinnedProviderIdsConfig(options));
    }
    catch {
        return undefined;
    }
}
function parseModelsDevProviderPresets(value, iconBaseUrl) {
    if (!isRecord(value))
        throw new Error('models.dev returned an invalid catalog');
    const presets = [];
    for (const [providerId, rawProvider] of Object.entries(value)) {
        const preset = parseProvider(providerId, rawProvider, iconBaseUrl);
        if (preset)
            presets.push(preset);
    }
    return presets.sort((left, right) => left.name.localeCompare(right.name));
}
function parseProvider(providerId, value, iconBaseUrl) {
    if (!providerId.trim() || !isRecord(value) || !isRecord(value.models)) {
        return undefined;
    }
    const transport = resolveTransport(providerId, value);
    if (!transport)
        return undefined;
    const models = Object.entries(value.models)
        .map(([modelId, model]) => parseModel(modelId, model))
        .filter((model) => model !== undefined)
        .sort((left, right) => (left.displayName ?? left.modelId).localeCompare(right.displayName ?? right.modelId));
    if (models.length === 0)
        return undefined;
    return {
        providerId,
        name: PROVIDER_PLAN_NAMES.get(providerId) ?? stringValue(value.name) ?? providerId,
        ...transport,
        models,
        ...(iconBaseUrl ? { iconUrl: resolveProviderIconUrl(iconBaseUrl, providerId) } : {}),
    };
}
// OpenRouter ships its own SDK package in models.dev, but its wire protocol is
// the OpenAI chat-completions API.
const TRANSPORTS_BY_NPM = new Map([
    [
        '@ai-sdk/openai',
        {
            apiFormat: 'openai-responses',
            canonical: { providerId: 'openai', baseUrl: OPENAI_BASE_URL },
        },
    ],
    ['@ai-sdk/openai-compatible', { apiFormat: 'openai-completions' }],
    [
        '@ai-sdk/anthropic',
        {
            apiFormat: 'anthropic-messages',
            canonical: { providerId: 'anthropic', baseUrl: MESSAGES_API_BASE_URL },
        },
    ],
    [
        '@openrouter/ai-sdk-provider',
        {
            apiFormat: 'openai-completions',
            canonical: { providerId: 'openrouter', baseUrl: OPENROUTER_BASE_URL },
        },
    ],
]);
function resolveTransport(providerId, provider) {
    const transport = TRANSPORTS_BY_NPM.get(stringValue(provider.npm) ?? '');
    if (!transport)
        return undefined;
    const { apiFormat, canonical } = transport;
    const baseUrl = canonical?.providerId === providerId && provider.api === undefined
        ? canonical.baseUrl
        : stringValue(provider.api);
    if (!baseUrl || !isHttpUrl(baseUrl))
        return undefined;
    return { baseUrl: normalizeProviderBaseUrl(apiFormat, baseUrl), apiFormat };
}
function parseModel(modelId, value) {
    if (!modelId.trim() || !isRecord(value) || value.tool_call !== true)
        return undefined;
    return {
        modelId,
        displayName: stringValue(value.name) ?? modelId,
        ...parseModelCapabilities(value),
        ...parseModelEffortOptions(value),
        ...parseModelModalities(value),
        ...parseModelLimit(value),
    };
}
function parseModelCapabilities(value) {
    return {
        attachment: value.attachment === true,
        reasoning: value.reasoning === true,
        toolCall: true,
        temperature: value.temperature === true,
    };
}
/**
 * Reads the catalog's declared reasoning-effort levels. models.dev describes
 * reasoning controls as `reasoning_options` entries; only an explicit
 * `{ type: 'effort', values: [...] }` entry means the model accepts effort
 * selection. A bare `reasoning: true` or a `toggle` entry only means the model
 * can think, so neither one produces `effortOptions` here. Declared strings
 * are preserved as-is (trimmed, de-duplicated, in catalog order) so levels the
 * CLI does not know about still reach validation and the wire unchanged.
 */
function parseModelEffortOptions(value) {
    if (!Array.isArray(value.reasoning_options))
        return {};
    for (const option of value.reasoning_options) {
        if (!isRecord(option) || option.type !== 'effort' || !Array.isArray(option.values))
            continue;
        const effortOptions = [
            ...new Set(option.values
                .filter((candidate) => typeof candidate === 'string')
                .map((candidate) => candidate.trim())
                .filter(Boolean)),
        ];
        if (effortOptions.length > 0)
            return { effortOptions };
    }
    return {};
}
function parseModelModalities(value) {
    const modalities = isRecord(value.modalities) ? value.modalities : undefined;
    const input = stringArray(modalities?.input);
    const output = stringArray(modalities?.output);
    if (!input && !output)
        return {};
    return { modalities: { ...(input ? { input } : {}), ...(output ? { output } : {}) } };
}
function parseModelLimit(value) {
    const limit = isRecord(value.limit) ? value.limit : undefined;
    const context = positiveInteger(limit?.context);
    const output = positiveInteger(limit?.output);
    if (!context && !output)
        return {};
    return { limit: { ...(context ? { context } : {}), ...(output ? { output } : {}) } };
}
function parsePinnedProviderIds(value) {
    let decoded = value;
    if (typeof value === 'string') {
        try {
            decoded = JSON.parse(value);
        }
        catch {
            return undefined;
        }
    }
    if (!Array.isArray(decoded) ||
        decoded.some((providerId) => typeof providerId !== 'string' || !providerId.trim())) {
        return undefined;
    }
    return [...new Set(decoded)];
}
function orderProviderPresets(presets, pinnedProviderIds) {
    const byId = new Map(presets.map((preset) => [preset.providerId, preset]));
    const pinned = pinnedProviderIds.flatMap((providerId) => {
        const preset = byId.get(providerId);
        if (!preset)
            return [];
        byId.delete(providerId);
        return [preset];
    });
    return [
        ...pinned,
        ...[...byId.values()].sort((left, right) => left.name.localeCompare(right.name)),
    ];
}
async function refreshModelsDevSnapshot(options) {
    const current = await latestCatalogSnapshot(options);
    const region = (options.regionGetter ?? getRuntimeRegion)();
    const result = await fetchModelsDevCatalog({
        fetchImpl: options.modelsDevFetch,
        timeoutMs: options.modelsDevTimeoutMs,
        etag: current?.snapshot.iconBaseUrl ? current.snapshot.etag : undefined,
        region,
        descriptorOriginGetter: options.commonConfigOriginGetter,
        previewSecret: options.previewSecret,
        lane: options.lane,
    });
    if (result.kind === 'not_modified')
        return;
    const presets = parseModelsDevProviderPresets(result.catalog, result.iconBaseUrl);
    if (presets.length === 0)
        throw new Error('models.dev returned no supported providers');
    const snapshot = {
        version: 1,
        source: MODELS_DEV_URL,
        updatedAt: (options.now ?? Date.now)(),
        ...(result.etag ? { etag: result.etag } : {}),
        iconBaseUrl: result.iconBaseUrl,
        catalog: result.catalog,
    };
    const localCatalogPath = resolveProviderPresetLocalCatalogPath(options);
    if (localCatalogPath)
        await writeProviderPresetSnapshot(localCatalogPath, snapshot);
}
async function refreshModelsDevSnapshotInBackground(options, refreshKey) {
    try {
        await refreshModelsDevSnapshot(options);
    }
    catch {
        // The validated local snapshot remains authoritative when refresh fails.
    }
    finally {
        refreshInFlight.delete(refreshKey);
    }
}
async function latestCatalogSnapshot(options) {
    const parsed = [];
    for (const candidate of await readProviderPresetSnapshotCandidates(options)) {
        try {
            parsed.push(parseCatalogSnapshot(candidate));
        }
        catch {
            // A corrupt candidate must not hide another valid local snapshot.
        }
    }
    return parsed.sort((left, right) => right.snapshot.updatedAt - left.snapshot.updatedAt)[0];
}
function parseCatalogSnapshot(value) {
    const updatedAt = isRecord(value) ? positiveInteger(value.updatedAt) : undefined;
    if (!isRecord(value) ||
        value.version !== 1 ||
        value.source !== MODELS_DEV_URL ||
        !updatedAt ||
        !isRecord(value.catalog)) {
        throw new Error('Invalid models.dev catalog snapshot');
    }
    const iconBaseUrl = parseSnapshotIconBaseUrl(value.iconBaseUrl);
    const presets = parseModelsDevProviderPresets(value.catalog, iconBaseUrl);
    if (presets.length === 0) {
        throw new Error('models.dev catalog snapshot has no supported providers');
    }
    const etag = stringValue(value.etag);
    return {
        snapshot: {
            version: 1,
            source: MODELS_DEV_URL,
            updatedAt,
            ...(etag ? { etag } : {}),
            ...(iconBaseUrl ? { iconBaseUrl } : {}),
            catalog: value.catalog,
        },
        presets,
    };
}
function parseSnapshotIconBaseUrl(value) {
    if (value === undefined)
        return undefined;
    const iconBaseUrl = stringValue(value);
    if (!iconBaseUrl || !isHttpUrl(iconBaseUrl)) {
        throw new Error('Invalid models.dev icon base URL');
    }
    return iconBaseUrl;
}
function isHttpUrl(value) {
    try {
        const url = new URL(value);
        return url.protocol === 'https:' || url.protocol === 'http:';
    }
    catch {
        return false;
    }
}
function resolveProviderIconUrl(iconBaseUrl, providerId) {
    const prefix = iconBaseUrl.endsWith('/') ? iconBaseUrl : `${iconBaseUrl}/`;
    return `${prefix}${encodeURIComponent(providerId)}.svg`;
}
function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function stringValue(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
function stringArray(value) {
    if (!Array.isArray(value))
        return undefined;
    const strings = value.filter((item) => typeof item === 'string' && Boolean(item));
    return strings.length > 0 ? strings : undefined;
}
function positiveInteger(value) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}
//# sourceMappingURL=provider-presets.service.js.map