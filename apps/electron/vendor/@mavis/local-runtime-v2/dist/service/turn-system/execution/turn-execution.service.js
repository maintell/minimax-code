import { randomUUID } from 'node:crypto';
import { normalizeAbortSource } from '@mavis/agent-core/pi-turn-runner';
import { digestTurnInput } from './turn-input-identity.js';
import { isUserAuthoredSource } from './message-query-authorship.js';
/** Durable admission, in-process ownership, and AgentHost execution only. */
export function createTurnExecutionService(options) {
    const nowMs = options.nowMs ?? Date.now;
    const makeTurnId = options.makeTurnId ?? (() => `turn_${randomUUID()}`);
    const pending = new PendingSubmissions();
    const context = { options, nowMs, makeTurnId, pending };
    return {
        submit: async (input) => {
            const admission = options.controller.tryEnterAdmission();
            if (!admission)
                return runtimeDrainingRejection();
            try {
                if (input.clientIntent === 'cloud-handoff' && !isQueueSubmission(input)) {
                    return await submitInterruptingHandoff(context, input);
                }
                const result = await options.operations.tryRun(input.sessionId, () => submitTurn(context, input));
                return result.entered ? result.value : { accepted: false, reason: 'session-deleting' };
            }
            finally {
                admission.release();
            }
        },
        submitTrusted: async (input) => {
            const admission = options.controller.tryEnterAdmission();
            if (!admission)
                return runtimeDrainingRejection();
            try {
                return await submitTurn(context, input, {
                    bypassPriorityFence: true,
                    bypassSessionMutation: true,
                });
            }
            finally {
                admission.release();
            }
        },
        requestCompaction: async (input) => {
            const admission = options.controller.tryEnterAdmission();
            if (!admission)
                return runtimeDrainingRejection();
            try {
                const result = await options.operations.tryRun(input.sessionId, () => beginCompaction(options, input, nowMs, makeTurnId));
                if (!result.entered)
                    return { accepted: false, reason: 'session-deleting' };
                const handoff = result.value;
                if (!handoff.accepted)
                    return handoff;
                return {
                    accepted: true,
                    turnId: handoff.turnId,
                    outcome: await handoff.run(),
                };
            }
            finally {
                admission.release();
            }
        },
        steerActiveTurn: async (input) => {
            const result = await options.operations.tryRun(input.sessionId, () => options.controller.steerActiveTurn(input));
            return result.entered ? result.value : { status: 'closing' };
        },
        abort: async (input) => {
            const activeTurnId = options.controller.activeTurnId(input.sessionId);
            // One identity rule for everything a stop may touch: it targets the current
            // Turn when it names no Turn, nothing is running, or it names the running
            // one. A stop that names an older Turn is rejected by the controller as
            // `turn-mismatch` (HTTP 409) before any side effect, so it must not open a
            // window, pause the Goal or cascade either — otherwise it would kill the
            // background work of the newer Turn the user is actually looking at.
            const targetsCurrentTurn = !input.turnId || !activeTurnId || input.turnId === activeTurnId;
            if (targetsCurrentTurn)
                pending.stop(input);
            // From the identity read through controller.abort there must be no await: a
            // user stop acts on the Turn running when it arrives. The cascade opens its
            // delivery window synchronously; Session scope resolution stays in its handle.
            // The Goal is NOT paused here: only an accepted stop may do that (controller
            // `onAccepted`, or `not-running`).
            const cascade = targetsCurrentTurn
                ? beginUserStopCascade(options, input)
                : skipStaleUserStopCascade(options, input, activeTurnId);
            let result;
            try {
                result = await options.controller.abort(withUserStopAcceptance(options, input, cascade));
            }
            catch (error) {
                // `begin` already opened the Session's delivery window. Without a result
                // there is no cascade to run, but the window must still be released —
                // otherwise every later completion notice of this Session would be held
                // as `busy` for the life of the process, worse than having no cascade.
                // The stop request itself keeps failing exactly as it did before.
                releaseUserStopCascade(cascade, 'abort_failed');
                throw error;
            }
            if (result.status === 'turn-mismatch') {
                // Race: the check above saw no conflict, but a newer Turn took over before
                // the abort landed, so the controller rejected it. Same outcome as a
                // stale stop — release the window, cascade nothing, and never `accept`:
                // a rejected stop must leave the Goal exactly as it was.
                releaseUserStopCascade(cascade, 'turn_mismatch');
                return result;
            }
            if (result.status === 'not-running') {
                // Nothing was running, so the controller had no identity to check and
                // never ran `onAccepted` — the stop is accepted as is. The boundary is
                // fixed first: pausing the Goal awaits storage, and this path holds no
                // Session lock, so a new Turn can start and spawn work meanwhile. The
                // Goal must still be paused BEFORE the cascade stops tasks: a terminal
                // task wakes the queue, and a live Goal would otherwise start a new Turn.
                markUserStopBoundary(options, input, cascade, 'not_running');
                await acceptUserStopCascade(cascade, 'not_running');
            }
            // Detached on purpose: the cascade is a follow-up action and the stop
            // response must not wait for background teardown. `not-running` still
            // cascades: that is exactly the "Turn already finished but background work
            // is still running" case this feature exists for.
            cascade?.complete(result);
            return result;
        },
        activeTurnId: (sessionId) => options.controller.activeTurnId(sessionId),
    };
}
function runtimeDrainingRejection() {
    return {
        accepted: false,
        reason: 'policy:runtime:draining',
        queueDisposition: 'defer',
    };
}
/**
 * Starts the user-stop cascade for an explicit stop only.
 *
 * `session_leave` (TUI `/clear` and Session switching) deliberately does NOT
 * cascade: it pauses the old Session's Goal and Queue exactly like today, but
 * leaving a conversation must not kill the background build still running in it.
 */
function beginUserStopCascade(options, input) {
    if (!options.userStop)
        return undefined;
    if (normalizeAbortSource(input.reason) !== 'user_stop')
        return undefined;
    try {
        return options.userStop.begin(input.sessionId);
    }
    catch {
        // The stop itself is authoritative and must succeed even if the cascade
        // cannot start; this degrades to today's behaviour (no cascade).
        return undefined;
    }
}
/**
 * A stop naming an older Turn never cascades. Logged only when it WOULD have
 * cascaded (an explicit `user_stop` with the seam wired): that is the case worth
 * explaining later — e.g. a phone that still shows the previous Turn — while
 * every other stale abort stays as quiet as before.
 */
function skipStaleUserStopCascade(options, input, activeTurnId) {
    if (!options.userStop || normalizeAbortSource(input.reason) !== 'user_stop')
        return undefined;
    try {
        options.logger?.info({
            event: 'user_stop_cascade_skipped',
            session_id: input.sessionId,
            requested_turn_id: input.turnId,
            active_turn_id: activeTurnId,
            reason: 'stale_turn_id',
        }, 'User stop names an older Turn; not cascading');
    }
    catch {
        // Diagnostics must never change the outcome of a stop.
    }
    return undefined;
}
/**
 * Runs the cascade's accepted-stop side effects from inside the controller's own
 * `onAccepted`, i.e. only after its identity check passed. The caller's original
 * `onAccepted` (ConversationApplication's Goal pause) runs first and unchanged;
 * the cascade's pause is idempotent, so the overlap is harmless, and paths that
 * pass no `onAccepted` at all (IM `/stop`) now pause the Goal too.
 *
 * The cascade's target boundary is fixed from `onReleased`, at the stopped
 * Turn's release. The abort itself returns only after `onAccepted` (a Goal
 * pause that writes to storage), and the Turn may release — letting the next
 * Turn in — long before that; a boundary taken when the abort returns would
 * sweep that next Turn's background work into this stop.
 */
function withUserStopAcceptance(options, input, cascade) {
    if (!cascade)
        return input;
    return {
        ...input,
        onAccepted: async () => {
            await input.onAccepted?.();
            await acceptUserStopCascade(cascade, 'controller_accepted');
        },
        onReleased: () => {
            markUserStopBoundary(options, input, cascade, 'released');
            input.onReleased?.();
        },
    };
}
/** The port contract says `accept` never throws; guard anyway so a stop cannot fail on it. */
async function acceptUserStopCascade(cascade, how) {
    try {
        await cascade?.accept(how);
    }
    catch {
        // Swallowed on purpose: accepting is a best-effort side effect of the stop.
    }
}
/**
 * The port contract says `markBoundary` never throws; guard anyway, because it
 * also runs inside the controller's release of the stopped Turn. Without a mark
 * the cascade takes its boundary at `complete`, i.e. the behaviour before marks.
 */
function markUserStopBoundary(options, input, cascade, source) {
    try {
        cascade?.markBoundary(source);
    }
    catch (error) {
        try {
            options.logger?.info({
                event: 'user_stop_cascade_mark_boundary_failed',
                session_id: input.sessionId,
                boundary_source: source,
                error: error instanceof Error ? error.message : String(error),
            }, 'User stop could not fix its cascade boundary; the cascade takes it at completion');
        }
        catch {
            // Diagnostics must never change the outcome of a stop.
        }
    }
}
/**
 * Releases a cascade whose abort failed. The port contract says `cancel` never
 * throws; guarding anyway keeps a contract violation from replacing the abort's
 * own error, which the caller rethrows unchanged. The implementation logs.
 */
function releaseUserStopCascade(cascade, reason) {
    try {
        cascade?.cancel(reason);
    }
    catch {
        // Swallowed on purpose: the original abort failure is what must surface.
    }
}
/**
 * `TurnController` owns a Turn only from `register()` on, so an abort that lands while a
 * submission is still inside product preparation has nothing to stop and answers
 * `not-running`. Cloud handoff preparation scans the Workspace and asks the recommendation
 * model, which holds that window open for seconds — long enough for a user stop to be lost
 * while the prepared Turn starts afterwards. Submissions publish their identity here for
 * exactly that window.
 */
class PendingSubmissions {
    submissions = new Set();
    enroll(sessionId, turnId) {
        const submission = { sessionId, turnId, stopped: false };
        this.submissions.add(submission);
        return submission;
    }
    release(submission) {
        this.submissions.delete(submission);
    }
    /** An abort without a `turnId` stops whatever this Session is currently starting. */
    stop(input) {
        for (const submission of this.submissions) {
            if (submission.sessionId !== input.sessionId)
                continue;
            if (!input.turnId || input.turnId === submission.turnId) {
                submission.stopped = true;
                submission.onStop?.();
            }
        }
    }
}
class StoppedBeforeRegistrationError extends DOMException {
    constructor() {
        super('Turn stopped before execution', 'AbortError');
    }
}
function isAbortError(error) {
    return (typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError');
}
/** Only submissions enrolled before the abort observe it, so the next request still starts. */
const STOPPED_BEFORE_ADMISSION = {
    accepted: false,
    reason: 'policy:turn-abort:pre-admission',
    queueDisposition: 'cancel',
};
async function submitInterruptingHandoff(context, input) {
    const { options } = context;
    const lease = options.operations.tryAcquireExclusive(input.sessionId);
    if (!lease)
        return { accepted: false, reason: 'session-mutating' };
    const turnId = input.requestedTurnId ?? context.makeTurnId();
    const submission = context.pending.enroll(input.sessionId, turnId);
    let releaseNotification;
    const release = () => {
        if (releaseNotification)
            return;
        lease.release();
        // Wake is best effort and must not delay the response behind another queued
        // item's preparation, or turn an accepted handoff into a transport failure.
        releaseNotification = notifyInterruptSendReleased(options, input.sessionId);
    };
    submission.onStop = release;
    try {
        const unavailable = await sessionUnavailable(options, input.sessionId);
        if (unavailable)
            return unavailable;
        // Drain already-entered submissions before observing the controller. They may
        // still be registering a Turn; aborting before that would miss the new owner.
        const drained = await waitForHandoffDrain(lease.drained);
        if (submission.stopped)
            return STOPPED_BEFORE_ADMISSION;
        if (!drained) {
            return { accepted: false, reason: 'policy:cloud-handoff:interrupt-timeout' };
        }
        const replay = await handoffReplay(options.repository, input, turnId);
        if (replay)
            return replay;
        if (submission.stopped)
            return STOPPED_BEFORE_ADMISSION;
        const interruptFailure = await interruptForHandoff(options.controller, submission);
        if (submission.stopped)
            return STOPPED_BEFORE_ADMISSION;
        if (interruptFailure)
            return interruptFailure;
        // Only this exclusive owner may overtake the ordinary queue. Product admission
        // and persistent session-mutation checks still run, AFTER the old Turn stops.
        return await submitTurn(context, { ...input, requestedTurnId: turnId }, { bypassPriorityFence: true }, submission);
    }
    finally {
        context.pending.release(submission);
        // Abort settlement can wake the queue while the gate is held. Wake once more
        // after release, including preparation failures; never change QueuePaused.
        release();
    }
}
async function interruptForHandoff(controller, submission) {
    const activeTurnId = controller.activeTurnId(submission.sessionId);
    if (!activeTurnId)
        return undefined;
    const stopped = await controller.abort({
        sessionId: submission.sessionId,
        turnId: activeTurnId,
        reason: 'immediate_send',
    });
    if (submission.stopped)
        return STOPPED_BEFORE_ADMISSION;
    if (stopped.status === 'abort-timeout') {
        return { accepted: false, reason: 'policy:cloud-handoff:interrupt-timeout' };
    }
    if (controller.activeTurnId(submission.sessionId)) {
        return { accepted: false, reason: 'active-turn' };
    }
    return undefined;
}
async function notifyInterruptSendReleased(options, sessionId) {
    try {
        await options.onInterruptSendReleased?.(sessionId);
    }
    catch {
        // Queue wake failure must not turn an accepted handoff into a send failure.
    }
}
async function handoffReplay(repository, input, turnId) {
    const receipt = (input.requestedTurnId ? await repository.findReceipt(turnId) : undefined) ??
        (input.clientRequestId
            ? await repository.findSteeringReceipt({
                sessionId: input.sessionId,
                clientRequestId: input.clientRequestId,
            })
            : undefined);
    if (!receipt)
        return undefined;
    return receipt.sessionId === input.sessionId &&
        receipt.inputDigest === digestTurnInput(input.input, input.clientIntent)
        ? { accepted: false, reason: 'duplicate', turnId: receipt.turnId }
        : { accepted: false, reason: 'ingress-conflict' };
}
async function handoffDrained(drained) {
    await drained;
    return true;
}
async function waitForHandoffDrain(drained) {
    let timer;
    try {
        return await Promise.race([
            handoffDrained(drained),
            new Promise((resolve) => {
                timer = setTimeout(() => resolve(false), 30_000);
            }),
        ]);
    }
    finally {
        clearTimeout(timer);
    }
}
async function submitTurn(context, input, policy = {}, pendingSubmission) {
    const { options } = context;
    const turnId = input.requestedTurnId ?? context.makeTurnId();
    const submission = pendingSubmission ?? context.pending.enroll(input.sessionId, turnId);
    try {
        // Enroll before the first asynchronous check so an early stop is not lost.
        const unavailable = await sessionUnavailable(options, input.sessionId);
        if (unavailable)
            return unavailable;
        const admission = await admitTurnWithSubmissionPreparation({
            options,
            input,
            turnId,
            candidateCreatedAtMs: input.candidateCreatedAtMs ?? context.nowMs(),
            policy,
            submission,
        });
        if (admission.status === 'settled')
            return admission.result;
        return await startAcceptedTurn(options, {
            input,
            turnId,
            admitted: admission.admitted,
            preparation: admission.preparation,
            submission,
        });
    }
    finally {
        context.pending.release(submission);
    }
}
async function admitTurnWithSubmissionPreparation(request) {
    const { options, input, turnId, candidateCreatedAtMs, policy, submission } = request;
    const preparation = submission.stopped
        ? undefined
        : await options.submissionPreparation?.prepare(submissionPreparationCandidate(input, turnId));
    if (preparation?.status === 'rejected') {
        return settleRejectedPreparation(preparation, submission.stopped);
    }
    // A stop observed during preparation settles before durable admission: nothing durable is
    // written, so a late preparation result cannot start the Turn, and a Queue claim is cancelled
    // rather than deferred back for another dispatch.
    if (submission.stopped) {
        await preparation?.rollback();
        return {
            status: 'settled',
            result: STOPPED_BEFORE_ADMISSION,
        };
    }
    let admitted;
    try {
        admitted = await options.repository.admit(admissionInput(input, { turnId, candidateCreatedAtMs, ...policy }));
    }
    catch (error) {
        await preparation?.rollback();
        throw error;
    }
    if (admitted.status !== 'accepted') {
        await preparation?.rollback();
        return { status: 'settled', result: rejection(admitted) };
    }
    try {
        await options.preparation.projectStarted({
            sessionId: input.sessionId,
            turnId,
            turnSequence: admitted.acceptedSequence,
            eventId: `${turnId}:pre-host-started`,
        });
        await preparation?.commit();
    }
    catch (error) {
        let failure = error;
        try {
            await preparation?.compensate();
        }
        catch (restoreError) {
            failure = new AggregateError([error, restoreError], 'Turn admission succeeded but submission compensation failed');
        }
        return {
            status: 'settled',
            result: await failAcceptedBeforeRegistration(options, {
                input,
                turnId,
                admitted,
                error: failure,
            }),
        };
    }
    return { status: 'ready', admitted, ...(preparation ? { preparation } : {}) };
}
function settleRejectedPreparation(preparation, stopped) {
    return {
        status: 'settled',
        result: stopped
            ? STOPPED_BEFORE_ADMISSION
            : {
                accepted: false,
                reason: preparation.reason,
                ...(preparation.queueDisposition
                    ? { queueDisposition: preparation.queueDisposition }
                    : {}),
            },
    };
}
function submissionPreparationCandidate(input, turnId) {
    return {
        sessionId: input.sessionId,
        turnId,
        provenance: submissionProvenance(input),
        ...(isQueueSubmission(input) ? { queueItemId: input.ingress.itemId } : {}),
        ...(input.clientIntent ? { clientIntent: input.clientIntent } : {}),
        ...(input.genuineUserQueryText ? { genuineUserQueryText: input.genuineUserQueryText } : {}),
        ...(!isQueueSubmission(input) && input.resume ? { userInputResume: input.resume } : {}),
    };
}
async function failAcceptedBeforeRegistration(options, failure) {
    const failed = await options.coordinator.failAdmission({
        admission: {
            sessionId: failure.input.sessionId,
            turnId: failure.turnId,
            leaseId: failure.admitted.leaseId,
            acceptedSequence: failure.admitted.acceptedSequence,
            acceptedAtMs: failure.admitted.acceptedAtMs,
            busyReason: 'turn',
            ...(failure.admitted.foreground ? { foreground: true } : {}),
        },
        error: failure.error,
    });
    return {
        accepted: true,
        turnId: failure.turnId,
        acceptedAtMs: failure.admitted.acceptedAtMs,
        completion: failed.completion,
    };
}
async function rollbackAcceptedSubmission(options, accepted, error) {
    const { input, turnId, admitted, preparation } = accepted;
    const failure = await compensateStartedPreparation(preparation, error);
    // A pre-delivery hook throws AbortError to withdraw a delivery that a user stop
    // caught in flight. That is cancellation, not a failed Turn: project it as
    // aborted just like a stop before registration, never as a Session error.
    const status = isAbortError(failure) ? 'aborted' : undefined;
    let revoked = false;
    try {
        await options.failures.project({
            sessionId: input.sessionId,
            turnId,
            turnSequence: admitted.acceptedSequence,
            eventId: `${turnId}:pre-host-${status ?? 'failed'}`,
            error: failure,
            ...(status ? { status } : {}),
        });
        revoked = await options.repository.revokeAdmission({
            sessionId: input.sessionId,
            turnId,
            leaseId: admitted.leaseId,
            ...(admitted.queuePauseRevokeToken
                ? { queuePauseRevokeToken: admitted.queuePauseRevokeToken }
                : {}),
        });
    }
    catch {
        // A failed projection or revoke leaves the durable receipt in place so a replay cannot
        // turn an uncertain admission into a duplicate delivery.
    }
    if (revoked) {
        if (error instanceof StoppedBeforeRegistrationError && failure === error) {
            return STOPPED_BEFORE_ADMISSION;
        }
        throw failure;
    }
    return failAcceptedBeforeRegistration(options, {
        input,
        turnId,
        admitted,
        error: failure,
    });
}
async function startAcceptedTurn(options, accepted) {
    const { input, turnId, admitted, preparation, submission } = accepted;
    const admission = {
        sessionId: input.sessionId,
        turnId,
        leaseId: admitted.leaseId,
        acceptedSequence: admitted.acceptedSequence,
        acceptedAtMs: admitted.acceptedAtMs,
        busyReason: 'turn',
        ...(admitted.foreground ? { foreground: true } : {}),
    };
    try {
        if (submission.stopped)
            throw new StoppedBeforeRegistrationError();
        // A synchronous hook is not awaited, so its decision, the stopped check below
        // and controller.register run in one synchronous step. A stop cannot land
        // between final admission and this Turn becoming visible to activeTurnId.
        const accepting = acceptActivatedDelivery(input, turnId);
        if (accepting)
            await accepting;
        if (submission.stopped)
            throw new StoppedBeforeRegistrationError();
    }
    catch (error) {
        return rollbackAcceptedSubmission(options, accepted, error);
    }
    let turn;
    try {
        turn = options.controller.register(admission);
    }
    catch (error) {
        const failure = await compensateStartedPreparation(preparation, error);
        const failed = await options.coordinator.failAdmission({ admission, error: failure });
        return {
            accepted: true,
            turnId,
            acceptedAtMs: admitted.acceptedAtMs,
            completion: failed.completion,
        };
    }
    try {
        const started = await options.coordinator.startTurn({
            turn,
            request: hostRequest(input),
            ...(preparation?.beforeHost
                ? { beforeHost: preparation.beforeHost, compensate: preparation.compensate }
                : {}),
            ...(input.executionStart ? { executionStart: input.executionStart } : {}),
        });
        return {
            accepted: true,
            turnId,
            acceptedAtMs: admitted.acceptedAtMs,
            completion: started.completion,
        };
    }
    catch (error) {
        const failure = await compensateStartedPreparation(preparation, error);
        const failed = await options.coordinator.failTurn({ turn, error: failure });
        return {
            accepted: true,
            turnId,
            acceptedAtMs: admitted.acceptedAtMs,
            completion: failed.completion,
        };
    }
}
function acceptActivatedDelivery(input, turnId) {
    if (isQueueSubmission(input))
        return undefined;
    const accepting = input.preDelivery?.accept({ mode: 'activated', turnId });
    return accepting === undefined ? undefined : accepting;
}
async function compensateStartedPreparation(preparation, error) {
    if (!preparation)
        return error;
    try {
        await preparation.compensate();
        return error;
    }
    catch (compensationError) {
        return new AggregateError([error, compensationError], 'Turn start failed and submission compensation also failed');
    }
}
async function beginCompaction(options, input, nowMs, makeTurnId) {
    const unavailable = await sessionUnavailable(options, input.sessionId);
    if (unavailable)
        return unavailable;
    const turnId = input.requestedTurnId ?? makeTurnId();
    const admitted = await options.repository.admit(compactionAdmission(input, turnId, input.candidateCreatedAtMs ?? nowMs()));
    if (admitted.status !== 'accepted')
        return rejection(admitted);
    const admission = {
        sessionId: input.sessionId,
        turnId,
        leaseId: admitted.leaseId,
        acceptedSequence: admitted.acceptedSequence,
        acceptedAtMs: admitted.acceptedAtMs,
        busyReason: 'compaction',
    };
    let turn;
    try {
        turn = options.controller.register(admission);
    }
    catch (error) {
        return {
            accepted: true,
            turnId,
            run: async () => {
                const failed = await options.coordinator.failAdmission({ admission, error });
                return failed.completion;
            },
        };
    }
    return {
        accepted: true,
        turnId,
        run: () => runCompaction(options, input, turn),
    };
}
async function runCompaction(options, input, turn) {
    try {
        await input.onStarted?.();
    }
    catch {
        // Delivery acknowledgement is observational and cannot strand an admitted compaction lease.
    }
    return options.coordinator.compact(compactionInput(turn, input));
}
async function sessionUnavailable(options, sessionId) {
    if (!(await options.sessions.has(sessionId))) {
        return { accepted: false, reason: 'invalid-session' };
    }
    if (await options.repository.isSessionDeleting(sessionId)) {
        return { accepted: false, reason: 'session-deleting' };
    }
    return undefined;
}
function admissionInput(input, values) {
    const base = admissionBase(input, values);
    if (isQueueSubmission(input)) {
        return {
            ...base,
            priority: queueAdmissionPriority(input, values.candidateCreatedAtMs),
            queueIngress: input.ingress,
            ...(input.ingress.clientRequestId ? { clientRequestId: input.ingress.clientRequestId } : {}),
        };
    }
    return {
        ...base,
        priority: directAdmissionPriority(input, values.candidateCreatedAtMs),
        ...(input.resume ? { userInputResume: input.resume } : {}),
        ...(input.clientRequestId ? { clientRequestId: input.clientRequestId } : {}),
        ...(input.clientRequestId && input.receiptAliases?.length
            ? { receiptAliases: input.receiptAliases }
            : {}),
    };
}
function admissionBase(input, values) {
    const foreground = isForegroundTurn(input);
    return {
        sessionId: input.sessionId,
        turnId: values.turnId,
        busyReason: 'turn',
        inputDigest: digestTurnInput(input.input, input.clientIntent),
        inputMetadata: {
            ...metadata(input.input),
            source: isQueueSubmission(input) ? input.ingress.provenance.source : input.provenance.source,
        },
        candidateCreatedAtMs: values.candidateCreatedAtMs,
        ...genuineUserAdmission(input),
        ...(foreground ? { foreground: true } : {}),
        ...(consumesQueuePause(input, foreground) ? { consumeQueuePause: true } : {}),
        ...(input.clientIntent ? { clientIntent: input.clientIntent } : {}),
        ...(values.bypassPriorityFence ? { bypassPriorityFence: true } : {}),
        ...(values.bypassSessionMutation ? { bypassSessionMutation: true } : {}),
    };
}
function queueAdmissionPriority(input, candidateCreatedAtMs) {
    if (input.queueSelection === 'exact') {
        return { kind: 'selected-queue-item', queueClaimId: input.ingress.claimId };
    }
    // An exact claim already bypasses queue order, so the yield only has to reach
    // the two fenced selections.
    const yielded = input.yieldedQueueItemIds && input.yieldedQueueItemIds.length > 0
        ? { yieldedQueueItemIds: input.yieldedQueueItemIds }
        : {};
    if (input.queueSelection === 'continued-fifo') {
        return { kind: 'continued-queue-head', queueClaimId: input.ingress.claimId, ...yielded };
    }
    return { kind: 'fifo', candidateCreatedAtMs, queueClaimId: input.ingress.claimId, ...yielded };
}
function directAdmissionPriority(input, candidateCreatedAtMs) {
    if (input.admissionPriority)
        return input.admissionPriority;
    if (isPausedQueueSend(input.clientIntent))
        return { kind: 'paused-queue-send' };
    return { kind: 'fifo', candidateCreatedAtMs };
}
function consumesQueuePause(input, foreground) {
    if (isQueueSubmission(input))
        return input.queueSelection === 'continued-fifo';
    return (foreground &&
        input.clientIntent !== 'retry-continuation' &&
        input.clientIntent !== 'cloud-handoff');
}
function isForegroundTurn(input) {
    if (!isQueueSubmission(input)) {
        if (input.executionMode === 'continuation')
            return true;
        if (input.resume)
            return false;
        if (isPausedQueueSend(input.clientIntent))
            return true;
    }
    const source = submissionProvenance(input).source;
    return source === 'conversation-mutation' || isUserAuthoredSource(source);
}
function isPausedQueueSend(clientIntent) {
    return clientIntent === 'paused-queue-keep' || clientIntent === 'paused-queue-clear';
}
function genuineUserAdmission(input) {
    return isGenuineUserMessage(input) ? { genuineUserMessage: true } : {};
}
function isGenuineUserMessage(input) {
    if (input.genuineUserQueryText.length > 0)
        return true;
    if (!input.input.attachments?.length)
        return false;
    const source = isQueueSubmission(input)
        ? input.ingress.provenance.source
        : input.provenance.source;
    return isUserAuthoredSource(source);
}
function compactionAdmission(input, turnId, candidateCreatedAtMs) {
    return {
        sessionId: input.sessionId,
        turnId,
        busyReason: 'compaction',
        inputDigest: digestTurnInput({
            text: input.reason ?? '',
            origin: input.customInstructions ?? '',
        }),
        inputMetadata: { attachmentCount: 0, hasContent: Boolean(input.reason) },
        candidateCreatedAtMs,
        priority: { kind: 'fifo', candidateCreatedAtMs },
    };
}
function compactionInput(lease, input) {
    return {
        lease,
        ...(input.reason ? { reason: input.reason } : {}),
        ...(input.customInstructions ? { customInstructions: input.customInstructions } : {}),
    };
}
function hostRequest(input) {
    const common = commonHostRequest(input);
    if (isQueueSubmission(input)) {
        const userMessageId = queueUserMessageId(input);
        return {
            ...common,
            provenance: input.ingress.provenance,
            queueItemIds: [input.ingress.itemId],
            ...(input.ingress.clientRequestId ? { clientRequestId: input.ingress.clientRequestId } : {}),
            ...(userMessageId ? { userMessageId } : {}),
        };
    }
    return {
        ...common,
        provenance: input.provenance,
        ...(input.clientRequestId ? { clientRequestId: input.clientRequestId } : {}),
        ...(input.userMessageId ? { userMessageId: input.userMessageId } : {}),
        ...(input.executionMode ? { executionMode: input.executionMode } : {}),
    };
}
function commonHostRequest(input) {
    return {
        input: input.input,
        ...(!isQueueSubmission(input) && input.outputContract
            ? { outputContract: input.outputContract }
            : {}),
        ...(!isQueueSubmission(input) && input.executionDeadlineAtMs !== undefined
            ? { executionDeadlineAtMs: input.executionDeadlineAtMs }
            : {}),
        ...(input.immediateSendBatch
            ? {
                immediateSendBatch: {
                    id: input.immediateSendBatch.id,
                    members: input.immediateSendBatch.members.map((member) => ({
                        input: {
                            text: member.message.content,
                            attachments: member.message.attachments,
                            ...(member.message.quotedMessage
                                ? { quotedMessage: member.message.quotedMessage }
                                : {}),
                        },
                        genuineUserQueryText: member.message.displayContent ?? member.message.content,
                        userMessageId: member.userMessageId,
                        messageKey: member.messageKey,
                        createdAt: member.createdAt,
                        provenance: member.provenance,
                    })),
                },
            }
            : {}),
        genuineUserQueryText: input.genuineUserQueryText,
        ...(input.inputSafetyDecision ? { inputSafetyDecision: input.inputSafetyDecision } : {}),
        ...(input.requiresInputReview ? { requiresInputReview: true } : {}),
        ...(input.clientIntent ? { clientIntent: input.clientIntent } : {}),
    };
}
function queueUserMessageId(input) {
    if (input.userMessageId &&
        input.ingress.userMessageId &&
        input.userMessageId !== input.ingress.userMessageId) {
        throw new Error('Queue user message identity changed before AgentHost execution');
    }
    return input.userMessageId ?? input.ingress.userMessageId;
}
function isQueueSubmission(input) {
    return 'ingress' in input;
}
function submissionProvenance(input) {
    return isQueueSubmission(input) ? input.ingress.provenance : input.provenance;
}
function rejection(input) {
    if (input.status === 'duplicate') {
        return { accepted: false, reason: 'duplicate', turnId: input.turnId };
    }
    return { accepted: false, reason: input.reason };
}
function metadata(input) {
    return {
        attachmentCount: input.attachments?.length ?? 0,
        hasContent: input.text.length > 0,
    };
}
//# sourceMappingURL=turn-execution.service.js.map