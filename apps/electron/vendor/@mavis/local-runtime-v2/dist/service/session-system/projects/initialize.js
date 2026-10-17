import { ProjectService } from './service.js';
export function initializeProjectDomain(options) {
    return {
        repository: options.repository,
        service: new ProjectService({
            projects: options.repository,
            sessions: options.sessions,
            nowMs: options.nowMs,
        }),
    };
}
//# sourceMappingURL=initialize.js.map