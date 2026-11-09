import {} from '@mavis/agent-tools/desktop';
import { callMatrixTool, MATRIX_TOOL_PATHS, MATRIX_TOOL_TIMEOUTS, } from '@mavis/agent-tools/cloud';
import { LocalMatrixClient } from '../matrix/index.js';
/** @internal Exported only for focused tests. */
export const LOCAL_WEB_SEARCH_TIMEOUT_MS = MATRIX_TOOL_TIMEOUTS.web_search;
export class LocalWebSearchClient {
    client;
    matrixLogger;
    constructor(options = {}) {
        const { matrixLogger, ...clientOptions } = options;
        this.client = new LocalMatrixClient(clientOptions);
        this.matrixLogger = matrixLogger;
    }
    search(ctx, input, signal) {
        return callMatrixTool({
            toolName: 'web_search',
            path: MATRIX_TOOL_PATHS.web_search,
            input,
            ctx: this.matrixLogger && !ctx.matrixLogger ? { ...ctx, matrixLogger: this.matrixLogger } : ctx,
            archonServer: this.client,
            ...(signal ? { signal } : {}),
        });
    }
}
//# sourceMappingURL=local-web-search-client.js.map