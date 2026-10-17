import { buildModelDiscoveryHeaders, providerModelsUrl, } from './provider-request.js';
export class ModelDiscoveryClient {
    fetchImpl;
    timeoutMs;
    constructor(fetchImpl = fetch, timeoutMs = 10_000) {
        this.fetchImpl = fetchImpl;
        this.timeoutMs = timeoutMs;
    }
    async discover(target) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        try {
            const response = await this.fetchImpl(providerModelsUrl(target.api, target.baseUrl), {
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
        const displayName = typeof record.display_name === 'string'
            ? record.display_name
            : typeof record.name === 'string'
                ? record.name
                : undefined;
        return [
            {
                modelId: record.id,
                ...(displayName ? { displayName } : {}),
            },
        ];
    });
    return models;
}
function isAbortError(error) {
    return Boolean(error && typeof error === 'object' && error.name === 'AbortError');
}
//# sourceMappingURL=discover-models.js.map