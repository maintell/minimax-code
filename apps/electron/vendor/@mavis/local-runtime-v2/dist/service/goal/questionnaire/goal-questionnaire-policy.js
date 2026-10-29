import { GoalQuestionnaireAutoReplyTimer } from './auto-reply-timer.js';
import { autoReplyGoalQuestionnaire } from './goal-questionnaire-auto-reply.js';
/**
 * A Goal questionnaire answers itself with its recommended options after this long.
 *
 * @internal Exported only for focused tests.
 */
export const GOAL_QUESTIONNAIRE_AUTO_REPLY_MS = 5 * 60 * 1000;
/**
 * The Goal's policy for questionnaires asked during Goal work. The shared
 * questionnaire capability persists, validates, delivers and injects; this
 * policy decides which asks belong to the Goal, whether a reply is still for
 * the current Goal, when an unanswered ask answers itself, whether a
 * questionnaire blocks the next Goal Turn, and when a Goal's ask retires.
 */
export class GoalQuestionnairePolicy {
    deps;
    timers;
    constructor(deps) {
        this.deps = deps;
        this.timers = new GoalQuestionnaireAutoReplyTimer({
            nowMs: deps.nowMs,
            run: (requestId) => this.autoReply(requestId),
            retryDelayMs: 1_000,
        });
    }
    /** What the shared questionnaire capability asks the Goal owner. */
    workOwner() {
        return {
            claim: (input) => this.claim(input),
            admitReply: (record) => this.admitReply(record),
            acceptsAutomaticAnswer: (record) => record.request.goalId !== undefined &&
                this.deps.isActiveGoal(record.sessionId, record.request.goalId),
            autoReplies: this.timers,
        };
    }
    /**
     * Goal continuation guard. A questionnaire for the expected Goal owns the
     * next turn; a questionnaire from a replaced Goal is atomically retired so
     * it cannot block the replacement Goal. If a paused Goal resumes after its
     * timer fired, the overdue questionnaire is settled here and this kickoff is
     * still deferred so the questionnaire reply remains the sole next turn.
     */
    async blocksContinuation(sessionId, expectedGoalId) {
        const currentGoal = await this.deps.readGoal(sessionId);
        if (!currentGoal || currentGoal.goalId !== expectedGoalId || currentGoal.status !== 'active') {
            // The caller raced a Goal mutation. Fail closed without touching the
            // replacement Goal's questionnaire; a fresh event/queue pass will use
            // the persisted Goal identity.
            return true;
        }
        const questionnaires = this.deps.questionnaires();
        const record = await questionnaires.findLatestBySession(sessionId);
        if (!record)
            return false;
        if (record.status === 'answered') {
            return this.resumeSavedAnswer(record, expectedGoalId, questionnaires);
        }
        if (record.status !== 'pending')
            return false;
        return this.pendingBlocksContinuation(record, expectedGoalId, questionnaires);
    }
    /**
     * Kick-time settlement. A timer that fires while the Goal is paused only
     * cancels itself, and the Queue defers the resumed Goal's continuation
     * behind any pending questionnaire before the Goal's own gate can settle
     * it. So when an active Goal is kicked, its overdue ask answers itself here
     * and that answer is the next Turn. Any other questionnaire state is left
     * to the Queue.
     */
    async settleOverdue(sessionId, goalId) {
        const questionnaires = this.deps.questionnaires();
        const record = await questionnaires.findLatestBySession(sessionId);
        if (!record ||
            record.status !== 'pending' ||
            record.request.purpose !== 'goal' ||
            record.request.goalId !== goalId) {
            return false;
        }
        const expiresAt = record.request.expiresAt;
        if (expiresAt === undefined || expiresAt > this.deps.nowMs())
            return false;
        await this.autoReplyOrRetry(record, questionnaires);
        return true;
    }
    async retire(sessionId, goalId) {
        const currentGoal = await this.deps.readGoal(sessionId);
        if (currentGoal?.goalId === goalId && currentGoal.status !== 'complete') {
            // A delayed complete/delete event must not retire a questionnaire after
            // the same Goal has already been reopened.
            return false;
        }
        const questionnaires = this.deps.questionnaires();
        const record = await questionnaires.findLatestBySession(sessionId);
        if (!record ||
            record.request.purpose !== 'goal' ||
            record.request.goalId !== goalId ||
            record.injectedAt !== undefined) {
            return false;
        }
        this.timers.cancel(record.requestId);
        if (record.status !== 'pending')
            return true;
        await questionnaires.supersedeStale(record);
        return true;
    }
    /**
     * Recover Goal questionnaires left pending or answered-but-not-injected at
     * shutdown. An aborted `signal` (runtime close) starts no further recovery.
     */
    async recoverOnStartup(signal) {
        const questionnaires = this.deps.questionnaires();
        const now = this.deps.nowMs();
        const aborted = () => signal?.aborted === true;
        if (aborted())
            return { reinjected: 0 };
        for (const record of await questionnaires.findAllPendingForRecovery()) {
            if (aborted())
                return { reinjected: 0 };
            if (record.request.purpose === 'goal')
                await this.recoverPending(record, now, questionnaires);
        }
        if (aborted())
            return { reinjected: 0 };
        return { reinjected: await this.recoverSavedAnswers(questionnaires, aborted) };
    }
    async recoverSavedAnswers(questionnaires, aborted) {
        let reinjected = 0;
        for (const record of await questionnaires.findAnsweredPendingInject()) {
            if (aborted())
                return reinjected;
            if (!record.replyPayload || record.request.purpose !== 'goal')
                continue;
            if (await this.recoverSavedAnswer(record, questionnaires))
                reinjected += 1;
        }
        return reinjected;
    }
    /** Answer an expired Goal questionnaire, or retry its saved answer's injection. */
    autoReply(requestId, questionnaires = this.deps.questionnaires()) {
        return autoReplyGoalQuestionnaire(requestId, {
            questionnaires,
            readGoal: this.deps.readGoal,
            timers: this.timers,
            nowMs: this.deps.nowMs,
        });
    }
    close() {
        this.timers.close();
    }
    async claim(input) {
        const goal = await this.deps.readGoal(input.sessionId);
        if (goal?.status !== 'active')
            return undefined;
        const { goalId } = goal;
        return {
            stamp: {
                purpose: 'goal',
                goalId,
                ...(input.allowsAutoReply
                    ? { expiresAt: input.createdAt + GOAL_QUESTIONNAIRE_AUTO_REPLY_MS }
                    : {}),
            },
            stillOwns: () => this.deps.isActiveGoal(input.sessionId, goalId),
        };
    }
    /** A user may still answer a paused Goal's ask; a replaced or complete Goal's ask retires. */
    async admitReply(record) {
        const currentGoal = await this.deps.readGoal(record.sessionId);
        const current = record.request.goalId !== undefined &&
            currentGoal?.goalId === record.request.goalId &&
            currentGoal.status !== 'complete';
        if (current)
            return { current: true };
        return { current: false, ...(currentGoal ? { currentOwnerId: currentGoal.goalId } : {}) };
    }
    /** Any ordinary ask blocks; a replaced Goal's ask retires; an overdue ask answers itself. */
    async pendingBlocksContinuation(record, expectedGoalId, questionnaires) {
        if (record.request.purpose !== 'goal')
            return true;
        if (record.request.goalId !== expectedGoalId) {
            await questionnaires.supersedeStale(record, expectedGoalId);
            return false;
        }
        const expiresAt = record.request.expiresAt;
        if (expiresAt !== undefined && expiresAt <= this.deps.nowMs()) {
            await this.autoReplyOrRetry(record, questionnaires);
        }
        return true;
    }
    async resumeSavedAnswer(record, expectedGoalId, questionnaires) {
        if (record.request.purpose !== 'goal' ||
            record.request.goalId !== expectedGoalId ||
            record.injectedAt !== undefined ||
            !record.replyPayload) {
            return false;
        }
        await this.autoReplyOrRetry(record, questionnaires);
        return true;
    }
    async recoverPending(record, now, questionnaires) {
        if (!record.request.goalId) {
            await questionnaires.supersedeStale(record);
            return;
        }
        const goal = await this.deps.readGoal(record.sessionId);
        if (!goal || goal.goalId !== record.request.goalId || goal.status === 'complete') {
            await questionnaires.supersedeStale(record, goal?.goalId);
            return;
        }
        const expiresAt = record.request.expiresAt;
        if (expiresAt === undefined)
            return;
        if (expiresAt > now) {
            this.timers.schedule(record);
        }
        else if (goal.status === 'active') {
            await this.autoReplyOrRetry(record, questionnaires);
        }
        else {
            this.timers.cancel(record.requestId);
        }
    }
    async recoverSavedAnswer(record, questionnaires) {
        if ((await this.autoReplyOrRetry(record, questionnaires)) === 'retry')
            return false;
        const recovered = await questionnaires.get(record.requestId);
        return recovered?.injectedAt !== undefined;
    }
    async autoReplyOrRetry(record, questionnaires) {
        const result = await this.autoReply(record.requestId, questionnaires);
        if (result === 'retry')
            this.timers.scheduleRetry(record.requestId, record.sessionId);
        return result;
    }
}
//# sourceMappingURL=goal-questionnaire-policy.js.map