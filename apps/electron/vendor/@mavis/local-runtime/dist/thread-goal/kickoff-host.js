import { buildThreadGoalContinuationMessage, readThreadGoalContinuationOrigin, threadGoalBudgetLimitClientRequestId, threadGoalRecoveryClientRequestId, } from './kickoff.js';
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
            requestQueueDispatch: (sessionId) => {
                void this.dispatch(sessionId).catch((err) => {
                    this.deps.reportFailure(sessionId, `thread_goal_queue_dispatch_failed:${formatUnknownError(err)}`);
                });
            },
        };
    }
    dispatch(sessionId) {
        return this.requireConversation().ingress.dispatchQueue(sessionId);
    }
    async recover(conversation) {
        const previousConversation = this.recoveryConversation;
        this.recoveryConversation = conversation ?? previousConversation;
        try {
            const integration = this.deps.getIntegration();
            // Before any gated recovery. A verifier only exists inside the process
            // that dispatched it, so a `verification` wait that survived restart is
            // always stale — and nothing downstream would clear it: the epoch guard
            // needs a writer, and every recovery path below can legitimately skip a
            // Goal (runtime disabled, permissions, dependencies, a session already
            // started, an existing queue entry). Running the cleanup after those
            // would leave exactly the skipped Goals showing "Verifying" forever.
            await this.clearStaleVerificationWaits(integration);
            const recoverable = await integration.store.listRecoverableKickoffs();
            await Promise.all(recoverable.map(async (goal) => {
                try {
                    await integration.recoverInitialContinuation(goal);
                }
                catch (error) {
                    this.deps.reportFailure(goal.sessionId, `thread_goal_kickoff_recovery_failed:${formatUnknownError(error)}`);
                }
            }));
            const continuationCandidates = await integration.store.listRecoverableActiveGoals();
            await Promise.all(continuationCandidates.map(async (goal) => {
                try {
                    await this.recoverActiveContinuation(conversation ?? this.requireConversation(), goal);
                }
                catch (error) {
                    this.deps.reportFailure(goal.sessionId, `thread_goal_continuation_recovery_failed:${formatUnknownError(error)}`);
                }
            }));
            const budgetLimitCandidates = await integration.store.listRecoverableBudgetLimitSummaries();
            await Promise.all(budgetLimitCandidates.map(async (goal) => {
                try {
                    await this.recoverBudgetLimitSummary(conversation ?? this.requireConversation(), goal);
                }
                catch (error) {
                    this.deps.reportFailure(goal.sessionId, `thread_goal_budget_limit_recovery_failed:${formatUnknownError(error)}`);
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
     * Cleanup is an independent correction, not a step of kickoff recovery: a
     * failure here must not stop the recovery scans that follow, so it reports
     * and returns instead of propagating.
     */
    async clearStaleVerificationWaits(integration) {
        try {
            await integration.clearStaleVerificationWaits();
        }
        catch (error) {
            this.deps.reportRecoveryFailure(`thread_goal_stale_verification_wait_cleanup_failed:${formatUnknownError(error)}`);
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
        if (queued.some((item) => {
            if (item.source !== 'thread-goal')
                return false;
            return readThreadGoalContinuationOrigin(item.message.origin)?.goalId === goal.goalId;
        })) {
            return;
        }
        const clientRequestId = threadGoalRecoveryClientRequestId(goal);
        if (await conversation.ingress.findQueuedByClientRequestId(goal.sessionId, clientRequestId)) {
            return;
        }
        const prompt = await integration.prepareRecoveryPrompt(goal);
        await this.submitRecoveredPrompt(conversation, goal.sessionId, clientRequestId, {
            ...buildThreadGoalContinuationMessage(goal, prompt.content, 'active'),
            hideUserMessage: true,
        }, prompt.internalPromptRead);
        integration.recordPromptSubmitted(goal, prompt.kind);
    }
    async recoverBudgetLimitSummary(conversation, goal) {
        const integration = this.deps.getIntegration();
        if (goal.status !== 'budget_limited')
            return;
        if (!(await conversation.query.getSession(goal.sessionId)))
            return;
        const clientRequestId = threadGoalBudgetLimitClientRequestId(goal);
        if (await conversation.ingress.findQueuedByClientRequestId(goal.sessionId, clientRequestId)) {
            return;
        }
        const prompt = await integration.preparePrompt(goal, 'budget-limit');
        await this.submitRecoveredPrompt(conversation, goal.sessionId, clientRequestId, {
            ...buildThreadGoalContinuationMessage(goal, prompt.content, 'budget-limit'),
            hideUserMessage: true,
        }, prompt.internalPromptRead);
    }
    async submitRecoveredPrompt(conversation, sessionId, clientRequestId, message, internalPromptRead) {
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