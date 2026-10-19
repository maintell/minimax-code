import { LocalMatrixClient } from '../matrix/local-matrix-client.js';
const WEBSITE_STATE_GET_PATH = '/mavis/api/v1/drive/websites/state/get';
const WEBSITE_LIST_PATH = '/mavis/api/v1/drive/websites/list';
const WEBSITE_LIST_MAX_OFFSET = 2_147_483_647;
const WEBSITE_TRAFFIC_GET_PATH = '/mavis/api/v1/drive/websites/traffic/get';
const WEBSITE_WATERMARK_UPDATE_PATH = '/mavis/api/v1/drive/websites/watermark/update';
const WEBSITE_ALIAS_CHECK_PATH = '/mavis/api/v1/drive/websites/alias/check';
const WEBSITE_NAME_UPDATE_PATH = '/mavis/api/v1/drive/websites/name/update';
const WEBSITE_ALIAS_SET_PATH = '/mavis/api/v1/drive/websites/alias/set';
const WEBSITE_ALIAS_UNBIND_PATH = '/mavis/api/v1/drive/websites/alias/unbind';
const WEBSITE_ALIAS_REMOVE_PATH = '/mavis/api/v1/drive/websites/alias/remove';
const WEBSITE_DEPLOYMENT_CANCEL_PATH = '/mavis/api/v1/drive/websites/deployment/cancel';
const WEBSITE_UNPUBLISH_PATH = '/mavis/api/v1/drive/websites/deployment/unpublish';
const WEBSITE_REPUBLISH_PATH = '/mavis/api/v1/drive/websites/deployment/republish';
const WEBSITE_PROJECT_SOURCE_DOWNLOAD_URL_PATH = '/mavis/api/v1/drive/websites/project-source/download-url';
export class LocalWebsiteManagementClient {
    gateway;
    constructor(options = {}) {
        this.gateway =
            options.gateway ??
                new LocalMatrixClient({
                    ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
                    ...(options.authContext ? { authContext: options.authContext } : {}),
                    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
                    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
                    routingContextGetter: options.routingContextGetter,
                });
    }
    listWebsites(offset, limit, sort = {}, signal) {
        return this.post(WEBSITE_LIST_PATH, { ...requireWebsitePage(offset, limit), ...requireWebsiteListSort(sort) }, signal);
    }
    getState(nodeId, signal) {
        return this.post(WEBSITE_STATE_GET_PATH, { node_id: requireNodeId(nodeId) }, signal);
    }
    getTraffic(nodeId, days, query = {}, signal) {
        const body = {
            node_id: requireNodeId(nodeId),
            days: requireWebsiteTrafficDays(days),
        };
        if (query.path !== undefined) {
            body.path = query.path;
        }
        if (query.granularity !== undefined) {
            body.granularity = requireWebsiteTrafficGranularity(query.granularity);
        }
        return this.post(WEBSITE_TRAFFIC_GET_PATH, body, signal);
    }
    updateWatermark(nodeId, enabled, signal) {
        if (typeof enabled !== 'boolean')
            throw new Error('watermark_enabled must be a boolean.');
        return this.post(WEBSITE_WATERMARK_UPDATE_PATH, { node_id: requireNodeId(nodeId), watermark_enabled: enabled }, signal);
    }
    updateName(nodeId, displayName, signal) {
        const normalizedDisplayName = displayName.trim();
        if (!normalizedDisplayName)
            throw new Error('display_name must not be empty.');
        return this.post(WEBSITE_NAME_UPDATE_PATH, { node_id: requireNodeId(nodeId), display_name: normalizedDisplayName }, signal);
    }
    setAlias(nodeId, alias, signal) {
        return this.post(WEBSITE_ALIAS_SET_PATH, { node_id: requireNodeId(nodeId), alias: requireAlias(alias) }, signal);
    }
    checkAlias(nodeId, alias, signal) {
        return this.post(WEBSITE_ALIAS_CHECK_PATH, { node_id: requireNodeId(nodeId), alias: requireAlias(alias) }, signal);
    }
    unbindAlias(nodeId, alias, signal) {
        return this.post(WEBSITE_ALIAS_UNBIND_PATH, { node_id: requireNodeId(nodeId), alias: requireAlias(alias) }, signal);
    }
    removeAlias(nodeId, signal) {
        return this.post(WEBSITE_ALIAS_REMOVE_PATH, { node_id: requireNodeId(nodeId) }, signal);
    }
    cancel(nodeId, signal) {
        return this.post(WEBSITE_DEPLOYMENT_CANCEL_PATH, { node_id: requireNodeId(nodeId) }, signal);
    }
    unpublish(nodeId, signal) {
        return this.post(WEBSITE_UNPUBLISH_PATH, { node_id: requireNodeId(nodeId) }, signal);
    }
    republish(nodeId, signal) {
        return this.post(WEBSITE_REPUBLISH_PATH, { node_id: requireNodeId(nodeId) }, signal);
    }
    getProjectSourceDownloadUrl(nodeId, signal) {
        return this.post(WEBSITE_PROJECT_SOURCE_DOWNLOAD_URL_PATH, { node_id: requireNodeId(nodeId) }, signal);
    }
    post(pathname, body, signal) {
        return this.gateway.postGatewayJson(pathname, body, signal);
    }
}
function requireNodeId(nodeId) {
    const normalized = nodeId.trim();
    if (!normalized)
        throw new Error('node_id is required.');
    return normalized;
}
function requireAlias(alias) {
    const normalized = typeof alias === 'string' ? alias.trim() : '';
    if (!normalized)
        throw new Error('alias must not be empty.');
    return normalized;
}
function requireWebsitePage(offset, limit) {
    if (!Number.isInteger(offset) || offset < 0 || offset > WEBSITE_LIST_MAX_OFFSET) {
        throw new Error(`offset must be an integer between 0 and ${WEBSITE_LIST_MAX_OFFSET}.`);
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw new Error('limit must be an integer between 1 and 100.');
    }
    return { offset, limit };
}
function requireWebsiteListSort(sort) {
    const sortBy = sort.sortBy ?? 'updated_at';
    const sortOrder = sort.sortOrder ?? 'desc';
    if (sortBy !== 'deployed_at' && sortBy !== 'updated_at') {
        throw new Error('sort_by must be deployed_at or updated_at.');
    }
    if (sortOrder !== 'asc' && sortOrder !== 'desc') {
        throw new Error('sort_order must be asc or desc.');
    }
    return { sort_by: sortBy, sort_order: sortOrder };
}
function requireWebsiteTrafficDays(days) {
    if (days !== 7 && days !== 30)
        throw new Error('days must be 7 or 30.');
    return days;
}
function requireWebsiteTrafficGranularity(granularity) {
    if (granularity !== 'hour' && granularity !== 'day') {
        throw new Error('granularity must be hour or day.');
    }
    return granularity;
}
export { WEBSITE_ALIAS_CHECK_PATH, WEBSITE_ALIAS_REMOVE_PATH, WEBSITE_ALIAS_SET_PATH, WEBSITE_ALIAS_UNBIND_PATH, WEBSITE_DEPLOYMENT_CANCEL_PATH, WEBSITE_LIST_MAX_OFFSET, WEBSITE_LIST_PATH, WEBSITE_NAME_UPDATE_PATH, WEBSITE_PROJECT_SOURCE_DOWNLOAD_URL_PATH, WEBSITE_REPUBLISH_PATH, WEBSITE_STATE_GET_PATH, WEBSITE_TRAFFIC_GET_PATH, WEBSITE_UNPUBLISH_PATH, WEBSITE_WATERMARK_UPDATE_PATH, };
//# sourceMappingURL=local-website-management-client.js.map