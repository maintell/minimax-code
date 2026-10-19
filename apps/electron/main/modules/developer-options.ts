import { isDev, isTest, isStaging, isInternalBuild, isInsideBuild } from "../config/env";
import { isDeveloperBuildEligible } from "../config/developer-build-policy";
import { getDesktopConfig, setDesktopConfig } from "../ipc/storage.ipc";
const listeners = new Set();
function readPersistedOptions() {
    const options = getDesktopConfig().developerOptions;
    return {
        enabled: options?.enabled !== false,
        autoOpenNativeDevTools: options?.autoOpenNativeDevTools === true,
    };
}
export function getDeveloperOptions() {
    // Unknown/production builds deliberately fail closed. `isInsideBuild` is
    // checked independently because inside builds are external-user packages.
    const available = isDeveloperBuildEligible({
        isDev: isDev,
        isTest: isTest,
        isStaging: isStaging,
        isInternalBuild: isInternalBuild,
        isInsideBuild: isInsideBuild,
    });
    let persisted;
    try {
        persisted = readPersistedOptions();
    }
    catch {
        return { available, enabled: false, autoOpenNativeDevTools: false };
    }
    return {
        available,
        enabled: available && persisted.enabled,
        autoOpenNativeDevTools: available ? persisted.autoOpenNativeDevTools : false,
    };
}
export function setDeveloperOptions(patch) {
    if ((patch.enabled !== undefined && typeof patch.enabled !== 'boolean') ||
        (patch.autoOpenNativeDevTools !== undefined &&
            typeof patch.autoOpenNativeDevTools !== 'boolean')) {
        return { success: false, state: getDeveloperOptions(), error: 'invalid_value' };
    }
    const current = getDeveloperOptions();
    if (!current.available) {
        return { success: false, state: current, error: 'unsupported_environment' };
    }
    try {
        const next = {
            enabled: patch.enabled ?? current.enabled,
            autoOpenNativeDevTools: patch.autoOpenNativeDevTools ?? current.autoOpenNativeDevTools,
        };
        setDesktopConfig({ developerOptions: next });
        const state = { available: true, ...next };
        if (state.enabled !== current.enabled ||
            state.autoOpenNativeDevTools !== current.autoOpenNativeDevTools) {
            for (const listener of listeners) {
                try {
                    listener(state);
                }
                catch {
                    // A stale renderer must not turn a successful preference write into
                    // a storage failure for the caller.
                }
            }
        }
        return { success: true, state };
    }
    catch {
        return { success: false, state: current, error: 'storage_unavailable' };
    }
}
export function onDeveloperOptionsChanged(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
}
