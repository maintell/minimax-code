import { createPromptKeyProvider } from './storage/prompt-crypto.js';
import { LocalPromptFileReader } from './storage/prompt-file-reader.js';
import { PromptConfigService } from './prompt-config.service.js';
import { EncryptedPromptStorage } from './storage/encrypted-prompt-storage.js';
import { loadManagedDesktopPromptRegistry, resolveBuiltinPromptAssetsDir, } from './managed-desktop-prompts.js';
import { readPromptConfigDesktopKey } from './desktop-key.js';
import { RuntimePromptConfigAuthProvider, } from './runtime/runtime-auth.js';
import { PromptConfigCloudClient, resolvePromptConfigCloudBaseUrl, } from './prompt-config-cloud-client.js';
function initializePromptConfig(options) {
    const reader = options.reader ?? new LocalPromptFileReader();
    const storage = new EncryptedPromptStorage({
        dataDir: options.dataDir,
        builtinAssetsDir: options.builtinAssetsDir,
    });
    const service = new PromptConfigService({
        auth: options.auth,
        client: options.client,
        keys: options.keyProvider ?? createPromptKeyProvider({ desktopKey: options.desktopKey }),
        storage,
        reader,
        allowedPaths: options.allowedPaths,
        nowMs: options.nowMs,
    });
    return { service, reader };
}
/** Assembles the Desktop-only auth, cloud, encrypted storage, and reader slice. */
export async function initializeManagedDesktopPromptConfig(options) {
    if (!options.enabled)
        return undefined;
    const auth = new RuntimePromptConfigAuthProvider({
        authContextGetter: options.authContextGetter,
        deploymentGetter: options.deploymentGetter,
    });
    const builtinAssetsDir = await resolveBuiltinPromptAssetsDir();
    const registry = await loadManagedDesktopPromptRegistry(builtinAssetsDir);
    const owner = initializePromptConfig({
        dataDir: options.dataDir,
        builtinAssetsDir,
        auth,
        client: new PromptConfigCloudClient({
            baseUrl: resolvePromptConfigCloudBaseUrl(),
            fetchImpl: options.fetchImpl,
            ...(options.appVersion ? { appVersion: options.appVersion } : {}),
            previewSecret: process.env.PREVIEW_SECRET,
            lane: process.env.MAVIS_PLUGIN_CLOUD_LANE,
        }),
        desktopKey: readPromptConfigDesktopKey(options.desktopKey),
        allowedPaths: registry.paths,
        ...(options.reader ? { reader: options.reader } : {}),
    });
    return { owner, auth, managedPaths: registry.paths };
}
//# sourceMappingURL=initialize.js.map