import { createSessionMiniAppLifecycle } from './miniapp-actions.js';
export function createHostSessionMiniAppLifecycle(input) {
    return createSessionMiniAppLifecycle(input.plugins, input.supervisor, input.sessions, {
        ...(input.surface ? { surface: input.surface } : {}),
        ...(input.memory ? { memory: input.memory } : {}),
        diagnostics: {
            record: (diagnostic) => input.logger.error({ ...diagnostic }, 'Mini App action failed internally'),
        },
    });
}
//# sourceMappingURL=miniapp-host.js.map