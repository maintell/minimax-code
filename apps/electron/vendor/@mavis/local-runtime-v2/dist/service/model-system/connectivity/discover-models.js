import { buildModelDiscoveryHeaders, providerModelsUrls } from './provider-request.js';
// 候选全部缺失时对外只表达“该提供商没有模型列表接口”，状态码对用户没有判断价值；
// 产品文案据此提示手动添加模型。
const MISSING_MODELS_ENDPOINT = {
    ok: false,
    errorCode: 'models_endpoint_missing',
    errorMessage: 'Model list endpoint not found',
};
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
            const payload = await readJson(response);
            const models = readModels(payload);
            if (!models) {
                return {
                    ok: false,
                    errorCode: 'invalid_response',
                    errorMessage: 'Invalid model discovery response',
                };
            }
            return { ok: true, models };
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
function readDisplayName(record) {
    if (typeof record.display_name === 'string')
        return record.display_name;
    return typeof record.name === 'string' ? record.name : undefined;
}
function isAbortError(error) {
    return Boolean(error && typeof error === 'object' && error.name === 'AbortError');
}
//# sourceMappingURL=discover-models.js.map