import { PptPreviewService } from './publication/publication.service.js';
import { PptPreviewTaskConnection } from './publication/task-connection.adapter.js';
export function initializePptPreview(options) {
    const connection = new PptPreviewTaskConnection(options.dataDir, (sessionId, request, origin) => service.execute(sessionId, request, origin));
    const service = new PptPreviewService({
        ...options,
        taskConnection: connection,
    });
    return service;
}
//# sourceMappingURL=initialize.js.map