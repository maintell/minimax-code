import { buildLocalMatrixRuntimeTools } from './local-matrix-tools.js';
export function buildLocalMatrixTurnTools(options) {
    try {
        return buildLocalMatrixRuntimeTools({
            workspaceRoot: options.workspaceRoot,
            ...(options.authContext ? { authContext: options.authContext } : {}),
            routingContextGetter: options.routingContextGetter,
            ...(options.matrixLogger ? { matrixLogger: options.matrixLogger } : {}),
        });
    }
    catch (err) {
        options.emitBusEvent('matrix.tools_injection_failed', {
            sessionId: options.sessionId,
            error: err instanceof Error ? err.message : String(err),
        });
        return [];
    }
}
//# sourceMappingURL=local-matrix-turn-tools.js.map