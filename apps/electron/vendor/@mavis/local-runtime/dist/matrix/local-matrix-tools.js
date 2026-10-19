import { buildMatrixTools, } from '@mavis/agent-tools/cloud';
import { LocalMatrixClient } from './local-matrix-client.js';
import { LocalMatrixMediaClient } from './local-matrix-media-client.js';
export function buildLocalMatrixRuntimeTools(options) {
    const client = new LocalMatrixClient({
        ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
        ...(options.authContext ? { authContext: options.authContext } : {}),
        routingContextGetter: options.routingContextGetter,
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });
    const mediaClient = new LocalMatrixMediaClient(client);
    return buildMatrixTools(client, mediaClient, options.workspaceRoot, null, {
        ...(options.matrixLogger ? { matrixLogger: options.matrixLogger } : {}),
    });
}
export { LocalMatrixClient, toLocalGatewayPath, } from './local-matrix-client.js';
export { LocalMatrixMediaClient, MATRIX_INLINE_LIMIT_BYTES, MATRIX_MAX_UPLOAD_BYTES, guessMimeType, sanitizeFilename, } from './local-matrix-media-client.js';
//# sourceMappingURL=local-matrix-tools.js.map