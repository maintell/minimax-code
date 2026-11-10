import { composeOfficialModelAccessDelivery, initializeRuntimeModelAccess, modelAccessClientKind, modelAccessCloudLaneGetter, runtimeOwnerMayScanApiKeys, } from '../../service/model-access-extension/index.js';
import { createLocalModelSystemConfigPort, migrateSubscriptionGroups, } from '../../service/model-system/index.js';
import { computePluginDirectoryDigest, materializeOfficialPluginArchive, PluginSystemCloudTransport, resolvePluginCloudBaseUrl, } from '../../service/plugin-system/index.js';
import { createDisabledModelAccessComposition, createModelAccessComposition, } from './runtime-services-lifecycle.js';
const directoryDigest = async (directory) => (await computePluginDirectoryDigest(directory)).contentDigest;
/** Opens the model access owner, or nothing when the build gate is off. */
export function openRuntimeModelAccess(options, compatibility) {
    if (options.modelAccessEnabled === false)
        return undefined;
    const deliveryOwner = !!modelAccessClientKind(options.runtimeOwnerKind);
    const scansApiKeys = runtimeOwnerMayScanApiKeys(options.runtimeOwnerKind);
    const appVersion = compatibility.plugin.appVersion;
    return initializeRuntimeModelAccess(options.dataDir, {
        // Delivery owners (Electron, CLI, TUI) enforce persisted official revocations before any
        // activation, and keep idle direct sign-ins renewed.
        ...(deliveryOwner
            ? { officialDelivery: { contentDigest: directoryDigest }, keepAliveOwned: true }
            : {}),
        apiScanEnabled: scansApiKeys,
        ...(appVersion ? { hostVersion: appVersion } : {}),
        ...(options.modelAccessExecutionMode || scansApiKeys
            ? { executionMode: options.modelAccessExecutionMode ?? 'subprocess' }
            : {}),
    });
}
/** Runtime composition of an opened owner (with official delivery), or the inert one. */
export async function composeRuntimeModelAccess(options, compatibility, modelAccess) {
    if (!modelAccess)
        return createDisabledModelAccessComposition();
    if (runtimeOwnerMayScanApiKeys(options.runtimeOwnerKind))
        await migrateSubscriptionGroups(modelAccess, createLocalModelSystemConfigPort(compatibility.agentHost.preparation.configBuilder.config));
    const pluginHost = compatibility.plugin;
    const lane = modelAccessCloudLaneGetter(pluginHost.routingContextGetter);
    return createModelAccessComposition(modelAccess, composeOfficialModelAccessDelivery({
        runtimeOwnerKind: options.runtimeOwnerKind,
        modelAccess,
        authContextGetter: pluginHost.authContextGetter,
        lane,
        // Same signed archon_biz transport and package contract as Plugins.
        transport: () => new PluginSystemCloudTransport({
            baseUrl: resolvePluginCloudBaseUrl(),
            fetchImpl: pluginHost.fetchImpl,
            authContextGetter: pluginHost.authContextGetter,
            ...(pluginHost.appVersion ? { appVersion: pluginHost.appVersion } : {}),
            ...(process.env.PREVIEW_SECRET ? { previewSecret: process.env.PREVIEW_SECRET } : {}),
            laneGetter: lane,
        }),
        archive: {
            materialize: (input) => materializeOfficialPluginArchive(input),
            contentDigest: directoryDigest,
        },
    }));
}
/** Official model access delivery re-checks on Desktop identity changes, before Plugins. */
export function withModelAccessAuth(access, notify) {
    return (authState) => {
        access.authContextChanged();
        return notify(authState);
    };
}
/** Closes every acquired owner in order, ignoring failures so the original error survives. */
export async function closeQuietly(closers) {
    for (const close of closers) {
        try {
            await close();
        }
        catch {
            /* Preserve the startup failure while releasing every acquired owner. */
        }
    }
}
//# sourceMappingURL=runtime-model-access.js.map