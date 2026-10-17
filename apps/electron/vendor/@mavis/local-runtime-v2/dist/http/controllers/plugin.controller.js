// Scaffolded by @mavis/thrift-gen — this file is yours after generation; edit freely.
// Regeneration never overwrites an existing controller file.
import {} from '@mavis/thrift-gen/generated/desktop-service/types';
import { PluginControllerBase } from '../generated/plugin-controller-base.gen.js';
import { AppError, NotImplementedError } from '../errors.js';
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
};
export const pluginController = new PluginController();
async function mapPluginFacadeError(operation) {
    try {
        return await operation();
    }
    catch (error) {
        if (error instanceof PluginDesktopFacadeError) {
            if (error.code === 'PLUGIN_NOT_FOUND') {
                throw new AppError(404, error.code, 'Plugin not found');
            }
            if (error.code === 'PLUGIN_AUTH_REQUIRED') {
                throw new AppError(401, error.code, 'Login is required');
            }
            if (error.code === 'PLUGIN_AUTH_SYNC_TIMEOUT') {
                throw new AppError(503, error.code, 'Login state is still synchronizing');
            }
            throw new AppError(400, error.code, 'Invalid Plugin request');
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
function throwPluginSystemError(error) {
    const mapped = mapPluginSystemAppError(error.code);
    if (mapped)
        throw mapped;
    throw error;
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
    if (GITHUB_UPSTREAM_CODES.has(code))
        return new AppError(502, code, 'GitHub is unavailable');
    if (isGithubImportValidationCode(code)) {
        return new AppError(422, code, 'GitHub Plugin cannot be imported');
    }
    return undefined;
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