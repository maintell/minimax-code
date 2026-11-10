import { initializePptPreview, } from '../../service/ppt-preview/index.js';
import { PptPreviewApplication } from './ppt-publication-application.js';
import { PptEditProposalApplication } from './ppt-edit-proposal-application.js';
import { createProductionModelTextCompletion } from '../../service/turn-system/index.js';
export function composePptApplication(options, preview, composition, nowMs) {
    return options.pptPreviewRenderHost
        ? {
            pptPreview: new PptPreviewApplication(preview, new PptEditProposalApplication({
                sessions: composition.sessionSystem.repositories.sessions,
                complete: createProductionModelTextCompletion({ agents: composition.product.agents, preparation: composition.preparation }, nowMs),
            })),
        }
        : {};
}
/**
 * PPT preview starts before prompts and drains with them; the caller's lifecycle
 * still owns closing the shared runtime resources exactly once.
 */
export function withPromptLifecycle(pptPreview, promptLifecycle) {
    return {
        ready: async () => {
            await pptPreview.ready();
            await promptLifecycle.ready();
        },
        close: async () => {
            try {
                await pptPreview.close();
            }
            finally {
                await promptLifecycle.close();
            }
        },
    };
}
export function initializeRuntimePptPreview(options, sessionSystem, nowMs) {
    return initializePptPreview({
        db: options.db,
        dataDir: options.dataDir,
        sessions: sessionSystem.repositories.sessions,
        assets: {
            list: async (sessionId) => (await sessionSystem.repositories.assets.listPage({ sessionId, limit: 100 })).assets,
        },
        renderHost: options.pptPreviewRenderHost,
        nowMs,
    });
}
//# sourceMappingURL=runtime-ppt-applications.js.map