import { createHttpTransport } from './http.js';
import { createStdioTransport } from './stdio.js';
export function createTransport(config, options) {
    switch (config.type) {
        case 'stdio':
            return createStdioTransport(config, { env: options?.env });
        case 'http':
        case 'sse':
            return createHttpTransport(config, {
                headers: options?.headers,
                fetchImpl: options?.fetchImpl,
            });
    }
}
//# sourceMappingURL=factory.js.map