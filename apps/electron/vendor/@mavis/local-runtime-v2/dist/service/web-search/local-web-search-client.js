import {} from '@mavis/agent-tools/desktop';
import { callMatrixTool, MATRIX_TOOL_PATHS, MATRIX_TOOL_TIMEOUTS, } from '@mavis/agent-tools/cloud';
import { LocalMatrixClient } from '../matrix/index.js';
/** @internal Exported only for focused tests. */
export const LOCAL_WEB_SEARCH_TIMEOUT_MS = MATRIX_TOOL_TIMEOUTS.web_search;
export class LocalWebSearchClient {
    client;
    constructor(options = {}) {
        this.client = new LocalMatrixClient(options);
    }
    search(ctx, input, signal) {
        return callMatrixTool({
            toolName: 'web_search',
            path: MATRIX_TOOL_PATHS.web_search,
            input,
            ctx,
            archonServer: this.client,
            ...(signal ? { signal } : {}),
        });
    }
}
//# sourceMappingURL=local-web-search-client.js.map