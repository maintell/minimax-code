import { createPluginExtensionAuthoringExtension, PluginExtensionAuthoringError, } from '@mavis/agent-extension';
import { ownsElectronRuntimeCapabilities } from '../agent/runtime-browser-use-composition.js';
import { ExtensionAuthoringError, } from '../../service/plugin-extension/index.js';
/**
 * The `extension` authoring tool, composed only on the local Desktop Runtime: preview activates
 * the extension in this Desktop's renderer, which only subscribes to the extension stream of its
 * local sessions (`useExtensionTransport`). An SSH session runs on the remote app-server, a TUI or
 * CLI session has no extension renderer, so those Runtimes do not offer the tool.
 */
export function composeSessionPluginExtensionAuthoring(runtimeOwnerKind, service) {
    if (!service || !ownsElectronRuntimeCapabilities(runtimeOwnerKind))
        return [];
    return [createPluginExtensionAuthoringExtension(createSessionPluginExtensionAuthoring(service))];
}
/** Agent `extension` tool → plugin extension service; maps service errors to stable tool codes. */
function createSessionPluginExtensionAuthoring(service) {
    const { authoring } = service;
    return {
        init: (input) => mapErrors(() => authoring.init(input)),
        preview: (input) => mapErrors(() => authoring.preview(input)),
        inspect: (input) => mapErrors(() => authoring.inspect(input)),
        withdraw: (input) => mapErrors(() => authoring.withdraw(input)),
        test: (input) => mapErrors(() => authoring.test(input)),
    };
}
async function mapErrors(action) {
    try {
        return await action();
    }
    catch (error) {
        if (error instanceof ExtensionAuthoringError) {
            throw new PluginExtensionAuthoringError(error.code, error.message);
        }
        throw error;
    }
}
//# sourceMappingURL=plugin-extension-authoring.js.map