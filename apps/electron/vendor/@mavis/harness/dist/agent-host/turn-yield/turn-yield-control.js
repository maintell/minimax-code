import { TurnYieldHistoryFence } from './history-fence.js';
const MAX_TIMER_MS = 2 ** 31 - 1;
const LIMIT_FIELDS = ['approvalHoldMs', 'userInputHoldMs', 'yieldGraceMs'];
export const UNBOUNDED_TURN_YIELD_LIMITS = Object.freeze({
    approvalHoldMs: Infinity,
    userInputHoldMs: Infinity,
    yieldGraceMs: Infinity,
});
class TurnYieldLimitsError extends Error {
    field;
    name = 'TurnYieldLimitsError';
    constructor(field) {
        super(`Harness limit ${field} must be Infinity or a number of milliseconds from 0 to ${MAX_TIMER_MS}.`);
        this.field = field;
    }
}
/** A hold reached its limit; the merged signal handed to the Host aborts with this reason. */
export class HoldExpiredError extends Error {
    kind;
    holdMs;
    name = 'HoldExpiredError';
    constructor(kind, holdMs) {
        super(`The ${kind} hold expired after ${holdMs} ms.`);
        this.kind = kind;
        this.holdMs = holdMs;
    }
}
/** Abort reason of a run stopped at a resumable boundary. */
export class TurnYieldStop extends Error {
    yieldReason;
    resumeFrom;
    name = 'TurnYieldStop';
    constructor(yieldReason, resumeFrom) {
        super(`The run yielded (${yieldReason}); it resumes from ${resumeFrom}.`);
        this.yieldReason = yieldReason;
        this.resumeFrom = resumeFrom;
    }
}
/** Accepts each limit only as Infinity or a delay `setTimeout` keeps exact. */
export function assertTurnYieldLimits(limits) {
    if (typeof limits !== 'object' || limits === null)
        throw new TurnYieldLimitsError('limits');
    for (const field of LIMIT_FIELDS) {
        if (!isLimit(Reflect.get(limits, field)))
            throw new TurnYieldLimitsError(field);
    }
}
/**
 * Stops one run at a resumable boundary. A requested yield stops at the next
 * model call, or at its tail once `yieldGraceMs` passes; a hold that outlives
 * its limit, or is still waiting when a yield is requested, stops the run so
 * the waiting tool calls run again in a `pending-tool-calls` continuation.
 *
 * Inactive (no yield signal and every limit Infinity) it rebinds nothing,
 * starts no timer and passes each hold straight to the Host.
 */
export class TurnYieldControl {
    limits;
    yieldSignal;
    active;
    stopController = new AbortController();
    holds = new Map();
    leaseSignal;
    resumable = false;
    requested;
    stopReason;
    graceTimer;
    constructor(limits, yieldSignal) {
        this.limits = limits;
        this.yieldSignal = yieldSignal;
        this.active =
            yieldSignal !== undefined || LIMIT_FIELDS.some((field) => Number.isFinite(limits[field]));
        if (!yieldSignal)
            return;
        if (yieldSignal.aborted)
            this.onYieldSignal();
        else
            yieldSignal.addEventListener('abort', this.onYieldSignal, { once: true });
    }
    /**
     * Where the continuation resumes the stopped run; undefined until it stops.
     * Only a `pending-tool-calls` stop leaves the run's output to the
     * continuation (with aligned Display ids); a `tail` stop still settles the
     * run as cancelled.
     */
    get stoppedAt() {
        return this.stopReason?.resumeFrom;
    }
    /** The outcome of a stopped run; undefined while the run has not stopped. */
    yielded(eventCursor) {
        const stop = this.stopReason;
        if (!stop)
            return undefined;
        return Object.freeze({
            status: 'yielded',
            reason: stop.yieldReason,
            resumeFrom: stop.resumeFrom,
            eventCursor,
        });
    }
    /**
     * Runs the kernel under a signal that also aborts on stop, fences history
     * written after the stop, and checks for a requested yield before each model
     * call. The pipeline keeps the accepted lease, so events still deliver.
     */
    bindKernel(kernel) {
        if (!this.active)
            return kernel;
        this.leaseSignal = kernel.lease.signal;
        this.resumable = kernel.resumable;
        const fence = new TurnYieldHistoryFence(kernel.initialMessages, () => this.stopReason?.resumeFrom);
        const lease = Object.freeze({
            ...kernel.lease,
            signal: AbortSignal.any([kernel.lease.signal, this.stopController.signal]),
        });
        this.advance();
        return {
            ...kernel,
            lease,
            onHistoryChanged: (change) => {
                const admitted = fence.admit(change);
                return admitted ? kernel.onHistoryChanged(admitted) : Promise.resolve();
            },
            contextCompactionHook: this.boundaryHook(kernel.contextCompactionHook),
        };
    }
    /**
     * Waits for the Host under a signal that also aborts when the hold expires or
     * the run stops, and settles as soon as that signal aborts. An approval hold
     * that starts after the run stopped never reaches the Host; a user-input hold
     * still calls the Host so it releases the question it began.
     */
    async hold(kind, signal, wait) {
        if (!this.active)
            return wait(signal);
        if (this.requested)
            this.stop(holdYieldReason(kind), 'pending-tool-calls');
        if (this.stopReason && kind === 'approval')
            throw this.stopReason;
        const controller = new AbortController();
        if (this.stopReason)
            controller.abort(this.stopReason);
        // The hold's own reason comes first: a composite signal reads its reason from the first aborted source.
        const merged = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
        this.holds.set(controller, kind);
        const timer = this.startHoldTimer(kind, controller);
        try {
            return await settleOnAbort(merged, () => wait(merged));
        }
        finally {
            clearTimeout(timer);
            this.holds.delete(controller);
        }
    }
    /** Releases the timers and the yield signal listener; the run is over. */
    dispose() {
        clearTimeout(this.graceTimer);
        this.yieldSignal?.removeEventListener('abort', this.onYieldSignal);
    }
    onYieldSignal = () => {
        this.requested ??= this.yieldSignal?.reason === 'memory-pressure' ? 'memory-pressure' : 'drain';
        this.advance();
    };
    advance() {
        const requested = this.requested;
        if (!requested || this.stopReason || !this.leaseSignal)
            return;
        const holding = this.holds.values().next();
        if (!holding.done) {
            this.stop(holdYieldReason(holding.value), 'pending-tool-calls');
            return;
        }
        const graceMs = this.limits.yieldGraceMs;
        if (!this.resumable || this.graceTimer !== undefined || !Number.isFinite(graceMs))
            return;
        this.graceTimer = setTimeout(() => this.stop(requested, 'tail'), graceMs);
    }
    boundaryHook(hook) {
        return async (input) => {
            this.resumable = true;
            if (this.requested)
                this.stop(this.requested, 'tail');
            if (this.stopReason)
                return undefined;
            return hook?.(input);
        };
    }
    startHoldTimer(kind, controller) {
        const holdMs = kind === 'approval' ? this.limits.approvalHoldMs : this.limits.userInputHoldMs;
        if (!Number.isFinite(holdMs))
            return undefined;
        return setTimeout(() => {
            controller.abort(new HoldExpiredError(kind, holdMs));
            this.stop(holdYieldReason(kind), 'pending-tool-calls');
        }, holdMs);
    }
    /** First stop wins; an aborted lease keeps its abort outcome. */
    stop(reason, resumeFrom) {
        if (this.stopReason || this.leaseSignal?.aborted)
            return;
        clearTimeout(this.graceTimer);
        const stop = new TurnYieldStop(reason, resumeFrom);
        this.stopReason = stop;
        for (const controller of this.holds.keys())
            controller.abort(stop);
        this.stopController.abort(stop);
    }
}
function isLimit(value) {
    return value === Infinity || (typeof value === 'number' && value >= 0 && value <= MAX_TIMER_MS);
}
function holdYieldReason(kind) {
    return kind === 'approval' ? 'approval-hold' : 'user-input-hold';
}
/**
 * Listens before calling `start`, so a stop `start` triggers synchronously
 * already reaches the composite signal with the reason of its first abort.
 */
async function settleOnAbort(signal, start) {
    let onAbort = () => undefined;
    const aborted = new Promise((_resolve, reject) => {
        onAbort = () => reject(signal.reason);
        if (signal.aborted)
            onAbort();
        else
            signal.addEventListener('abort', onAbort, { once: true });
    });
    const started = (async () => start())();
    try {
        return await Promise.race([started, aborted]);
    }
    finally {
        signal.removeEventListener('abort', onAbort);
    }
}
//# sourceMappingURL=turn-yield-control.js.map