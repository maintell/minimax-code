import { parseRequestMediaConfig, resolveBrowserCompactInspect, resolveBrowserPtcAutoScreenshot, } from '@mavis/config';
import { initializeBrowserUseService, } from '../../service/browser-use/index.js';
/**
 * The Browser Use config snapshot of one read; `browser.compactInspect` is on unless turned off.
 * @internal
 */
export function readRuntimeBrowserUseConfig(config, env = process.env) {
    const beta = config.beta;
    return {
        ...(beta?.filePanelBrowser === undefined
            ? {}
            : { filePanelBrowserEnabled: beta.filePanelBrowser }),
        ...(beta?.browserUseTooling === undefined
            ? {}
            : { browserUseToolingEnabled: beta.browserUseTooling }),
        ptcPostActionScreenshot: resolveBrowserPtcAutoScreenshot({
            ptcAuto: config.browser?.screenshot?.ptcAuto,
        }),
        compactInspect: resolveBrowserCompactInspect(config.browser?.compactInspect, env),
    };
}
export function ownsElectronRuntimeCapabilities(runtimeOwnerKind) {
    return runtimeOwnerKind === undefined || runtimeOwnerKind === 'electron';
}
/** Cron and other scheduled owners also run in the headless app-server. */
export function ownsScheduledRuntimeCapabilities(runtimeOwnerKind) {
    return ownsElectronRuntimeCapabilities(runtimeOwnerKind) || runtimeOwnerKind === 'app-server';
}
export function createRuntimeBrowserUseComposition(options) {
    const service = initializeBrowserUseService({
        ...(options.browserUse?.adapter ? { adapter: options.browserUse.adapter } : {}),
        ...(options.browserUse?.toolExposure ? { toolExposure: options.browserUse.toolExposure } : {}),
        ...(options.metrics ? { metrics: options.metrics } : {}),
        readConfig: () => readRuntimeBrowserUseConfig(options.compatibility.agentHost.preparation.configBuilder.config()),
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