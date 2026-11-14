import { RuntimeEventStatus, RuntimeEventType, } from '@mavis/agent-core/protocol';
import { incrementMetric, observeMetric, } from '@mavis/shared/local-runtime-logging/metrics';
import { isUserSteeringProducer, } from '../../service/turn-system/index.js';
/** Turns whose terminal never arrived are dropped oldest first past this many. */
const MAX_TRACKED_TURNS = 512;
/**
 * Messages a person types from a client composer into a running Turn of Bunny's main
 * conversation: one `bunny_steer_total` count each, by outcome, and its
 * `bunny_steer_pickup_ms`, from the running Turn admitting it to processing it starting (the
 * Turn's next model request taking it, or for handed_back the follow-up Turn starting). Bunny's
 * first output and first visible text are the shared turn metrics with agentKind. Every method
 * is best-effort and never throws into the Turn.
 */
export class BunnySteerTiming {
    options;
    steerTurns = new Map();
    steerRecords = new WeakMap();
    /** Admission instants waiting for the follow-up Turn, by Session. */
    handedBack = new Map();
    nowMs;
    constructor(options = {}) {
        this.options = options;
        this.nowMs = options.nowMs ?? Date.now;
    }
    hostStarted(turn) {
        // A handed-back batch goes to the front of the queue, so this Turn answers it.
        const handedBack = this.handedBack.get(turn.sessionId);
        if (!handedBack)
            return;
        this.handedBack.delete(turn.sessionId);
        const now = this.nowMs();
        for (const admittedAtMs of handedBack)
            this.reportPickup('handed_back', now - admittedAtMs);
    }
    /** Part of the Host timing port; steering timing needs nothing when the main request is ready. */
    mainRequestPrepared(_turn) { }
    /** Runs before the wake a preemption answers, so the answer finds this record. */
    steeringAdmitted(input) {
        const members = userSteeringMembers(input.message);
        if (members.length === 0)
            return;
        const now = this.nowMs();
        const steerTurn = this.steerTurn(turnKey(input));
        for (const member of members) {
            const record = { admittedAtMs: now };
            this.steerRecords.set(member, record);
            steerTurn.unresolved.push(record);
        }
    }
    steeringPreemption(turn, result) {
        const steerTurn = this.steerTurns.get(turnKey(turn));
        if (!steerTurn)
            return;
        const outcome = preemptionOutcome(result, steerTurn.preemptPending);
        for (const record of steerTurn.unresolved)
            record.outcome = outcome;
        steerTurn.unresolved = [];
        if (result === 'preempted')
            steerTurn.preemptPending = true;
    }
    steeringConsumed(input) {
        const { message } = input;
        if (!isUserSteeringProducer(message.producerId))
            return;
        const now = this.nowMs();
        const record = this.steerRecords.get(message);
        const admittedAtMs = record?.admittedAtMs ?? message.createdAt ?? now;
        this.steerTurn(turnKey(input)).preemptPending = false;
        if (record?.counted === true)
            return;
        const outcome = record?.outcome ?? 'waited';
        if (record)
            record.counted = true;
        this.countSteer(outcome);
        this.reportPickup(outcome, now - admittedAtMs);
    }
    steeringDiscarded(input) {
        const now = this.nowMs();
        for (const message of input.messages) {
            for (const member of userSteeringMembers(message)) {
                const record = this.steerRecords.get(member);
                if (record?.counted === true)
                    continue;
                if (record)
                    record.counted = true;
                if (input.cause !== 'exit-close') {
                    this.countSteer('turn_ended');
                    continue;
                }
                this.countSteer('handed_back');
                const waiting = this.handedBack.get(input.sessionId) ?? [];
                waiting.push(record?.admittedAtMs ?? member.createdAt ?? now);
                this.handedBack.delete(input.sessionId);
                this.handedBack.set(input.sessionId, waiting);
                trimOldest(this.handedBack);
            }
        }
    }
    /** A Turn that ended forgets its steering state. */
    observeRuntimeEvent(input) {
        if (isTerminal(input.event))
            this.steerTurns.delete(turnKey(input.context));
    }
    steerTurn(key) {
        const existing = this.steerTurns.get(key);
        if (existing)
            return existing;
        const created = { unresolved: [], preemptPending: false };
        this.steerTurns.set(key, created);
        trimOldest(this.steerTurns);
        return created;
    }
    countSteer(outcome) {
        incrementMetric(this.options.metrics, 'bunny_steer_total', 1, { outcome });
    }
    reportPickup(outcome, pickupMs) {
        if (pickupMs < 0)
            return;
        observeMetric(this.options.metrics, 'bunny_steer_pickup_ms', pickupMs, { outcome });
    }
}
export function createBunnySteerTiming(options) {
    return new BunnySteerTiming(options);
}
function userSteeringMembers(message) {
    return (message.batchMembers ?? [message]).filter((member) => isUserSteeringProducer(member.producerId));
}
function preemptionOutcome(result, preemptPending) {
    if (result === 'preempted')
        return 'preempted';
    if (result === 'failed')
        return 'preempt_failed';
    return preemptPending ? 'merged' : 'waited';
}
/** Entries whose terminal never arrived are dropped oldest first. */
function trimOldest(entries) {
    const oldest = entries.keys().next();
    if (entries.size > MAX_TRACKED_TURNS && !oldest.done)
        entries.delete(oldest.value);
}
function isTerminal(event) {
    if (event.type !== RuntimeEventType.SESSION_STATUS &&
        event.type !== RuntimeEventType.TURN_TERMINAL) {
        return false;
    }
    const status = event.payload.status;
    return (status === RuntimeEventStatus.COMPLETED ||
        status === RuntimeEventStatus.FAILED ||
        status === RuntimeEventStatus.ABORTED);
}
function turnKey(turn) {
    return `${turn.sessionId}\0${turn.turnId}`;
}
//# sourceMappingURL=bunny-steer-timing.js.map