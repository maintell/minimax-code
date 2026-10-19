import { createSessionCronQuery } from './query/cron-query.js';
import { SessionQueryService } from './query/query-service.js';
export function initializeSessionDomain(options) {
    return {
        repository: options.repository,
        query: new SessionQueryService(options.repository, options.discovery),
        cronQuery: createSessionCronQuery(options.repository),
    };
}
//# sourceMappingURL=initialize.js.map