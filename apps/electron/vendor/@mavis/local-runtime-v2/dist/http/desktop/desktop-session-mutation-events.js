import { logger } from '../../infra/logging/logger.js';
export function createSessionMutationEventPublisher(publish, options = {}) {
    const pinnedUpdated = (input) => {
        publish({
            type: 'session.pinned_updated',
            payload: {
                sessionId: input.sessionId,
                pinned: input.pinned,
                ...(input.agentName === undefined ? {} : { agentName: input.agentName }),
            },
        });
    };
    if (options.publishLifecycleEvents === false)
        return { pinnedUpdated };
    return {
        titleUpdated: (input) => {
            publish({
                type: 'session.title_updated',
                payload: {
                    sessionId: input.sessionId,
                    title: input.title,
                    ...(input.agentName === undefined ? {} : { agentName: input.agentName }),
                },
            });
        },
        pinnedUpdated,
        deleted: (input) => {
            publish({
                type: 'session.deleted',
                payload: {
                    sessionId: input.sessionId,
                    ...(input.agentName === undefined ? {} : { agentName: input.agentName }),
                },
            });
        },
    };
}
function safeSessionMutationError(error) {
    return { name: error instanceof Error ? error.name : 'UnknownError' };
}
/**
 * Logs and counts DesktopService session writes and their follow-up product
 * event. A failed event publication never fails the committed mutation.
 */
export class SessionMutationTelemetry {
    events;
    metricsClient;
    constructor(events, metricsClient) {
        this.events = events;
        this.metricsClient = metricsClient;
    }
    async run(operation, sessionId, eventType, run) {
        const startedAt = Date.now();
        try {
            const result = await run(startedAt);
            if (eventType === undefined && this.events) {
                logger.info({
                    component: 'desktop_session_mutation',
                    operation,
                    session_id: sessionId,
                    status: 'ok',
                    event_type: 'none',
                    event_status: 'skipped',
                    duration_ms: Date.now() - startedAt,
                    reason: 'no_title',
                }, 'desktop session mutation committed without an event');
                this.metricsClient?.counter('session_mutation_event_total', 1, {
                    operation,
                    status: 'skipped',
                });
            }
            return result;
        }
        catch (error) {
            logger.warn({
                component: 'desktop_session_mutation',
                operation,
                session_id: sessionId,
                status: 'error',
                event_type: eventType ?? 'none',
                event_status: 'not_emitted',
                duration_ms: Date.now() - startedAt,
                error_code: 'SESSION_MUTATION_FAILED',
                err: safeSessionMutationError(error),
            }, 'desktop session mutation failed before event publication');
            this.metricsClient?.counter('session_mutation_event_total', 1, {
                operation,
                status: 'mutation_failed',
            });
            throw error;
        }
    }
    publish({ operation, sessionId, eventType, }, mutationStartedAt, publish) {
        if (!this.events)
            return;
        try {
            publish();
            this.metricsClient?.counter('session_mutation_event_total', 1, {
                operation,
                status: 'emitted',
            });
            logger.info({
                component: 'desktop_session_mutation',
                operation,
                session_id: sessionId,
                status: 'ok',
                event_type: eventType,
                event_status: 'emitted',
                duration_ms: Date.now() - mutationStartedAt,
            }, 'desktop session mutation event emitted');
        }
        catch (error) {
            this.metricsClient?.counter('session_mutation_event_total', 1, {
                operation,
                status: 'emit_failed',
            });
            logger.warn({
                component: 'desktop_session_mutation',
                operation,
                session_id: sessionId,
                status: 'ok',
                event_type: eventType,
                event_status: 'emit_failed',
                duration_ms: Date.now() - mutationStartedAt,
                error_code: 'SESSION_MUTATION_EVENT_EMIT_FAILED',
                err: safeSessionMutationError(error),
            }, 'desktop session mutation committed but event publication failed');
        }
    }
}
//# sourceMappingURL=desktop-session-mutation-events.js.map