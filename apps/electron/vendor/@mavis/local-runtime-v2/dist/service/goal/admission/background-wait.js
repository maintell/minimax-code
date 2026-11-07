/**
 * Live details of a Goal's background wait (spec G2-07): which tasks it waits
 * for, how many of its tasks already ended, or that the task list could not be
 * read.
 *
 * Kept beside the durable wait on purpose. The persisted wait reason and its
 * `sinceMs` say *why* the Goal is parked; the task list is a fact of the task
 * store that the dependency gate re-reads on every evaluation. A change of the
 * list alone must reach clients without writing the Goal row, because that
 * write would either reset the wait timer or advance the admission epoch.
 * Background work does not survive a restart, so neither do these details: a
 * wait read back before the gate runs again simply carries none.
 */
export class GoalBackgroundWaits {
    reads = new Map();
    /** Record the gate's latest read; a Goal with nothing to wait for is forgotten. */
    record(goalId, read) {
        if (read.readable && read.waitedTasks.length === 0) {
            this.reads.delete(goalId);
            return;
        }
        const key = JSON.stringify(read);
        if (this.reads.get(goalId)?.key === key)
            return;
        this.reads.set(goalId, { read, key, published: false });
    }
    /**
     * True when a wait with this reason would carry details that changed since a
     * Goal snapshot last carried them. Details that do not apply to the reason
     * never ask for a republish.
     */
    hasUnpublishedChange(goalId, reason) {
        const recorded = this.reads.get(goalId);
        return (recorded !== undefined && !recorded.published && this.detailsFor(goalId, reason) !== undefined);
    }
    /** Attach the current details to a Goal snapshot whose wait they explain. */
    decorate(state) {
        const wait = state.executionWait;
        if (!wait)
            return state;
        const details = this.detailsFor(state.goalId, wait.reason);
        return details ? { ...state, executionWait: { ...wait, ...details } } : state;
    }
    /** Wrap a publisher so every published Goal snapshot carries the current details. */
    wrapPublisher(publish) {
        return (event) => {
            const wait = event.type === 'thread_goal.updated' ? event.payload.goal.executionWait : null;
            if (event.type !== 'thread_goal.updated' || !wait) {
                publish(event);
                return;
            }
            const goal = event.payload.goal;
            const details = this.detailsFor(goal.goalId, wait.reason);
            if (!details) {
                publish(event);
                return;
            }
            const recorded = this.reads.get(goal.goalId);
            if (recorded)
                recorded.published = true;
            publish({
                ...event,
                payload: {
                    ...event.payload,
                    goal: {
                        ...goal,
                        executionWait: {
                            ...wait,
                            ...(details.waitedTasks
                                ? { waitedTasks: details.waitedTasks.map((task) => ({ ...task })) }
                                : {}),
                            ...(details.finishedTaskCount !== undefined
                                ? { finishedTaskCount: details.finishedTaskCount }
                                : {}),
                            ...(details.backgroundTasksUnreadable ? { backgroundTasksUnreadable: true } : {}),
                        },
                    },
                },
            });
        };
    }
    /**
     * Details apply only to the wait they explain: the task list to a
     * `required_background` wait, the unreadable flag to `dependency_unavailable`.
     */
    detailsFor(goalId, reason) {
        const read = this.reads.get(goalId)?.read;
        if (!read)
            return undefined;
        if (reason === 'required_background' && read.readable) {
            return { waitedTasks: read.waitedTasks, finishedTaskCount: read.finishedTaskCount };
        }
        if (reason === 'dependency_unavailable' && !read.readable) {
            return { backgroundTasksUnreadable: true };
        }
        return undefined;
    }
}
//# sourceMappingURL=background-wait.js.map