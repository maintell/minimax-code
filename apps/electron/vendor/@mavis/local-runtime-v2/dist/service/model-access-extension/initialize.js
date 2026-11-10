import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { ModelAccessPackageService } from './package-lifecycle.service.js';
/** @internal Exported for focused tests. */
export async function initializeModelAccessPackageService(options) {
    const service = new ModelAccessPackageService(options);
    await service.initialize();
    return service;
}
const API_SCAN_OWNER_KINDS = new Set(['electron', 'tui']);
/** Local API-key scanning is an interactive desktop/terminal capability on supported platforms. */
export function runtimeOwnerMayScanApiKeys(runtimeOwnerKind) {
    if (!runtimeOwnerKind || !API_SCAN_OWNER_KINDS.has(runtimeOwnerKind))
        return false;
    return (process.platform === 'darwin' || process.platform === 'linux' || process.platform === 'win32');
}
/** Stable namespace from the exact configured profile root, not a process/session identity. */
export async function initializeRuntimeModelAccess(dataDir, options = {}) {
    if (!path.isAbsolute(dataDir))
        throw new Error('model_access_profile_invalid');
    const root = await realpath(dataDir);
    const profileId = createHash('sha256').update(root).digest('hex');
    const platform = process.platform;
    if (platform !== 'darwin' && platform !== 'linux' && platform !== 'win32') {
        throw new Error('model_access_platform_unsupported');
    }
    return initializeModelAccessPackageService({
        root: path.join(root, 'model-access'),
        profileId,
        platform,
        apiScanEnabled: options.apiScanEnabled === true,
        ...(options.keepAliveOwned ? { keepAliveOwned: true } : {}),
        ...(options.officialDelivery ? { officialDelivery: options.officialDelivery } : {}),
        ...(options.executionMode ? { executionMode: options.executionMode } : {}),
        ...(options.hostVersion ? { hostVersion: options.hostVersion } : {}),
        // This owner persists its bindings itself; no external credential schema store exists.
        credentialSchemas: async () => [],
    });
}
//# sourceMappingURL=initialize.js.map