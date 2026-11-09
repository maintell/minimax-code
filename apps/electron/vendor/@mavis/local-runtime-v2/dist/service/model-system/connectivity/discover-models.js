import { buildModelDiscoveryHeaders, providerModelsUrls } from './provider-request.js';
// 候选全部缺失时对外只表达“该提供商没有模型列表接口”，状态码对用户没有判断价值；
// 产品文案据此提示手动添加模型。
const MISSING_MODELS_ENDPOINT = {
    ok: false,
    errorCode: 'models_endpoint_missing',
    errorMessage: 'Model list endpoint not found',
};
const INVALID_DISCOVERY_RESPONSE = {
    ok: false,
    errorCode: 'invalid_response',
    errorMessage: 'Invalid model discovery response',
};
/** Bounds `nextPageToken` pagination against a gateway that never stops paging. */
const GEMINI_MAX_MODEL_PAGES = 20;
export class ModelDiscoveryClient {
    fetchImpl;
    timeoutMs;
    constructor(fetchImpl = fetch, timeoutMs = 10_000) {
        this.fetchImpl = fetchImpl;
        this.timeoutMs = timeoutMs;
    }
    // 原生端点返回 404/405 说明该网关没有这个列表接口，继续尝试 OpenAI 风格候选；
    // 鉴权、限流和服务端错误立即返回，避免把真实故障伪装成端点缺失。
    async discover(target) {
        const [primaryUrl, ...fallbackUrls] = providerModelsUrls(target.api, target.baseUrl);
        const primary = await this.discoverAt(primaryUrl, target);
        if (primary.ok || !isMissingModelsEndpoint(primary))
            return primary;
        for (const url of fallbackUrls) {
            const result = await this.discoverAt(url, target);
            if (result.ok || !isMissingModelsEndpoint(result))
                return result;
        }
        return MISSING_MODELS_ENDPOINT;
    }
    async discoverAt(url, target) {
        const page = await this.fetchPage(url, target);
        if (!page.ok)
            return page;
        if (target.api === 'google-generative-ai') {
            return this.collectGeminiPages(url, target, page.payload);
        }
        const models = readModels(page.payload);
        return models ? { ok: true, models } : INVALID_DISCOVERY_RESPONSE;
    }
    async collectGeminiPages(url, target, firstPayload) {
        const models = [];
        let payload = firstPayload;
        for (let pageCount = 1;; pageCount += 1) {
            const page = readGeminiModelsPage(payload);
            if (!page)
                return INVALID_DISCOVERY_RESPONSE;
            models.push(...page.models);
            if (!page.nextPageToken || pageCount >= GEMINI_MAX_MODEL_PAGES)
                return { ok: true, models };
            const nextUrl = new URL(url);
            nextUrl.searchParams.set('pageToken', page.nextPageToken);
            const next = await this.fetchPage(nextUrl.toString(), target);
            if (!next.ok)
                return next;
            payload = next.payload;
        }
    }
    async fetchPage(url, target) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        try {
            const response = await this.fetchImpl(url, {
                method: 'GET',
                headers: buildModelDiscoveryHeaders(target),
                signal: controller.signal,
            });
            if (response.status === 401 || response.status === 403) {
                return {
                    ok: false,
                    errorCode: 'unauthorized',
                    errorMessage: `Authentication failed (HTTP ${response.status})`,
                };
            }
            if (!response.ok) {
                return {
                    ok: false,
                    errorCode: `http_${response.status}`,
                    errorMessage: `HTTP ${response.status}`,
                };
            }
            return { ok: true, payload: await readJson(response) };
        }
        catch (error) {
            if (isAbortError(error)) {
                return {
                    ok: false,
                    errorCode: 'timeout',
                    errorMessage: `Request timed out after ${this.timeoutMs}ms`,
                };
            }
            return { ok: false, errorCode: 'network', errorMessage: 'Network error' };
        }
        finally {
            clearTimeout(timer);
        }
    }
}
function isMissingModelsEndpoint(result) {
    return !result.ok && (result.errorCode === 'http_404' || result.errorCode === 'http_405');
}
async function readJson(response) {
    try {
        return await response.json();
    }
    catch (error) {
        if (isAbortError(error))
            throw error;
        return undefined;
    }
}
function readModels(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload))
        return undefined;
    const data = payload.data;
    if (!Array.isArray(data))
        return undefined;
    const models = data.flatMap((item) => {
        if (!item || typeof item !== 'object' || Array.isArray(item))
            return [];
        const record = item;
        if (typeof record.id !== 'string' || !record.id.trim())
            return [];
        const displayName = readDisplayName(record);
        return [
            {
                modelId: record.id,
                ...(displayName ? { displayName } : {}),
            },
        ];
    });
    return models;
}
/**
 * Gemini `models.list`: `{models: [{name: "models/<id>", displayName,
 * supportedGenerationMethods}], nextPageToken}`. Embedding and other
 * non-chat models do not support `generateContent` and are skipped.
 */
function readGeminiModelsPage(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload))
        return undefined;
    const { models, nextPageToken } = payload;
    // An account without models returns `{}`.
    if (models !== undefined && !Array.isArray(models))
        return undefined;
    return {
        models: (models ?? []).flatMap((item) => {
            if (!item || typeof item !== 'object' || Array.isArray(item))
                return [];
            const record = item;
            if (typeof record.name !== 'string')
                return [];
            const modelId = record.name.replace(/^models\//u, '').trim();
            if (!modelId)
                return [];
            const methods = record.supportedGenerationMethods;
            if (Array.isArray(methods) && !methods.includes('generateContent'))
                return [];
            return [
                {
                    modelId,
                    ...(typeof record.displayName === 'string' ? { displayName: record.displayName } : {}),
                },
            ];
        }),
        ...(typeof nextPageToken === 'string' && nextPageToken ? { nextPageToken } : {}),
    };
}
function readDisplayName(record) {
    if (typeof record.display_name === 'string')
        return record.display_name;
    return typeof record.name === 'string' ? record.name : undefined;
}
function isAbortError(error) {
    return Boolean(error && typeof error === 'object' && error.name === 'AbortError');
}
//# sourceMappingURL=discover-models.js.map