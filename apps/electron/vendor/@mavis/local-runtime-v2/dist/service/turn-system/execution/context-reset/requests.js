import { rejection, resetAdmission, retriesAdmission, waitAtMost, } from './admission.js';
import { stopRunningTurn } from './forced-stop.js';
/** `requestCompaction` reason of the user's context reset of a Bunny main conversation. */
export const BUNNY_CONTEXT_RESET_REASON = 'bunny_user_reset';
/** Admissions a reset tries; a wake that slipped in between is stopped in turn. */
const MAX_RESET_ADMISSIONS = 3;
/** How long a reset waits for submissions already entering the Session. */
const ENTERED_SUBMISSIONS_WAIT_MS = 30_000;
/**
 * The user's context reset (context reset spec 3): it may run while a Turn
 * runs. The Turn is stopped first; one that does not stop within the stop
 * timeout is ended by force, its lock released and its late writes dropped.
 * The reset then takes the Session as a compaction does, ahead of the queue,
 * which it leaves unpaused. A second reset while one runs gets the same result.
 */
class ContextResetRequests {
    options;
    nowMs;
    makeTurnId;
    running = new Map();
    constructor(options, nowMs, makeTurnId) {
        this.options = options;
        this.nowMs = nowMs;
        this.makeTurnId = makeTurnId;
    }
    /** Undefined: the Session is not one the reset applies to; it compacts as before. */
    async request(input) {
        const { sessionId } = input;
        let run = this.running.get(sessionId);
        if (!run) {
            run = this.runOnce(input);
            this.running.set(sessionId, run);
        }
        const result = await run;
        return result === 'not-eligible' ? undefined : result;
    }
    /** One reset of the Session; the next request after it settles starts another. */
    async runOnce(input) {
        try {
            return await this.run(input);
        }
        finally {
            // Only one run per Session is ever registered, so this entry is this run's.
            this.running.delete(input.sessionId);
        }
    }
    async run(input) {
        const { options } = this;
        const admission = options.controller.tryEnterAdmission();
        if (!admission) {
            return { accepted: false, reason: 'policy:runtime:draining' };
        }
        try {
            const lease = options.operations.tryAcquireExclusive(input.sessionId);
            if (!lease)
                return { accepted: false, reason: 'session-mutating' };
            let started;
            try {
                const begun = await this.begin(input, lease.drained);
                if (begun === 'not-eligible' || !('run' in begun))
                    return begun;
                started = begun;
            }
            finally {
                // The reset holds the Session's lock from here; queued work waits for its settlement.
                lease.release();
            }
            return { accepted: true, turnId: started.turnId, outcome: await started.run() };
        }
        finally {
            admission.release();
        }
    }
    async begin(input, entered) {
        const { options } = this;
        const { sessionId } = input;
        const requestedAtMs = this.nowMs();
        const refused = await this.refusal(sessionId);
        if (refused)
            return refused;
        // Submissions already entering may still be registering a Turn; stop that one too.
        await waitAtMost(entered, ENTERED_SUBMISSIONS_WAIT_MS);
        let hadRunningTurn = false;
        let forcedStop = false;
        for (let attempt = 1;; attempt += 1) {
            const stopped = await stopRunningTurn(options, sessionId);
            hadRunningTurn ||= stopped.stopped;
            forcedStop ||= stopped.forced;
            const turnId = this.makeTurnId();
            const admitted = await options.repository.admit(resetAdmission(input, turnId, this.nowMs()));
            if (admitted.status !== 'accepted') {
                if (attempt < MAX_RESET_ADMISSIONS && retriesAdmission(admitted))
                    continue;
                return rejection(admitted);
            }
            const registered = {
                sessionId,
                turnId,
                leaseId: admitted.leaseId,
                acceptedSequence: admitted.acceptedSequence,
                acceptedAtMs: admitted.acceptedAtMs,
                busyReason: 'compaction',
            };
            let turn;
            try {
                turn = options.controller.register(registered);
            }
            catch (error) {
                return {
                    turnId,
                    run: async () => (await options.coordinator.failAdmission({ admission: registered, error })).completion,
                };
            }
            const contextReset = { hadRunningTurn, forcedStop, requestedAtMs };
            return {
                turnId,
                run: () => runReset(options, input, { lease: turn, contextReset }),
            };
        }
    }
    /** Why the Session takes no reset now; undefined: it does. */
    async refusal(sessionId) {
        const { options } = this;
        if (!(await options.sessions.has(sessionId))) {
            return { accepted: false, reason: 'invalid-session' };
        }
        if (await options.repository.isSessionDeleting(sessionId)) {
            return { accepted: false, reason: 'session-deleting' };
        }
        return (await options.contextReset.eligible(sessionId)) ? undefined : 'not-eligible';
    }
}
async function runReset(options, input, compaction) {
    try {
        await input.onStarted?.();
    }
    catch {
        // Delivery acknowledgement is observational and cannot strand an admitted lease.
    }
    return options.coordinator.compact({
        ...compaction,
        ...(input.reason ? { reason: input.reason } : {}),
    });
}
/**
 * The context reset route of `requestCompaction`: undefined without a policy;
 * otherwise it resets the Sessions the policy takes when the reason asks for
 * it, and returns undefined for every other request, which compacts as before.
 */
export function contextResetRoute(options, nowMs, makeTurnId) {
    const contextReset = options.contextReset;
    if (!contextReset)
        return undefined;
    const resets = new ContextResetRequests({ ...options, contextReset }, nowMs, makeTurnId);
    return async (input) => input.reason === BUNNY_CONTEXT_RESET_REASON ? resets.request(input) : undefined;
}
//# sourceMappingURL=requests.js.map