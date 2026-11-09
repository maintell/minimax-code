import { LocalCanvasService } from './local-canvas.service.js';
import { createMatrixCanvasImageTools, } from './image-tools.client.js';
function initializeCanvasService(options) {
    return new LocalCanvasService(options);
}
export function initializeRuntimeCanvas(options, sessionSystem) {
    const requiredOptions = {
        db: options.db,
        sessions: sessionSystem.repositories.sessions,
        assets: options.compatibility.sessionV2.canvasAssets,
        imageTools: createMatrixCanvasImageTools({
            createClient: options.compatibility.canvas.createMatrixClient,
        }),
    };
    return options.nowMs
        ? initializeCanvasService({ ...requiredOptions, nowMs: options.nowMs })
        : initializeCanvasService(requiredOptions);
}
//# sourceMappingURL=initialize.js.map