import { InstalledPluginSource, PluginInstallationPolicy, } from '@mavis/thrift-gen/generated/desktop-service/types';
import { PluginSystemCloudTransport, PluginSystemCloudTransportError, } from '../../cloud-transport.js';
const CLOUD_BASE = '/minimax-cloud/api/v1';
const ARCHIVE_SHA = /^[0-9a-f]{64}$/u;
const CONTENT_DIGEST = /^sha256-tree-v1:[0-9a-f]{64}$/u;
/** Typed CloudPluginService client. It never calls the Desktop HTTP front door. */
export class PluginRegistryClient {
    transport;
    constructor(transport) {
        this.transport = transport;
    }
    async listMarketplace(req) {
        const payload = await this.transport.request({
            method: 'GET',
            path: `${CLOUD_BASE}/marketplace/plugins`,
            query: marketplaceQuery(req),
            // Authentication enriches catalog metadata such as creator names while
            // still allowing signed-out browsing. Desktop installation state remains
            // authoritative because the facade overlays every personalized state field.
            auth: 'optional',
        });
        return readMarketplaceResponse(payload);
    }
    async getMarketplace(req) {
        const pluginName = pathSegment(req.pluginName, 'Plugin name');
        const payload = await this.transport.request({
            method: 'GET',
            path: `${CLOUD_BASE}/marketplace/plugins/${pluginName}`,
            query: { source: req.source },
            auth: 'optional',
        });
        return readMarketplaceDetailResponse(payload);
    }
    async listInstalled(req) {
        const payload = await this.transport.request({
            method: 'GET',
            path: `${CLOUD_BASE}/plugins/installed`,
            query: { cursor: req.cursor, limit: req.limit, keyword: req.keyword },
            auth: 'required',
        });
        return readInstalledResponse(payload);
    }
    async listEnabled() {
        const payload = await this.transport.request({
            method: 'GET',
            path: `${CLOUD_BASE}/plugins/enabled`,
            auth: 'required',
        });
        return readEnabledResponse(payload);
    }
    async getFullState(signal) {
        const payload = await this.transport.request({
            method: 'GET',
            path: `${CLOUD_BASE}/plugins/full-state`,
            auth: 'required',
            signal,
        });
        return readFullState(payload);
    }
    async mutate(pluginName, action) {
        const name = pathSegment(pluginName, 'Plugin name');
        const payload = await this.transport.request({
            method: 'POST',
            path: `${CLOUD_BASE}/plugins/${name}/${action}`,
            auth: 'required',
        });
        return readMutationResponse(payload);
    }
    async authorizeDownload(pluginName, version, signal) {
        const name = pathSegment(pluginName, 'Plugin name');
        const packageVersion = pathSegment(version, 'Plugin version');
        const payload = await this.transport.request({
            method: 'POST',
            path: `${CLOUD_BASE}/plugins/${name}/versions/${packageVersion}/download-authorization`,
            auth: 'required',
            signal,
        });
        const record = requireRecord(payload, 'download authorization response');
        const authorization = requireRecordField(record, 'authorization', 'authorization', 'download authorization');
        const downloadUrl = requireString(authorization, 'download_url', 'downloadUrl');
        const expiresAtMs = requireNumber(authorization, 'expires_at_ms', 'expiresAtMs');
        return {
            package: readPackage(requireRecordField(authorization, 'package', 'package', 'package')),
            downloadUrl,
            expiresAtMs,
        };
    }
    downloadToFile(url, targetPath, signal) {
        return this.transport.downloadToFile(url, targetPath, signal);
    }
}
function marketplaceQuery(req) {
    return {
        cursor: req.cursor,
        limit: req.limit,
        keyword: req.keyword,
        category: req.category,
        skill_cursor: req.skillCursor,
        skill_limit: req.skillLimit,
        source: req.source,
        source_type: req.skillSourceType,
        sort_type: req.skillSortType,
    };
}
function readMarketplaceResponse(value) {
    const record = requireRecord(value, 'Marketplace response');
    return {
        plugins: readArray(record, 'plugins', 'plugins').map(readMarketplaceSummary),
        ...optionalStringProjection(record, 'next_cursor', 'nextCursor', 'nextCursor'),
        ...optionalBooleanProjection(record, 'has_more', 'hasMore', 'hasMore'),
        ...optionalNumberProjection(record, 'plugin_total', 'pluginTotal', 'pluginTotal'),
        ...optionalBooleanProjection(record, 'cursor_reset_required', 'cursorResetRequired', 'cursorResetRequired'),
        ...optionalArrayProjection(record, ['marketplace_skills', 'marketplaceSkills'], 'marketplaceSkills', readSkillHubItem),
        ...optionalStringProjection(record, 'skill_next_cursor', 'skillNextCursor', 'skillNextCursor'),
        ...optionalBooleanProjection(record, 'skill_has_more', 'skillHasMore', 'skillHasMore'),
        ...baseRespProjection(record),
    };
}
function readMarketplaceDetailResponse(value) {
    const record = requireRecord(value, 'Marketplace detail response');
    const raw = field(record, 'plugin', 'plugin');
    return {
        ...(raw === undefined ? {} : { plugin: readMarketplaceDetail(raw) }),
        ...baseRespProjection(record),
    };
}
function readMarketplaceDetail(value) {
    const record = requireRecord(value, 'Plugin detail');
    return {
        summary: readMarketplaceSummary(field(record, 'summary', 'summary')),
        apps: readArray(record, 'apps', 'apps').map(readPluginApp),
        mcpServers: readArray(record, 'mcp_servers', 'mcpServers').map((item) => {
            const server = requireRecord(item, 'Plugin MCP server');
            return {
                name: requireString(server, 'name', 'name'),
                transport: requireString(server, 'transport', 'transport'),
                ...optionalStringProjection(server, 'description', 'description', 'description'),
                configJson: requireString(server, 'config_json', 'configJson'),
            };
        }),
        skills: readArray(record, 'skills', 'skills').map((item) => {
            const skill = requireRecord(item, 'Plugin Skill');
            return {
                name: requireString(skill, 'name', 'name'),
                ...optionalStringProjection(skill, 'display_name', 'displayName', 'displayName'),
                ...optionalStringProjection(skill, 'description', 'description', 'description'),
                content: requireString(skill, 'content', 'content'),
            };
        }),
        ...optionalArrayProjection(record, ['example_queries', 'exampleQueries'], 'exampleQueries', requireStringValue),
    };
}
function readMarketplaceSummary(value) {
    const record = requireRecord(value, 'Plugin Marketplace summary');
    return {
        name: requireString(record, 'name', 'name'),
        ...optionalStringProjection(record, 'version', 'version', 'version'),
        ...optionalStringProjection(record, 'display_name', 'displayName', 'displayName'),
        ...optionalStringProjection(record, 'description', 'description', 'description'),
        ...optionalStringProjection(record, 'author', 'author', 'author'),
        ...optionalStringProjection(record, 'icon_url', 'iconUrl', 'iconUrl'),
        ...optionalStringProjection(record, 'dark_icon_url', 'darkIconUrl', 'darkIconUrl'),
        capabilities: readCapabilities(field(record, 'capabilities', 'capabilities')),
        installExists: requireBoolean(record, 'install_exists', 'installExists'),
        enabled: requireBoolean(record, 'enabled', 'enabled'),
        ...optionalNumberProjection(record, 'category', 'category', 'category'),
        installationPolicy: readInstallationPolicy(record),
    };
}
function readInstalledResponse(value) {
    const record = requireRecord(value, 'installed Plugin response');
    const response = {
        plugins: readArray(record, 'plugins', 'plugins').map(readInstalledSummary),
        ...optionalStringProjection(record, 'next_cursor', 'nextCursor', 'nextCursor'),
        hasMore: requireBoolean(record, 'has_more', 'hasMore'),
        ...baseRespProjection(record),
    };
    if (response.hasMore && !response.nextCursor) {
        throw invalidResponse('installed Plugin response is missing next_cursor');
    }
    return response;
}
function readInstalledSummary(value) {
    const record = requireRecord(value, 'installed Plugin summary');
    return {
        name: requireString(record, 'name', 'name'),
        ...optionalStringProjection(record, 'version', 'version', 'version'),
        ...optionalStringProjection(record, 'display_name', 'displayName', 'displayName'),
        ...optionalStringProjection(record, 'description', 'description', 'description'),
        ...optionalStringProjection(record, 'author', 'author', 'author'),
        ...optionalStringProjection(record, 'icon_url', 'iconUrl', 'iconUrl'),
        ...optionalStringProjection(record, 'dark_icon_url', 'darkIconUrl', 'darkIconUrl'),
        capabilities: readCapabilities(field(record, 'capabilities', 'capabilities')),
        source: readInstalledSource(record),
        enabled: requireBoolean(record, 'enabled', 'enabled'),
        ...optionalNumberProjection(record, 'category', 'category', 'category'),
        installationPolicy: readInstallationPolicy(record),
    };
}
function readEnabledResponse(value) {
    const record = requireRecord(value, 'enabled Plugin response');
    return {
        plugins: readArray(record, 'plugins', 'plugins').map(readEnabledSummary),
        ...baseRespProjection(record),
    };
}
function readEnabledSummary(value) {
    const record = requireRecord(value, 'enabled Plugin summary');
    return {
        name: requireString(record, 'name', 'name'),
        ...optionalStringProjection(record, 'display_name', 'displayName', 'displayName'),
        ...optionalStringProjection(record, 'icon_url', 'iconUrl', 'iconUrl'),
        ...optionalStringProjection(record, 'dark_icon_url', 'darkIconUrl', 'darkIconUrl'),
    };
}
function readMutationResponse(value) {
    const record = requireRecord(value, 'Plugin mutation response');
    const packageValue = field(record, 'package', 'package');
    return {
        source: readInstalledSource(record),
        installExists: requireBoolean(record, 'install_exists', 'installExists'),
        enabled: requireBoolean(record, 'enabled', 'enabled'),
        ...(packageValue === undefined ? {} : { package: readPackage(packageValue) }),
        installationPolicy: readInstallationPolicy(record),
        ...baseRespProjection(record),
    };
}
function readFullState(value) {
    const record = requireRecord(value, 'Plugin full-state response');
    const runtimeEnabled = requireBoolean(record, 'runtime_enabled', 'runtimeEnabled');
    const effectivePlugins = readArray(record, 'effective_plugins', 'effectivePlugins').map(readPackage);
    if (!runtimeEnabled && effectivePlugins.length > 0) {
        throw invalidResponse('explicit-off full-state contains effective Plugins');
    }
    return {
        runtimeEnabled,
        installations: readArray(record, 'installations', 'installations').map(readInstallation),
        effectivePlugins,
    };
}
function readInstallation(value) {
    const record = requireRecord(value, 'Plugin installation');
    return {
        package: readPackage(field(record, 'package', 'package')),
        enabled: requireBoolean(record, 'enabled', 'enabled'),
        installationPolicy: readInstallationPolicy(record),
        ...optionalNumberProjection(record, 'updated_at_ms', 'updatedAtMs', 'updatedAtMs'),
    };
}
function readInstallationPolicy(record) {
    const value = field(record, 'installation_policy', 'installationPolicy');
    if (value === undefined || value === null || value === 0) {
        return PluginInstallationPolicy.USER_MANAGED;
    }
    if (value === PluginInstallationPolicy.USER_MANAGED ||
        value === PluginInstallationPolicy.DEFAULT_INSTALLED_UNREMOVABLE) {
        return value;
    }
    throw invalidResponse('Plugin installation policy is invalid');
}
function readPackage(value) {
    const record = requireRecord(value, 'Plugin package');
    const item = {
        name: requireString(record, 'name', 'name'),
        version: requireString(record, 'version', 'version'),
        archiveSha256: requireString(record, 'archive_sha256', 'archiveSha256'),
        contentDigest: requireString(record, 'content_digest', 'contentDigest'),
    };
    if (!ARCHIVE_SHA.test(item.archiveSha256) || !CONTENT_DIGEST.test(item.contentDigest)) {
        throw invalidResponse('Plugin package has an invalid digest');
    }
    return item;
}
function readCapabilities(value) {
    const record = requireRecord(value, 'Plugin capabilities');
    return {
        appCount: requireNumber(record, 'app_count', 'appCount'),
        mcpServerCount: requireNumber(record, 'mcp_server_count', 'mcpServerCount'),
        skillCount: requireNumber(record, 'skill_count', 'skillCount'),
        ...optionalNumberProjection(record, 'hook_count', 'hookCount', 'hookCount'),
    };
}
function readPluginApp(value) {
    const record = requireRecord(value, 'Plugin App');
    const connection = field(record, 'connection', 'connection');
    const actions = field(record, 'actions', 'actions');
    return {
        provider: requireString(record, 'provider', 'provider'),
        ...optionalStringProjection(record, 'display_name', 'displayName', 'displayName'),
        ...optionalStringProjection(record, 'logo_url', 'logoUrl', 'logoUrl'),
        ...optionalStringProjection(record, 'dark_logo_url', 'darkLogoUrl', 'darkLogoUrl'),
        ...optionalStringProjection(record, 'status', 'status', 'status'),
        ...(isRecord(connection) ? { connection: connection } : {}),
        ...(isRecord(actions) ? { actions: actions } : {}),
    };
}
function readSkillHubItem(value) {
    const record = requireRecord(value, 'Skill Marketplace item');
    return {
        id: requireI64(record, 'id', 'id'),
        name: requireString(record, 'name', 'name'),
        ...optionalStringProjection(record, 'display_name', 'displayName', 'displayName'),
        ...optionalStringProjection(record, 'description', 'description', 'description'),
        ...optionalStringProjection(record, 'display_description', 'displayDescription', 'displayDescription'),
        ...optionalStringProjection(record, 'content', 'content', 'content'),
        ...optionalStringProjection(record, 'source_url', 'sourceUrl', 'sourceUrl'),
        ...optionalNumberProjection(record, 'source_type', 'sourceType', 'sourceType'),
        ...optionalCreatorInfoProjection(record),
        ...optionalI64Projection(record, 'use_count', 'useCount', 'useCount'),
        ...optionalBooleanProjection(record, 'added', 'added', 'added'),
        ...optionalI64Projection(record, 'created_at', 'createdAt', 'createdAt'),
        ...optionalI64Projection(record, 'updated_at', 'updatedAt', 'updatedAt'),
        ...optionalNumberProjection(record, 'category', 'category', 'category'),
    };
}
function optionalCreatorInfoProjection(record) {
    const value = field(record, 'creator_info', 'creatorInfo');
    if (value === undefined || value === null)
        return {};
    const creator = requireRecord(value, 'Skill Marketplace creator');
    const creatorInfo = {
        ...optionalStringProjection(creator, 'user_id', 'userId', 'userId'),
        ...optionalStringProjection(creator, 'user_name', 'userName', 'userName'),
        ...optionalStringProjection(creator, 'avatar_url', 'avatarUrl', 'avatarUrl'),
    };
    return Object.keys(creatorInfo).length > 0 ? { creatorInfo } : {};
}
function baseRespProjection(record) {
    const baseResp = field(record, 'base_resp', 'baseResp');
    return isRecord(baseResp) ? { baseResp } : {};
}
function optionalStringProjection(record, snake, camel, output) {
    const value = field(record, snake, camel);
    return typeof value === 'string' ? { [output]: value } : {};
}
function optionalNumberProjection(record, snake, camel, output) {
    const value = field(record, snake, camel);
    return typeof value === 'number' ? { [output]: value } : {};
}
function optionalI64Projection(record, snake, camel, output) {
    const value = field(record, snake, camel);
    return typeof value === 'number' ? { [output]: value } : {};
}
function optionalBooleanProjection(record, snake, camel, output) {
    const value = field(record, snake, camel);
    return typeof value === 'boolean' ? { [output]: value } : {};
}
function optionalArrayProjection(record, keys, output, mapper) {
    const value = field(record, keys[0], keys[1]);
    return Array.isArray(value) ? { [output]: value.map(mapper) } : {};
}
function field(record, snake, camel) {
    return record[snake] ?? record[camel];
}
function readArray(record, snake, camel) {
    const snakeValue = record[snake];
    const value = snakeValue === undefined ? record[camel] : snakeValue;
    if (value === null)
        return [];
    if (!Array.isArray(value))
        throw invalidResponse(`${snake} is not an array`);
    return value;
}
function requireRecord(value, label) {
    if (!isRecord(value))
        throw invalidResponse(`${label} is invalid`);
    return value;
}
function requireRecordField(record, snake, camel, label) {
    return requireRecord(field(record, snake, camel), label);
}
function requireString(record, snake, camel) {
    return requireStringValue(field(record, snake, camel));
}
function requireStringValue(value) {
    if (typeof value !== 'string' || !value.trim())
        throw invalidResponse('required string is missing');
    return value;
}
function requireBoolean(record, snake, camel) {
    const value = field(record, snake, camel);
    if (typeof value !== 'boolean')
        throw invalidResponse(`${snake} is not a boolean`);
    return value;
}
function requireNumber(record, snake, camel) {
    const value = field(record, snake, camel);
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw invalidResponse(`${snake} is not a number`);
    }
    return value;
}
function requireI64(record, snake, camel) {
    const value = field(record, snake, camel);
    if (typeof value !== 'number') {
        throw invalidResponse(`${snake} is not an i64`);
    }
    return value;
}
function readInstalledSource(record) {
    const value = requireNumber(record, 'source', 'source');
    if (value === InstalledPluginSource.OFFICIAL || value === InstalledPluginSource.LOCAL)
        return value;
    throw invalidResponse('Plugin source is invalid');
}
function pathSegment(value, label) {
    const normalized = value.trim();
    if (!normalized || normalized.includes('/') || normalized.includes('\\')) {
        throw new PluginSystemCloudTransportError('REQUEST_INVALID', `${label} is invalid`);
    }
    return encodeURIComponent(normalized);
}
function invalidResponse(detail) {
    return new PluginSystemCloudTransportError('RESPONSE_INVALID', detail);
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=registry-client.js.map