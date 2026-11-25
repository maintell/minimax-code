import { dispatchAttachments, unreadableDispatchAttachments, } from '../../../infra/conversation/dispatch-attachments.js';
import { missingTaskAttachments } from '../../coordinator-text/index.js';
import { EXECUTING_ASSIGNMENT_STATES, MAX_ACTIVE_ASSIGNMENTS, WAITING_ASSIGNMENT_STATES, } from '../contracts.js';
/**
 * User-wide admission of assigned tasks: how many of the user's slots are in
 * use across all task spaces, starting queued tasks (oldest first, whatever
 * their space) when a slot frees up, and recording a queued start that failed.
 *
 * Not synchronized. `AssignmentService` owns the only instance and calls it
 * only inside its `serialize()` lock, so every read-then-start runs under the
 * same lock as the writes that change the occupancy.
 */
export class AssignmentQueue {
    options;
    deps;
    /** Submitted starts whose turn may not be visible in the status facts yet. */
    admitted = new Set();
    /** Tasks whose turn ended, even if the status facts still report it active. */
    terminal = new Set();
    constructor(options, deps) {
        this.options = options;
        this.deps = deps;
    }
    /** Whether a new task, in any space, has to wait for a free slot. */
    async isFull() {
        return (await this.occupied()) >= MAX_ACTIVE_ASSIGNMENTS;
    }
    /** Place a task queued now takes among all waiting tasks, across spaces (1-based). */
    async position() {
        const waiting = await this.options.tasks.list({ archived: false, pendingStart: true });
        return waiting.filter(({ assignment }) => !assignment.completion).length + 1;
    }
    /** The task was closed: it no longer holds a slot. */
    closed(sessionId) {
        this.admitted.delete(sessionId);
    }
    /** The task's turn ended: it no longer holds a slot until it starts again. */
    ended(sessionId) {
        this.admitted.delete(sessionId);
        this.terminal.add(sessionId);
    }
    /** A real turn started in the task. */
    turnStarted(sessionId) {
        this.terminal.delete(sessionId);
    }
    /**
     * Starts the task's round carrying the files at `attachmentPaths` into its own Session.
     *
     * This takes paths rather than built attachments on purpose. `dispatchAttachments` is the
     * only thing that turns a path into an attachment, and it never emits an `assetId`:
     * registration reuses an asset whose id and path already resolve, and asset reads are
     * filtered by Session, so an inherited id would leave the task pointing at an asset it
     * cannot read. Taking paths makes that mistake impossible here rather than merely
     * discouraged.
     */
    async submit(session, content, caller, attachmentPaths = []) {
        this.admitted.add(session.sessionId);
        this.terminal.delete(session.sessionId);
        try {
            await this.options.conversation.ingress.submit({
                sessionId: session.sessionId,
                source: 'communication',
                allowQueue: true,
                message: {
                    content,
                    attachments: dispatchAttachments(attachmentPaths),
                    origin: await this.deps.origin(caller),
                },
            });
        }
        catch (error) {
            this.admitted.delete(session.sessionId);
            throw error;
        }
    }
    async startPending() {
        const queued = (await this.options.tasks.list({ archived: false, pendingStart: true }))
            .filter(({ assignment }) => assignment.pendingStart && !assignment.completion)
            .sort((a, b) => a.assignment.pendingStart.queuedAt - b.assignment.pendingStart.queuedAt);
        for (const session of queued) {
            try {
                await this.startQueued(session.sessionId);
            }
            catch (error) {
                try {
                    await this.failPending(session.sessionId, error);
                }
                catch (failure) {
                    this.options.logger.warn({ error: failure, sessionId: session.sessionId }, 'Assignment pending start failure could not be recorded');
                }
            }
        }
    }
    /**
     * A slot is held only by work that executes: a running turn or a submitted
     * message about to start. Waiting for the user, a failed or stopped turn and
     * a finished turn under review hold none. An admitted task counts until its
     * turn starts, since its state can still read the previous turn's result.
     * Every open task counts, whatever its space, including one whose space link
     * is gone.
     */
    async occupied() {
        let count = 0;
        for (const { sessionId, assignment } of await this.options.tasks.list({ archived: false })) {
            if (assignment.completion || assignment.pendingStart)
                continue;
            if (await this.holdsSlot(sessionId))
                count++;
        }
        return count;
    }
    async holdsSlot(sessionId) {
        const admitted = this.admitted.has(sessionId);
        if (!admitted && this.terminal.has(sessionId))
            return false;
        const session = await this.options.sessions.get(sessionId);
        if (!session || session.archived)
            return false;
        const { state } = await this.options.facts.status(session);
        return admitted
            ? !WAITING_ASSIGNMENT_STATES.has(state)
            : EXECUTING_ASSIGNMENT_STATES.has(state);
    }
    async startQueued(id) {
        const current = await this.options.sessions.get(id);
        const assignment = current && (await this.options.tasks.get(id));
        if (!current || current.archived || !assignment?.pendingStart || assignment.completion)
            return;
        if (await this.isFull())
            return;
        const spaceId = this.options.worklines.sessionSpace(id);
        const caller = await this.deps.require(assignment.assignerWasRoot
            ? await this.options.agents.currentRoot(assignment.assignerAgentName)
            : assignment.assignerSessionId);
        // The files were worked out at dispatch; one removed while the task waited is named in the
        // first message rather than silently dropped.
        const { content, attachments = [] } = assignment.pendingStart;
        const missing = await unreadableDispatchAttachments(attachments);
        await this.submit(current, content + missingTaskAttachments(missing), caller, attachments.filter((path) => !missing.includes(path)));
        await this.options.tasks.clearPendingStart(id, spaceId ? { spaceId } : {});
        this.deps.mark(id);
    }
    async failPending(id, error) {
        const assignment = (await this.options.sessions.get(id)) && (await this.options.tasks.get(id));
        if (!assignment?.pendingStart)
            return;
        const detail = error instanceof Error ? error.message : String(error);
        await this.options.tasks.clearPendingStart(id, { startFailed: true });
        await this.options.sessions.update(id, { status: 'error', errorMessage: detail });
        this.ended(id);
        this.deps.mark(id);
        this.deps.reportFailed?.({
            sessionId: id,
            turnId: '',
            key: `${id}:pending-start:${assignment.assignedAt}:failed`,
            detail,
        });
    }
}
//# sourceMappingURL=assignment-queue.js.map