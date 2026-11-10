import { detach } from '../execution/detach.js';
import { buildThreadGoalContinuationMessage, threadGoalLegacyBudgetLimitClientRequestId, threadGoalRecoveryClientRequestId, isCurrentEpochThreadGoalContinuation, } from './kickoff.js';
/** Initial Thread Goal continuation staging owned exclusively by Session V2. */
export class LocalThreadGoalKickoffQueue {
    deps;
    recoveryConversation;
    constructor(deps) {
        this.deps = deps;
    }
    integrationDeps() {
        return {
            enqueueInitialContinuationTurn: async (goal, message, clientRequestId, internalPromptRead) => {
                const conversation = this.requireConversation();
                const existing = await conversation.ingress.findQueuedByClientRequestId(goal.sessionId, clientRequestId);
                if (existing) {
                    if (internalPromptRead) {
                        this.deps.getIntegration().discardInternalPromptRead(internalPromptRead);
                    }
                    return;
                }
                let registeredTurnId = internalPromptRead?.requestedTurnId;
                try {
                    const accepted = await conversation.ingress.submit({
                        sessionId: goal.sessionId,
                        source: 'thread-goal',
                        allowQueue: true,
                        ...(internalPromptRead ? { requestedTurnId: internalPromptRead.requestedTurnId } : {}),
                        message: {
                            ...message,
                            hideUserMessage: true,
                            displayContent: goal.objective,
                        },
                        clientRequestId,
                    });
                    if (internalPromptRead && accepted.turnId !== internalPromptRead.requestedTurnId) {
                        this.deps
                            .getIntegration()
                            .rebindInternalPromptRead(internalPromptRead, accepted.turnId);
                        registeredTurnId = accepted.turnId;
                    }
                }
                catch (error) {
                    if (internalPromptRead) {
                        this.deps.getIntegration().discardInternalPromptRead({
                            ...internalPromptRead,
                            requestedTurnId: registeredTurnId ?? internalPromptRead.requestedTurnId,
                        });
                    }
                    throw error;
                }
            },
            hasPendingInitialContinuation: async (sessionId, clientRequestId) => Boolean(await this.requireConversation().ingress.findQueuedByClientRequestId(sessionId, clientRequestId)),
            cancelInitialContinuation: async (sessionId, clientRequestId) => {
                const conversation = this.requireConversation();
                const staged = await conversation.ingress.findQueuedByClientRequestId(sessionId, clientRequestId);
                if (staged)
                    await conversation.ingress.cancelQueued(sessionId, staged.itemId);
            },
            requestQueueDispatch: (sessionId) => detach(this.dispatchReportingFailure(sessionId)),
        };
    }
    async dispatchReportingFailure(sessionId) {
        try {
            await this.dispatch(sessionId);
        }
        catch (err) {
            this.deps.reportFailure(sessionId, `thread_goal_queue_dispatch_failed:${formatUnknownError(err)}`);
        }
    }
    dispatch(sessionId) {
        return this.requireConversation().ingress.dispatchQueue(sessionId);
    }
    /**
     * Startup phase one: settle what the last process left behind. Submits
     * nothing and wakes no queue, so it can run before the v1 conversation and
     * questionnaire recovery are ready.
     */
    async recoverFacts() {
        try {
            const integration = this.deps.getIntegration();
            // Before any gated recovery. A verifier only exists inside the process
            // that dispatched it, so a `verification` wait that survived restart is
            // always stale — and nothing downstream would clear it: the epoch guard
            // needs a writer, and every take-over path can legitimately skip a Goal
            // (runtime disabled, permissions, dependencies, a session already
            // started, an existing queue entry). Running the cleanup after those
            // would leave exactly the skipped Goals showing "Verifying" forever.
            await this.clearStaleVerificationWaits(integration);
            await this.retireLegacyBudgetSummaries(integration);
        }
        catch (error) {
            this.deps.reportRecoveryFailure(formatUnknownError(error));
        }
    }
    /**
     * Startup phase two: resume Goal work. Every path here can submit a Goal
     * Turn and dispatch its Session queue, whose Goal questionnaire gate may
     * resume a saved answer through the v1 conversation; so this runs only after
     * the conversation is bound and questionnaire recovery has finished. Once
     * `signal` aborts (runtime close), no further scan or Goal submission starts.
     */
    async takeOver(conversation, signal) {
        const previousConversation = this.recoveryConversation;
        this.recoveryConversation = conversation ?? previousConversation;
        const aborted = () => signal?.aborted === true;
        try {
            if (aborted())
                return;
            const integration = this.deps.getIntegration();
            // Re-arm account-quota recovery before the gated scans below. A quota
            // whose reset passed while this process was down resumes its Goal here
            // (on a zero-delay timer), and the resumed Goal then flows through the
            // ordinary continuation path rather than needing its own recovery branch.
            await this.recoverUsageLimitedGoals(integration);
            if (aborted())
                return;
            const recoverable = await integration.store.listRecoverableKickoffs();
            if (aborted())
                return;
            await Promise.all(recoverable.map(async (goal) => {
                try {
                    await integration.recoverInitialContinuation(goal);
                }
                catch (error) {
                    this.deps.reportFailure(goal.sessionId, `thread_goal_kickoff_recovery_failed:${formatUnknownError(error)}`);
                }
            }));
            if (aborted())
                return;
            const continuationCandidates = await integration.store.listRecoverableActiveGoals();
            if (aborted())
                return;
            await Promise.all(continuationCandidates.map(async (goal) => {
                try {
                    await this.recoverActiveContinuation(conversation ?? this.requireConversation(), goal);
                }
                catch (error) {
                    this.deps.reportFailure(goal.sessionId, `thread_goal_continuation_recovery_failed:${formatUnknownError(error)}`);
                }
            }));
        }
        catch (error) {
            this.deps.reportRecoveryFailure(formatUnknownError(error));
        }
        finally {
            this.recoveryConversation = previousConversation;
        }
    }
    /**
     * A budget-summary item queued before the upgrade never runs: the budget
     * now wraps up inside the Goal Turn. Cancel it at startup, before any queue
     * is woken, instead of leaving it pending until its Session is next used.
     * Like the cleanup below, a failure is reported and recovery goes on.
     */
    async retireLegacyBudgetSummaries(integration) {
        const queue = this.deps.legacyQueueItems?.();
        if (!queue)
            return;
        try {
            for (const goal of await integration.store.listBudgetLimitedGoals()) {
                const item = await queue.findByClientRequestId(goal.sessionId, threadGoalLegacyBudgetLimitClientRequestId(goal));
                if (item?.status === 'queued')
                    await queue.cancel(goal.sessionId, item.itemId);
            }
        }
        catch (error) {
            this.deps.reportRecoveryFailure(`thread_goal_legacy_budget_summary_retirement_failed:${formatUnknownError(error)}`);
        }
    }
    /**
     * Cleanup is an independent correction, not a step of kickoff recovery: a
     * failure here must not stop the startup recovery that follows, so it
     * reports and returns instead of propagating.
     */
    async clearStaleVerificationWaits(integration) {
        try {
            await integration.clearStaleVerificationWaits();
        }
        catch (error) {
            this.deps.reportRecoveryFailure(`thread_goal_stale_verification_wait_cleanup_failed:${formatUnknownError(error)}`);
        }
    }
    /**
     * Re-arm automatic account-quota recovery from the durable Goal rows.
     *
     * Independent of the scans that follow for the same reason as the cleanup
     * above: a failure to schedule recovery must not prevent kickoff and
     * continuation recovery from running.
     */
    async recoverUsageLimitedGoals(integration) {
        try {
            await integration.recoverUsageLimitedGoals();
        }
        catch (error) {
            this.deps.reportRecoveryFailure(`thread_goal_usage_recovery_rearm_failed:${formatUnknownError(error)}`);
        }
    }
    async recoverActiveContinuation(conversation, goal) {
        const integration = this.deps.getIntegration();
        if (!(await integration.shouldRecoverActiveContinuation(goal)))
            return;
        const session = await conversation.query.getSession(goal.sessionId);
        if (!session || session.status === 'started')
            return;
        const queued = await conversation.ingress.listQueued(goal.sessionId);
        const clientRequestId = threadGoalRecoveryClientRequestId(goal);
        if (queued.some((item) => isCurrentEpochThreadGoalContinuation(item, goal)) ||
            (await conversation.ingress.findQueuedByClientRequestId(goal.sessionId, clientRequestId))) {
            // A continuation that survived restart is not submitted again, but its
            // queue is woken here: nothing woke it while startup recovery, which can
            // be what unblocks it, was still running.
            await conversation.ingress.dispatchQueue(goal.sessionId);
            return;
        }
        const prompt = await integration.prepareRecoveryPrompt(goal);
        await this.submitRecoveredPrompt(conversation, {
            sessionId: goal.sessionId,
            clientRequestId,
            message: {
                ...buildThreadGoalContinuationMessage(goal, prompt.content, 'active'),
                hideUserMessage: true,
            },
            internalPromptRead: prompt.internalPromptRead,
        });
        integration.recordPromptSubmitted(goal, prompt.kind);
    }
    async submitRecoveredPrompt(conversation, { sessionId, clientRequestId, message, internalPromptRead, }) {
        const integration = this.deps.getIntegration();
        try {
            const accepted = await conversation.ingress.submit({
                sessionId,
                source: 'thread-goal',
                allowQueue: true,
                ...(internalPromptRead ? { requestedTurnId: internalPromptRead.requestedTurnId } : {}),
                message,
                clientRequestId,
            });
            if (internalPromptRead && accepted.turnId !== internalPromptRead.requestedTurnId) {
                integration.rebindInternalPromptRead(internalPromptRead, accepted.turnId);
            }
        }
        catch (error) {
            if (internalPromptRead)
                integration.discardInternalPromptRead(internalPromptRead);
            throw error;
        }
    }
    requireConversation() {
        const conversation = this.recoveryConversation ?? this.deps.conversation;
        if (!conversation)
            throw new Error('Runtime Conversation is unavailable for Thread Goal');
        return conversation;
    }
}
function formatUnknownError(error) {
    return error instanceof Error ? error.message : String(error);
}
//# sourceMappingURL=kickoff-host.js.map