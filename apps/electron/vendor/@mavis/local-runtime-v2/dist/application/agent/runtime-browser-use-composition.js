import { parseRequestMediaConfig } from '@mavis/config';
import { initializeBrowserUseService, } from '../../service/browser-use/index.js';
export function ownsElectronRuntimeCapabilities(runtimeOwnerKind) {
    return runtimeOwnerKind === undefined || runtimeOwnerKind === 'electron';
}
export function createRuntimeBrowserUseComposition(options) {
    const service = initializeBrowserUseService({
        ...(options.browserUse?.adapter ? { adapter: options.browserUse.adapter } : {}),
        ...(options.browserUse?.toolExposure ? { toolExposure: options.browserUse.toolExposure } : {}),
        readConfig: () => {
            const beta = options.compatibility.agentHost.preparation.configBuilder.config().beta;
            return {
                ...(beta?.filePanelBrowser === undefined
                    ? {}
                    : { filePanelBrowserEnabled: beta.filePanelBrowser }),
                ...(beta?.browserUseTooling === undefined
                    ? {}
                    : { browserUseToolingEnabled: beta.browserUseTooling }),
            };
        },
        getImageEncoding: () => {
            let requestMedia;
            try {
                requestMedia =
                    options.compatibility.agentHost.preparation.configBuilder.config().requestMedia;
            }
            catch {
                requestMedia = undefined;
            }
            const { image } = parseRequestMediaConfig(requestMedia);
            return {
                maxWidth: image.max_width,
                maxHeight: image.max_height,
                maxBase64Bytes: image.max_base64_bytes,
            };
        },
        registerGeneratedAsset: options.compatibility.generatedAssets.registerGeneratedAsset,
        activationMode: ownsElectronRuntimeCapabilities(options.runtimeOwnerKind)
            ? 'desktop-plugin'
            : 'explicit-config',
    });
    options.compatibility.questionnaires.bindRequestAdmission((input) => service.admitQuestionnaireRequest(input));
    return {
        service,
        close() {
            service.close();
        },
    };
}
//# sourceMappingURL=runtime-browser-use-composition.js.map