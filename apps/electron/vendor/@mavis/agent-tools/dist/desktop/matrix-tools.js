import { buildMatrixTools, } from '../cloud/matrix-tools/index.js';
import { DesktopMatrixClient, } from './matrix-client.js';
import { DesktopMatrixMediaClient } from './matrix-media-client.js';
export function buildDesktopMatrixRuntimeTools(options) {
    const executor = options.executor ??
        new DesktopMatrixClient({
            ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
            ...(options.accessToken ? { accessToken: options.accessToken } : {}),
            ...(options.authContext ? { authContext: options.authContext } : {}),
            ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        });
    const mediaClient = options.mediaClient ??
        new DesktopMatrixMediaClient(executor instanceof DesktopMatrixClient
            ? executor
            : new DesktopMatrixClient({
                ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
                ...(options.accessToken ? { accessToken: options.accessToken } : {}),
                ...(options.authContext ? { authContext: options.authContext } : {}),
                ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
            }));
    const workspaceScope = options.extraInputRoots?.length
        ? { workspaceRoot: options.workspaceRoot, extraInputRoots: options.extraInputRoots }
        : options.workspaceRoot;
    return buildMatrixTools(executor, mediaClient, workspaceScope, null, {
        ...(options.matrixLogger ? { matrixLogger: options.matrixLogger } : {}),
    });
}
//# sourceMappingURL=matrix-tools.js.map