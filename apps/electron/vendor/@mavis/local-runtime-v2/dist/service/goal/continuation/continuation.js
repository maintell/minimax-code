import { isContinuationStatus, isVerificationInterruptedReason, } from '@mavis/goal';
import { buildThreadGoalContinuationMessage, threadGoalRearmClientRequestId } from './kickoff.js';
import { GoalInitialKickoffCoordinator } from './initial-kickoff.js';
import { ObjectiveSteeringTargetChangedError, objectiveUpdateSteeringKey, } from './objective-steering.js';
import { GoalContinuationRearm } from './continuation-rearm.js';
import { detach } from '../execution/detach.js';
import { GoalPromptCoordinator } from '../prompts/prompt-coordinator.js';
import { publishThreadGoalEvent } from '../observability/wiring.js';
import { prepareGoalPrompt, } from '../prompts/prompt.js';
const NO_KICK = { kind: 'none' };
const HANDED_OFF = { kind: 'handed_off' };
/** Owns Goal continuation scheduling, kickoff materialization, and objective steering. */
export class GoalContinuation {
    deps;
    rearm;
    initialKickoff;
    promptCoordinator;
    constructor(deps) {
        this.deps = deps;
        this.promptCoordinator = new GoalPromptCoordinator({
            nowMs: deps.runtime.nowMs,
            emitRuntimeEvent: deps.runtime.emitRuntimeEvent,
        });
        this.initialKickoff = new GoalInitialKickoffCoordinator({
            store: deps.store,
            hasActiveTurn: (goal) => {
                const timing = deps.turnTimingReader.getBySession(goal.sessionId);
                return (timing !== undefined &&
                    deps.turnContext.getBinding(timing.turnId)?.binding.goalId === goal.goalId);
            },
            preparePrompt: (goal) => this.preparePrompt(goal, 'kickoff'),
            external: deps.external,
        });
        this.rearm = new GoalContinuationRearm({
            store: deps.store,
            patchFacts: deps,
            refreshQueuedKickoff: (goal) => this.initialKickoff.refreshQueuedKickoff(goal),
            submitActiveContinuation: (input) => this.submitActiveContinuation(input, { rebuiltAfterEpochAdvance: true }),
        });
    }
    handleChanged(event) {
        detach(this.applyChange(event));
    }
    /**
     * Apply one observed Goal change and report what happened to the Goal's next
     * Turn. `handleChanged` is the fire-and-forget form; a resume awaits this so
     * its entry point can say whether the Goal started, waits or failed.
     */
    async applyChange(event) {
        if (!this.deps.runtime.isEnabled())
            return NO_KICK;
        const projectedEvent = this.projectTurnTiming(event);
        this.applyReminderAndRearm(projectedEvent);
        if (projectedEvent.type !== 'deleted' && projectedEvent.goal.status === 'paused') {
            detach(this.initialKickoff.retireAfterPause(projectedEvent.goal));
        }
        if (projectedEvent.type === 'updated' && projectedEvent.objectiveChanged === true) {
            return this.steerOrKickObjectiveUpdate(projectedEvent.goal, projectedEvent.userPatch === true);
        }
        publishThreadGoalEvent(this.deps.runtime.publishGlobalEvent, projectedEvent);
        if (projectedEvent.type === 'deleted' || projectedEvent.goal.status === 'complete') {
            this.retireFinishedGoal(projectedEvent);
            return NO_KICK;
        }
        if (projectedEvent.goal.status !== 'active') {
            this.promptCoordinator.clearRecovery(projectedEvent.goal.goalId);
        }
        return this.maybeKick(projectedEvent);
    }
    /**
     * Hand an `active` Goal that has nothing running for it its next Turn, at
     * its current epoch and without writing the Goal. A repeated resume of an
     * already running Goal lands here and folds onto the same epoch key.
     */
    kickCurrent(goal) {
        if (!this.deps.runtime.isEnabled())
            return Promise.resolve(NO_KICK);
        return this.maybeKick({ type: 'updated', goal });
    }
    /**
     * Resume the active-time clock for a Goal that is running again, and project
     * the live elapsed time into a just-paused Goal whose Turn has not been
     * accounted yet.
     */
    projectTurnTiming(event) {
        if (event.type === 'deleted')
            return event;
        const eventTiming = this.deps.turnTimingReader.getBySession(event.goal.sessionId);
        if (!eventTiming)
            return event;
        if (event.goal.status !== 'paused') {
            this.deps.timeAccounting.resume(eventTiming, event.goal);
            return event;
        }
        if (this.deps.turnContext.hasAccounting(eventTiming.turnId))
            return event;
        return { ...event, goal: this.deps.timeAccounting.project(event.goal, eventTiming) };
    }
    applyReminderAndRearm(event) {
        if (event.type === 'deleted') {
            this.promptCoordinator.clear(event.goalId);
            return;
        }
        if (event.type !== 'updated' || event.userPatch !== true)
            return;
        if (event.resumedFromReason !== undefined && event.goal.status === 'active') {
            // Every resumed stop re-reads the durable Goal before continuing; a
            // verification interrupted by the stop also gets its own note.
            this.promptCoordinator.armRecovery(event.goal.goalId);
            if (isVerificationInterruptedReason(event.resumedFromReason)) {
                this.promptCoordinator.armVerificationInterrupted(event.goal.goalId, event.resumedFromReason);
            }
        }
        this.rearm.armUserPatch(event.goal);
    }
    /** A deleted or completed Goal releases every owned resource and pending kickoff. */
    retireFinishedGoal(event) {
        const sessionId = event.type === 'deleted' ? event.sessionId : event.goal.sessionId;
        const goalId = event.type === 'deleted' ? event.goalId : event.goal.goalId;
        this.rearm.clear(sessionId);
        this.promptCoordinator.clear(goalId);
        this.deps.turnHistory.forget(goalId);
        if (event.type === 'deleted') {
            this.deps.timeAccounting.clearSession(sessionId);
            this.deps.runtime.abortVerification(sessionId, 'goal_deleted');
        }
        detach(this.reportingFailure(sessionId, 'thread_goal_questionnaire_retire_failed', () => this.deps.external.retireGoalQuestionnaire(sessionId, goalId)));
        if (event.type !== 'deleted' || event.kickoffCancelled !== true) {
            detach(this.reportingFailure(sessionId, 'thread_goal_kickoff_cancel_failed', () => this.initialKickoff.cancelByGoal(sessionId, goalId)));
        }
        if (event.type !== 'deleted') {
            detach(this.reportingFailure(sessionId, 'thread_goal_kickoff_consume_failed', () => this.initialKickoff.consume(event.goal)));
        }
    }
    async injectObjectiveUpdatedSteering(goal, userPatch = false) {
        if (!this.deps.runtime.isEnabled())
            return;
        await this.steerOrKickObjectiveUpdate(goal, userPatch);
    }
    async steerOrKickObjectiveUpdate(goal, userPatch) {
        const observedTurnId = this.deps.turnTimingReader.getBySession(goal.sessionId)?.turnId;
        this.promptCoordinator.armObjectiveUpdate(goal.goalId);
        this.deps.runtime.publishGlobalEvent({
            type: 'thread_goal.objective_updated_steering',
            payload: { sessionId: goal.sessionId, goalId: goal.goalId },
        });
        publishThreadGoalEvent(this.deps.runtime.publishGlobalEvent, { type: 'updated', goal });
        const steeredTurnId = await this.steerObjectiveUpdate(goal, observedTurnId);
        if (steeredTurnId !== undefined)
            return { kind: 'steered', turnId: steeredTurnId };
        return this.maybeKick({
            type: 'updated',
            goal,
            ...(userPatch ? { userPatch: true } : {}),
        });
    }
    /**
     * Steer the objective-updated prompt into the running Turn and return that
     * Turn's id; `undefined` means kick instead.
     */
    async steerObjectiveUpdate(goal, observedTurnId) {
        const steer = this.deps.external.steerContinuationTurn;
        if (!steer || !(await this.canSteerActiveTurn(goal)))
            return undefined;
        try {
            const prompt = await this.preparePrompt(goal, 'objective-updated');
            const steered = await steer({
                sessionId: goal.sessionId,
                message: buildThreadGoalContinuationMessage(goal, prompt.content, 'active'),
                idempotencyKey: objectiveUpdateSteeringKey(goal),
                ...(prompt.internalPromptRead ? { internalPromptRead: prompt.internalPromptRead } : {}),
                onAccepted: async ({ mode, turnId }) => {
                    if (mode !== 'steered' ||
                        turnChanged(observedTurnId, turnId) ||
                        (await this.hasKickBlocker(goal))) {
                        throw new ObjectiveSteeringTargetChangedError();
                    }
                },
            });
            if (steered.mode === 'activated' || turnChanged(observedTurnId, steered.turnId)) {
                throw new ObjectiveSteeringTargetChangedError();
            }
            this.promptCoordinator.clearObjectiveUpdate(goal.goalId);
            // The steered prompt rides a Turn whose binding this same PATCH has
            // already invalidated, so that Turn's settlement will stop at the
            // stale stage and never enqueue the next one. Re-arm here.
            this.rearm.armUserPatch(goal);
            return steered.turnId;
        }
        catch (error) {
            if (!(error instanceof ObjectiveSteeringTargetChangedError)) {
                this.deps.external.reportFailure(goal.sessionId, `thread_goal_objective_steering_failed:${this.deps.external.formatError(error)}`);
            }
            return undefined;
        }
    }
    /**
     * Steer only while a Turn is running or admitted. On an idle session a steer
     * would activate a new Turn that the objective steering then rejects,
     * binding and revoking a Turn before the kick starts the real one.
     */
    async canSteerActiveTurn(goal) {
        return (goal.status === 'active' &&
            goal.kickoffState === 'consumed' &&
            (this.deps.gates.isSessionBusy(goal.sessionId) ||
                this.deps.turnContext.hasBindingInSession(goal.sessionId)) &&
            !(await this.hasKickBlocker(goal)));
    }
    async reconcileInitial(goal, dispatch) {
        return this.initialKickoff.reconcile(goal, dispatch);
    }
    rollbackFailedCreation(goal) {
        return this.initialKickoff.rollbackFailedCreation(goal);
    }
    cancelInitial(goal) {
        return this.initialKickoff.cancel(goal);
    }
    requestQueueDispatch(sessionId) {
        this.deps.external.requestQueueDispatch(sessionId);
    }
    consumeDeliveredInitial(goal) {
        return this.initialKickoff.consumeDelivered(goal);
    }
    async enqueueActive(input) {
        // Snapshot before the submission starts: an explicit user Turn can reset the
        // breaker while the Goal read and prompt build are in flight, and the item
        // this call is about to hand over would then already be stale.
        const observed = this.rearm.observe(input.sessionId);
        const submitted = await this.submitActiveContinuation(input);
        if (submitted === 'unavailable')
            return;
        // This settlement scheduled the follow-up itself (or found nothing left to
        // schedule); a queued re-arm of that same generation would only duplicate it.
        this.rearm.clearScheduled(input.sessionId, observed);
    }
    /** Take responsibility for the follow-up an explicit user Turn's reset invalidated. */
    armExplicitResetRearm(goal) {
        this.rearm.armExplicitReset(goal);
    }
    /** Rebuild the follow-up an out-of-band epoch advance left the Goal without. */
    drainContinuationRearm(input) {
        return this.rearm.drain(input);
    }
    /**
     * Rebuild the next `active` continuation from durable state and hand it to
     * the Queue. Deliberately does not touch the re-arm marker: the drain path
     * claims the marker before it starts and must not delete an arm that a newer
     * epoch writer installed while this submission was in flight.
     */
    async submitActiveContinuation(input, options = {}) {
        const enqueue = this.deps.external.enqueuePostTurnContinuation;
        if (!enqueue)
            return 'unavailable';
        try {
            const goal = await this.deps.store().getBySession(input.sessionId);
            if (!goal || !isContinuationStatus(goal.status))
                return 'not-continuable';
            const prompt = await this.selectPrompt(goal);
            await enqueue({
                sessionId: input.sessionId,
                turnId: input.turnId,
                message: buildThreadGoalContinuationMessage(goal, prompt.content, 'active'),
                /*
                 * A rebuild carries the settling Turn's id, whose default follow-up key
                 * belongs to the epoch that was just invalidated. Key it by the epoch it
                 * is actually being rebuilt at, so the Queue cannot fold it onto the
                 * stale row while retries of this same rebuild stay idempotent.
                 */
                ...(options.rebuiltAfterEpochAdvance
                    ? { clientRequestId: threadGoalRearmClientRequestId(goal) }
                    : {}),
                ...(prompt.internalPromptRead ? { internalPromptRead: prompt.internalPromptRead } : {}),
            });
            this.recordPromptSubmitted(goal, prompt.kind);
            return 'submitted';
        }
        catch (error) {
            this.deps.external.reportFailure(input.sessionId, `thread_goal_continuation_enqueue_failed:${this.deps.external.formatError(error)}`);
            throw error;
        }
    }
    /**
     * Whether startup recovery should hand an `active` Goal a continuation.
     *
     * Deliberately blind to dependency gates: a recovered continuation that is
     * blocked is deferred by the Queue, which records the wait reason and starts
     * it once the blocker clears. Skipping it here would leave the Goal `active`
     * with nothing that ever runs it.
     */
    async shouldRecoverActive(goal) {
        return this.deps.runtime.isEnabled() && isContinuationStatus(goal.status);
    }
    /**
     * Give an `active` Goal its next Turn.
     *
     * Dependency gates are not consulted here on purpose. The continuation goes
     * to the Queue either way: an unblocked one is admitted at once, a blocked
     * one is deferred by the Queue's own gate check — which records the wait
     * reason the user sees and re-runs on every dependency release. Returning
     * early on a blocker, as this used to, left a resumed Goal `active` with no
     * Turn, no wait reason and nothing that would ever start it. The one
     * exception is this Goal's questionnaire that expired while it was paused:
     * it is answered here and the answer is the next Turn, as when it expires
     * during an active Goal.
     */
    async maybeKick(event) {
        if (!this.deps.runtime.isEnabled() || event.type === 'deleted')
            return NO_KICK;
        if (event.goal.status !== 'active')
            return NO_KICK;
        // Snapshot before any await: this kick only owns the debt that already
        // existed when it started, never one an epoch advance installs mid-flight.
        const observedRearm = this.rearm.observe(event.goal.sessionId);
        let goal;
        try {
            goal = await this.goalReadyToKick(event);
            if (goal && (await this.settleOverdueQuestionnaire(goal)))
                return HANDED_OFF;
        }
        catch (error) {
            this.deps.external.reportFailure(event.goal.sessionId, `thread_goal_continuation_start_failed:${this.deps.external.formatError(error)}`);
            return { kind: 'failed', error };
        }
        if (!goal)
            return HANDED_OFF;
        return this.startKick(goal, event, observedRearm);
    }
    async goalReadyToKick(event) {
        let goal = event.goal;
        const shouldRefreshQueuedKickoff = goal.kickoffState !== 'consumed' &&
            event.type === 'updated' &&
            event.userPatch === true &&
            !this.rearm.isArmed(goal.sessionId);
        if (shouldRefreshQueuedKickoff) {
            goal = await this.refreshQueuedKickoffForKick(goal);
            if (!goal)
                return undefined;
        }
        if (this.deps.gates.isSessionBusy(goal.sessionId))
            return undefined;
        if (goal.kickoffState !== 'consumed') {
            const kickoffState = await this.initialKickoff.reconcile(goal, true);
            if (kickoffState !== 'consumed')
                return undefined;
        }
        return goal;
    }
    /*
     * `maybeKick` is fire-and-forget, so a failed rewrite must not surface as an
     * unhandled rejection. The coordinator already reported it and still holds
     * the re-delivery responsibility, so the next reconcile re-enqueues the
     * original kickoff rather than inferring it was consumed.
     */
    async refreshQueuedKickoffForKick(goal) {
        let refreshed;
        try {
            refreshed = await this.initialKickoff.refreshQueuedKickoff(goal);
        }
        catch {
            return undefined;
        }
        if (!refreshed || refreshed.status !== 'active')
            return undefined;
        return refreshed.kickoffState === 'consumed' ? refreshed : undefined;
    }
    async hasKickBlocker(goal) {
        return ((await this.deps.gates.hasPendingQuestionnaire(goal.sessionId, goal.goalId)) ||
            (await this.deps.gates.hasPendingPermission(goal.sessionId)) ||
            (await this.deps.gates.hasRequiredBackgroundWork(goal.sessionId, goal.goalId)));
    }
    async startKick(goal, event, observedRearm) {
        try {
            const prompt = await this.selectPrompt(goal);
            const started = await this.deps.external.startContinuationTurn(goal.sessionId, buildThreadGoalContinuationMessage(goal, prompt.content, 'active'), event.type === 'created' ? goal.objective : undefined, prompt.internalPromptRead);
            if (started === 'already-active')
                return HANDED_OFF;
            // This kick is the follow-up for the debt observed above; a newer arm
            // belongs to a newer epoch and must survive.
            this.rearm.clearScheduled(goal.sessionId, observedRearm);
            this.recordPromptSubmitted(goal, prompt.kind);
            return { kind: 'submitted', ...(started ? { turnId: started.turnId } : {}) };
        }
        catch (error) {
            this.deps.external.reportFailure(goal.sessionId, `thread_goal_continuation_start_failed:${this.deps.external.formatError(error)}`);
            return { kind: 'failed', error };
        }
    }
    async selectPrompt(goal) {
        const kind = this.promptCoordinator.selectOverride(goal) ??
            (goal.noProgressStreak > 0 || goal.noToolStreak > 0 ? 'nudge' : 'continuation');
        const prepared = await this.preparePrompt(goal, kind);
        const notice = this.promptCoordinator.verificationInterruptedNotice(goal.goalId);
        return {
            ...prepared,
            ...(notice ? { content: [prepared.content, notice].join('\n\n') } : {}),
            kind,
        };
    }
    recordPromptSubmitted(goal, kind) {
        this.promptCoordinator.recordSubmitted(goal, kind);
    }
    preparePrompt(goal, kind) {
        const promptSnapshots = this.deps.promptSnapshots?.();
        const internalTurnPromptReads = this.deps.internalTurnPromptReads?.();
        return prepareGoalPrompt(goal, kind, {
            ...(promptSnapshots ? { promptSnapshots } : {}),
            ...(internalTurnPromptReads ? { internalTurnPromptReads } : {}),
        });
    }
    async selectPromptText(goal) {
        const prepared = await this.selectPrompt(goal);
        this.recordPromptSubmitted(goal, prepared.kind);
        if (prepared.internalPromptRead) {
            this.deps.internalTurnPromptReads?.()?.discard(prepared.internalPromptRead.requestedTurnId);
        }
        return prepared.content;
    }
    async settleOverdueQuestionnaire(goal) {
        const settle = this.deps.external.settleOverdueGoalQuestionnaire;
        return settle ? settle(goal.sessionId, goal.goalId) : false;
    }
    /** Detached retirement work reports its own failure instead of rejecting unhandled. */
    async reportingFailure(sessionId, code, work) {
        try {
            await work();
        }
        catch (error) {
            this.deps.external.reportFailure(sessionId, `${code}:${this.deps.external.formatError(error)}`);
        }
    }
}
function turnChanged(observedTurnId, turnId) {
    return observedTurnId !== undefined && turnId !== observedTurnId;
}
//# sourceMappingURL=continuation.js.map