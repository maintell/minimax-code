import { isCoordinatorAgent } from '@mavis/shared/agent-coordination';
import { settleInBackground } from '../../infra/async/settle.js';
import { AssignmentService } from './orchestration/assignment.service.js';
import { AssignmentReportService } from './orchestration/report.service.js';
import { AssignmentUpdateService } from './orchestration/update.service.js';
import { AssignmentActivityService } from './orchestration/activity.service.js';
import { AssignmentStateView } from './state/assignment-state-view.js';
import { findOwningTaskSessionId } from './orchestration/session-ancestry.js';
import { ClosedTaskBackgroundService } from './closed-task-background.service.js';
export function initializeAssignments(input, publishUpdate) {
    // Every assignment service sees only coordinator-owned work.
    const options = { ...input, events: coordinatorEvents(input) };
    let updates;
    let service;
    // Every task change refreshes its live status.
    const changed = (id) => {
        updates.mark(id);
    };
    const reports = new AssignmentReportService(options, changed);
    // `service` is built below; the callback only runs once a round is observed hanging.
    const activity = new AssignmentActivityService(options, changed, (close) => service.closeHung(close));
    // Bunny's materialized task state (spec 9.6), fed by the same projections `assignment.updated` carries.
    const stateView = new AssignmentStateView({
        sessions: options.sessions,
        tasks: options.tasks,
        status: (session, assignment) => service.status(session, assignment),
        nowMs: options.nowMs,
    });
    service = new AssignmentService(options, changed, activity, reports);
    updates = new AssignmentUpdateService({
        sessions: options.sessions,
        tasks: options.tasks,
        status: (session, assignment) => service.status(session, assignment),
        events: options.events,
        publish: (status) => {
            stateView.observe(status);
            publishUpdate(status);
        },
        logger: options.logger,
    });
    let releasing;
    const release = (id, run) => {
        releasing = (async () => {
            try {
                await run(id);
            }
            catch (error) {
                options.logger.warn({ error }, 'Assignment queue release failed');
            }
        })();
    };
    const unsubscribe = options.events.subscribe({
        next: (event) => {
            if (event.type === 'session.start')
                settleInBackground((async () => {
                    try {
                        await service.started(event.payload.sessionId, event.timestamp, event.payload.turnId);
                    }
                    catch (error) {
                        options.logger.warn({ error, sessionId: event.payload.sessionId }, 'Assignment resume failed');
                    }
                })());
            if (event.type === 'session.finish' ||
                event.type === 'session.error' ||
                event.type === 'session.abort')
                release(event.payload.sessionId, (id) => service.release(id));
            if (event.type === 'questionnaire.ask' && options.tasks.assignerOf(event.payload.sessionId))
                release(event.payload.sessionId, (id) => service.waiting(id));
            // A subagent waiting for approval blocks the task above it, which then gives up its slot.
            if (event.type === 'permission.ask')
                release(event.payload.sessionId, async (id) => {
                    const owner = await findOwningTaskSessionId(options, id);
                    if (owner)
                        await service.waiting(owner);
                });
        },
    });
    return {
        service,
        stateView,
        /** Where background results of a closed Bunny task go instead of its Session (6.1). */
        closedTaskBackground: new ClosedTaskBackgroundService(options),
        /**
         * Startup recovery, never readiness: submits work queued before the last
         * shutdown and redelivers reports the previous process left undelivered.
         */
        recover: async (signal) => {
            if (signal?.aborted)
                return;
            stateView.rebuild();
            await service.ready();
            if (signal?.aborted)
                return;
            await reports.ready();
        },
        close: async () => {
            unsubscribe();
            await Promise.all([
                activity.close(),
                reports.close(),
                updates.close(),
                service.close(),
                releasing,
            ]);
        },
    };
}
/** Approval and question events: a subagent's request belongs to the task above it. */
const REQUEST_EVENTS = new Set([
    'permission.ask',
    'permission.resolved',
    'questionnaire.ask',
    'questionnaire.dismiss',
    'questionnaire.superseded',
    // A v2 skip publishes only this (`dismissedAt` set); it moves held reports on.
    'questionnaire.state',
]);
/**
 * The events of coordinator-owned work, judged without a read: a coordinator
 * Agent's own Sessions (by the roster) and the Sessions holding a task (by the
 * task index). Approval and question events pass for every Session; their
 * handlers find the task in the index before they read the store.
 */
function coordinatorEvents(options) {
    const owned = (event) => {
        if (REQUEST_EVENTS.has(event.type))
            return true;
        const sessionId = Reflect.get(event.payload, 'sessionId');
        if (typeof sessionId !== 'string')
            return false;
        if (options.tasks.assignerOf(sessionId) !== undefined)
            return true;
        const agentName = Reflect.get(event.payload, 'agentName');
        return (typeof agentName === 'string' &&
            isCoordinatorAgent(options.coordinators.coordinationOf(agentName)));
    };
    return {
        subscribe: (subscriber) => options.events.subscribe({
            next: (event) => {
                if (owned(event))
                    subscriber.next(event);
            },
        }),
    };
}
//# sourceMappingURL=initialize.js.map