import { createLocalMavisCronAdapter, } from '@mavis/agent-tools/desktop';
import { createDesktopServiceClient } from '@mavis/thrift-gen/generated/desktop-service/client';
class CronUnavailableError extends Error {
    code = 'CRON_UNAVAILABLE';
    constructor() {
        super('Cron is not available on this runtime host');
        this.name = 'CronUnavailableError';
    }
}
/** Stable Agent-cleanup callback passed to v1 before Cron v2 is ready. */
export function createV1CronAgentCleanupBridge() {
    let service;
    return {
        async deleteAgentCronTasks(agentName) {
            if (!service)
                throw new CronUnavailableError();
            service.deleteDefinitionsByAgent(agentName);
        },
        bind(next) {
            if (service)
                throw new Error('Cron Agent cleanup is already bound');
            service = next;
        },
    };
}
/** Stable adapter passed to v1 before the v2 HTTP handler exists. */
export function createV1MavisCronAdapterBridge() {
    let handleRequest;
    let reminders;
    const adapter = createLocalMavisCronAdapter(createDesktopServiceClient({
        baseUrl: 'http://local-runtime-v2.internal',
        fetch: (input, init) => {
            if (!handleRequest)
                throw new CronUnavailableError();
            return handleRequest(new Request(input, init));
        },
    }));
    return {
        adapter: {
            ...adapter,
            setSelfReminder: (request) => {
                if (!reminders)
                    throw new CronUnavailableError();
                return reminders.set(request);
            },
            cancelSelfReminder: (request) => {
                if (!reminders)
                    throw new CronUnavailableError();
                return reminders.cancel(request.sessionId);
            },
        },
        bindSelfReminders(service) {
            reminders = service.selfReminders;
        },
        bindHandleRequest(next) {
            if (handleRequest)
                throw new Error('Cron handler is already bound');
            handleRequest = next;
        },
    };
}
//# sourceMappingURL=cron.js.map