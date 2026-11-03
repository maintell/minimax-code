// Scaffolded by @mavis/thrift-gen — this file is yours after generation; edit freely.
// Regeneration never overwrites an existing controller file.
import {} from '@mavis/thrift-gen/generated/desktop-service/types';
import { PluginControllerBase } from '../generated/plugin-controller-base.gen.js';
import { AppError, NotImplementedError, toErrorBody } from '../errors.js';
import { PluginDesktopFacadeError, PluginSystemCloudTransportError, PluginSystemError, } from '../../service/plugin-system/index.js';
export class PluginController extends PluginControllerBase {
    pluginSystem;
    constructor(pluginSystem = unimplementedPluginSystem) {
        super();
        this.pluginSystem = pluginSystem;
    }
    async listMarketplacePlugins(ctx, req) {
        void ctx;
        return mapPluginFacadeError(() => this.pluginSystem.listMarketplacePlugins(req));
    }
    async getMarketplacePlugin(ctx, req) {
        void ctx;
        return mapPluginFacadeError(() => this.pluginSystem.getMarketplacePlugin(req));
    }
    async listInstalledPlugins(ctx, req) {
        void ctx;
        return mapPluginFacadeError(() => this.pluginSystem.listInstalledPlugins(req));
    }
    async listEnabledPlugins(ctx, req) {
        void ctx;
        return mapPluginFacadeError(() => this.pluginSystem.listEnabledPlugins(req));
    }
    async installPlugin(ctx, req) {
        void ctx;
        return mapPluginFacadeError(() => this.pluginSystem.installPlugin(req));
    }
    async uninstallPlugin(ctx, req) {
        void ctx;
        return mapPluginFacadeError(() => this.pluginSystem.uninstallPlugin(req));
    }
    async enablePlugin(ctx, req) {
        void ctx;
        return mapPluginFacadeError(() => this.pluginSystem.enablePlugin(req));
    }
    async disablePlugin(ctx, req) {
        void ctx;
        return mapPluginFacadeError(() => this.pluginSystem.disablePlugin(req));
    }
    async refreshPlugins(ctx, req) {
        void ctx;
        void req;
        await mapPluginFacadeError(() => this.pluginSystem.refresh());
        return { accepted: true };
    }
    async previewGithubPlugin(ctx, req) {
        return mapPluginFacadeError(() => this.pluginSystem.previewGithubPlugin(req, ctx.signal));
    }
    async importGithubPlugin(ctx, req) {
        void ctx;
        return mapPluginFacadeError(() => this.pluginSystem.importGithubPlugin(req));
    }
    async updatePlugin(ctx, req) {
        void ctx;
        return mapPluginFacadeError(() => this.pluginSystem.updatePlugin(req));
    }
    async listPluginMarketplaces(ctx, req) {
        void ctx;
        return mapPluginFacadeError(() => this.pluginSystem.listPluginMarketplaces(req));
    }
    async addPluginMarketplace(ctx, req) {
        void ctx;
        return mapPluginFacadeError(() => this.pluginSystem.addPluginMarketplace(req));
    }
    async refreshPluginMarketplaces(ctx, req) {
        void ctx;
        return mapPluginFacadeError(() => this.pluginSystem.refreshPluginMarketplaces(req));
    }
    async setPluginMarketplaceAutoUpdate(ctx, req) {
        void ctx;
        return mapPluginFacadeError(() => this.pluginSystem.setPluginMarketplaceAutoUpdate(req));
    }
    async removePluginMarketplace(ctx, req) {
        void ctx;
        return mapPluginFacadeError(() => this.pluginSystem.removePluginMarketplace(req));
    }
}
const unimplementedPluginSystem = {
    listMarketplacePlugins: () => Promise.reject(new NotImplementedError('listMarketplacePlugins')),
    getMarketplacePlugin: () => Promise.reject(new NotImplementedError('getMarketplacePlugin')),
    listInstalledPlugins: () => Promise.reject(new NotImplementedError('listInstalledPlugins')),
    listEnabledPlugins: () => Promise.reject(new NotImplementedError('listEnabledPlugins')),
    installPlugin: () => Promise.reject(new NotImplementedError('installPlugin')),
    uninstallPlugin: () => Promise.reject(new NotImplementedError('uninstallPlugin')),
    enablePlugin: () => Promise.reject(new NotImplementedError('enablePlugin')),
    disablePlugin: () => Promise.reject(new NotImplementedError('disablePlugin')),
    refresh: () => Promise.reject(new NotImplementedError('refreshPlugins')),
    previewGithubPlugin: () => Promise.reject(new NotImplementedError('previewGithubPlugin')),
    importGithubPlugin: () => Promise.reject(new NotImplementedError('importGithubPlugin')),
    updatePlugin: () => Promise.reject(new NotImplementedError('updatePlugin')),
    listPluginMarketplaces: () => Promise.reject(new NotImplementedError('listPluginMarketplaces')),
    addPluginMarketplace: () => Promise.reject(new NotImplementedError('addPluginMarketplace')),
    refreshPluginMarketplaces: () => Promise.reject(new NotImplementedError('refreshPluginMarketplaces')),
    setPluginMarketplaceAutoUpdate: () => Promise.reject(new NotImplementedError('setPluginMarketplaceAutoUpdate')),
    removePluginMarketplace: () => Promise.reject(new NotImplementedError('removePluginMarketplace')),
};
export const pluginController = new PluginController();
async function mapPluginFacadeError(operation) {
    try {
        return await operation();
    }
    catch (error) {
        if (error instanceof PluginDesktopFacadeError) {
            const mapped = FACADE_ERRORS.get(error.code);
            throw new AppError(mapped?.status ?? 400, error.code, mapped?.message ?? 'Invalid Plugin request');
        }
        if (error instanceof PluginSystemCloudTransportError) {
            if (error.code === 'AUTH_REQUIRED') {
                throw new AppError(401, error.code, 'Login is required');
            }
            if (error.code === 'REQUEST_INVALID') {
                throw new AppError(400, error.code, 'Invalid Plugin request');
            }
            throw new AppError(502, 'PLUGIN_CLOUD_UNAVAILABLE', 'Plugin Cloud service is unavailable');
        }
        if (!(error instanceof PluginSystemError))
            throw error;
        throwPluginSystemError(error);
    }
}
const FACADE_ERRORS = new Map([
    ['PLUGIN_NOT_FOUND', { status: 404, message: 'Plugin not found' }],
    ['PLUGIN_AUTH_REQUIRED', { status: 401, message: 'Login is required' }],
    ['PLUGIN_AUTH_SYNC_TIMEOUT', { status: 503, message: 'Login state is still synchronizing' }],
    [
        'PLUGIN_MARKETPLACE_UNAVAILABLE',
        { status: 503, message: 'Plugin marketplaces are unavailable' },
    ],
    ['PLUGIN_UPDATE_UNSUPPORTED', { status: 409, message: 'Plugin cannot be updated' }],
]);
/**
 * Keeps the standard error body and adds the domain `reasonCode` (for example
 * the Git failure class `AUTH_REQUIRED` or `TIMEOUT`) for UI hints.
 */
class PluginReasonError extends AppError {
    reasonCode;
    constructor(mapped, reasonCode) {
        super(mapped.status, mapped.key, mapped.message, mapped.retryable);
        this.reasonCode = reasonCode;
    }
    getResponse() {
        return new Response(JSON.stringify({ ...toErrorBody(this), reasonCode: this.reasonCode }), {
            status: this.status,
            headers: { 'Content-Type': 'application/json' },
        });
    }
}
function throwPluginSystemError(error) {
    const mapped = mapPluginSystemAppError(error.code);
    if (!mapped)
        throw error;
    throw error.reasonCode ? new PluginReasonError(mapped, error.reasonCode) : mapped;
}
function mapPluginSystemAppError(code) {
    if (code === 'DISPOSED') {
        return new AppError(503, 'PLUGIN_SYSTEM_UNAVAILABLE', 'Plugin system is unavailable');
    }
    if (code === 'PLUGIN_NOT_FOUND')
        return new AppError(404, code, 'Plugin not found');
    if (code === 'LOCAL_DELETE_UNSAFE') {
        return new AppError(409, code, 'Local Plugin package cannot be removed safely');
    }
    if (code === 'PLUGIN_ALREADY_EXISTS') {
        return new AppError(409, code, 'Plugin is already installed');
    }
    if (code === 'PLUGIN_IMPORT_UNAVAILABLE') {
        return new AppError(503, code, 'Git repository import is unavailable');
    }
    const mapped = PLUGIN_IDENTITY_ERRORS.get(code) ?? marketplaceError(code);
    if (mapped)
        return new AppError(mapped.status, code, mapped.message);
    if (GITHUB_UPSTREAM_CODES.has(code))
        return new AppError(502, code, 'GitHub is unavailable');
    if (isGithubImportValidationCode(code)) {
        return new AppError(422, code, 'GitHub Plugin cannot be imported');
    }
    return undefined;
}
const PLUGIN_IDENTITY_ERRORS = new Map([
    ['PLUGIN_ID_AMBIGUOUS', { status: 409, message: 'Plugin name matches several Plugins' }],
    ['PLUGIN_ID_INVALID', { status: 400, message: 'Invalid Plugin id' }],
    ['PLUGIN_UPDATE_UNSUPPORTED', { status: 409, message: 'Plugin cannot be updated' }],
    ['PLUGIN_NOT_ENABLED', { status: 409, message: 'Plugin is disabled' }],
    ['PLUGIN_SOURCE_MISSING', { status: 422, message: 'Plugin folder is missing' }],
    ['PLUGIN_LINK_INVALID', { status: 422, message: 'Plugin folder cannot be linked' }],
]);
const MARKETPLACE_CONFLICT_CODES = new Set([
    'PLUGIN_MARKETPLACE_NAME_RESERVED',
    'PLUGIN_MARKETPLACE_NAME_TAKEN',
    'PLUGIN_MARKETPLACE_ENTRY_UNAVAILABLE',
    'PLUGIN_MARKETPLACE_UPDATE_UNSUPPORTED',
    'PLUGIN_MARKETPLACE_UNINSTALL_FAILED',
]);
/**
 * Marketplace failures: an unreachable Git remote is 502, a missing
 * marketplace 404, a build without the feature 403, a reserved or taken name
 * and an entry or Plugin state that forbids the action 409, and a source or
 * catalog that cannot be used 422.
 */
function marketplaceError(code) {
    if (!code.startsWith('PLUGIN_MARKETPLACE_'))
        return undefined;
    if (code === 'PLUGIN_MARKETPLACE_UNREACHABLE') {
        return { status: 502, message: 'Plugin marketplace is unreachable' };
    }
    if (code === 'PLUGIN_MARKETPLACE_NOT_FOUND') {
        return { status: 404, message: 'Plugin marketplace not found' };
    }
    if (code === 'PLUGIN_MARKETPLACE_DISABLED') {
        return { status: 403, message: 'Plugin marketplaces are not available in this build' };
    }
    if (MARKETPLACE_CONFLICT_CODES.has(code)) {
        return { status: 409, message: 'Plugin marketplace action conflicts with its state' };
    }
    return { status: 422, message: 'Plugin marketplace cannot be used' };
}
const GITHUB_UPSTREAM_CODES = new Set([
    'GITHUB_UNAVAILABLE',
    'GITHUB_ARCHIVE_UNAVAILABLE',
    'GIT_REPOSITORY_UNAVAILABLE',
]);
const GITHUB_IMPORT_EXACT_VALIDATION_CODES = new Set([
    'GIT_REPOSITORY_URL_INVALID',
    'GIT_REPOSITORY_REF_NOT_FOUND',
    'GIT_REPOSITORY_SOURCE_INVALID',
    'LOCAL_IMPORT_UNSAFE',
    'PLUGIN_NO_SUPPORTED_CAPABILITY',
    'ABSOLUTE_PATH',
    'BACKSLASH_PATH',
    'CASE_COLLISION',
    'CONTROL_CHARACTER',
    'DUPLICATE_PATH',
    'HARDLINK_NOT_ALLOWED',
    'INVALID_PATH',
    'INVALID_SIZE',
    'NON_PORTABLE_PATH',
    'SEGMENT_TOO_LONG',
    'SIZE_MISMATCH',
    'SPECIAL_ENTRY_NOT_ALLOWED',
    'SYMLINK_NOT_ALLOWED',
    'TOO_MANY_ENTRIES',
    'TOO_MANY_FILES',
    'TOTAL_SIZE_LIMIT',
    'UNSUPPORTED_COMPRESSION',
    'VECTOR_CONTENT_MISSING',
    'WINDOWS_RESERVED_PATH',
]);
const GITHUB_IMPORT_VALIDATION_PREFIXES = [
    'GITHUB_',
    'MANIFEST_',
    'MCP_',
    'SKILL_',
    'PATH_',
    'FILE_',
    'PLUGIN_',
];
function isGithubImportValidationCode(code) {
    return (GITHUB_IMPORT_EXACT_VALIDATION_CODES.has(code) ||
        GITHUB_IMPORT_VALIDATION_PREFIXES.some((prefix) => code.startsWith(prefix)));
}
//# sourceMappingURL=plugin.controller.js.map