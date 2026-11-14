import { findOwningTaskSessionId } from './session-ancestry.js';
/** Recomputes an assigned session's state whenever an event can change it, and publishes it. */
export class AssignmentUpdateService {
    options;
    dirty = new Set();
    unsubscribe;
    draining;
    resolving = new Set();
    closed = false;
    constructor(options) {
        this.options = options;
        this.unsubscribe = options.events.subscribe({
            next: (event) => {
                const sessionId = affectedSession(event);
                if (!sessionId)
                    return;
                this.mark(sessionId);
                if (event.type === 'permission.ask' || event.type === 'permission.resolved')
                    this.markOwningTask(sessionId);
            },
        });
    }
    async close() {
        this.closed = true;
        this.unsubscribe();
        this.dirty.clear();
        await Promise.all([this.draining, ...this.resolving]);
    }
    mark(sessionId) {
        if (this.closed)
            return;
        this.dirty.add(sessionId);
        this.draining ??= this.runDrain();
    }
    /**
     * A subagent's approval request changes the state of the task above it, which
     * counts the request; the subagent Session itself has no task to publish.
     */
    markOwningTask(sessionId) {
        const lookup = {};
        lookup.done = (async () => {
            // Registered before the first await, so close() always waits for this lookup.
            await Promise.resolve();
            try {
                const owner = await findOwningTaskSessionId(this.options, sessionId);
                if (owner && owner !== sessionId)
                    this.mark(owner);
            }
            catch (error) {
                this.options.logger.warn({ sessionId, error: error instanceof Error ? error.message : String(error) }, 'Assignment owner lookup failed');
            }
            finally {
                if (lookup.done)
                    this.resolving.delete(lookup.done);
            }
        })();
        this.resolving.add(lookup.done);
    }
    async runDrain() {
        try {
            await this.drain();
        }
        finally {
            this.draining = undefined;
            const pending = this.dirty.values().next().value;
            if (pending !== undefined)
                this.mark(pending);
        }
    }
    // An event that arrives while its session is being read marks it dirty again,
    // so the last published state always reflects the latest event.
    async drain() {
        await Promise.resolve();
        for (const sessionId of this.dirty) {
            this.dirty.delete(sessionId);
            if (this.closed)
                return;
            try {
                await this.publishOne(sessionId);
            }
            catch (error) {
                this.options.logger.warn({ sessionId, error: error instanceof Error ? error.message : String(error) }, 'Assignment update failed');
            }
        }
    }
    /** Publishes a live task's status unless it was archived or closed out meanwhile. */
    async publishOne(sessionId) {
        // A Session without a task, such as a subagent asking for approval, has nothing to publish.
        if (this.options.tasks.assignerOf(sessionId) === undefined)
            return;
        const session = await this.options.sessions.get(sessionId);
        const assignment = session && (await this.options.tasks.get(sessionId));
        if (!session || !assignment || session.archived)
            return;
        const status = await this.options.status(session, assignment);
        const current = await this.options.sessions.get(sessionId);
        if (this.closed || !current || current.archived)
            return;
        if (await this.options.tasks.get(sessionId))
            this.options.publish(status);
    }
}
const ASSIGNMENT_EVENTS = new Set([
    'session.start',
    'session.finish',
    'session.error',
    'session.abort',
    'session.queue.updated',
    'session.title_updated',
    'permission.ask',
    'permission.resolved',
    'questionnaire.ask',
    'questionnaire.dismiss',
    'questionnaire.superseded',
    // A v2 skip only publishes this; the task stops reading as waiting for an answer.
    'questionnaire.state',
]);
function affectedSession(event) {
    if (!ASSIGNMENT_EVENTS.has(event.type))
        return undefined;
    const id = Reflect.get(event.payload, 'sessionId');
    return typeof id === 'string' ? id : undefined;
}
//# sourceMappingURL=update.service.js.map