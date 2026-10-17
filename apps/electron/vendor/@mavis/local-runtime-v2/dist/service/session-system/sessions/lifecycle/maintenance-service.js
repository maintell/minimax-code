import { SessionServiceError } from '../errors.js';
export class SessionMaintenanceService {
    guard;
    constructor(guard) {
        this.guard = guard;
    }
    async runExclusive(sessionId, operation) {
        const lease = await this.guard.tryAcquireSessionMaintenance(sessionId);
        if (!lease) {
            throw new SessionServiceError('session-busy', `Session is busy: ${sessionId}`);
        }
        return runWithLease(this.guard, lease, operation);
    }
    async tryRunExclusive(sessionId, operation) {
        const lease = await this.guard.tryAcquireSessionMaintenance(sessionId);
        if (!lease)
            return { acquired: false };
        return {
            acquired: true,
            value: await runWithLease(this.guard, lease, (lane) => lane.run(() => operation(lane.signal))),
        };
    }
}
async function runWithLease(guard, lease, operation) {
    const lane = startMaintenanceMutationLane(guard, lease);
    const operationOutcome = await captureOutcome(() => operation(lane));
    const renewalOutcome = await captureOutcome(() => lane.stop());
    const releaseOutcome = await captureOutcome(() => guard.releaseSessionMaintenance(lease));
    const failures = uniqueFailures([operationOutcome, renewalOutcome, releaseOutcome]);
    if (failures.length === 1)
        throw failures[0];
    if (failures.length > 1) {
        throw new AggregateError(failures, `Session maintenance mutation failed: ${lease.sessionId}`);
    }
    if (!operationOutcome.ok)
        throw operationOutcome.error;
    return operationOutcome.value;
}
function startMaintenanceMutationLane(guard, lease) {
    let timer;
    let renewalInFlight;
    let scheduledRenewal;
    let renewalFailure;
    let stopped = false;
    const controller = new AbortController();
    const performRenewal = async () => {
        const outcome = await captureOutcome(() => guard.renewSessionMaintenance(lease));
        if (!outcome.ok && !renewalFailure)
            renewalFailure = { error: outcome.error };
        else if (outcome.ok && !outcome.value && !renewalFailure) {
            renewalFailure = {
                error: new SessionServiceError('maintenance-lease-lost', `Session maintenance lease was lost: ${lease.sessionId}`),
            };
        }
        if (renewalFailure) {
            controller.abort(renewalFailure.error);
            throw renewalFailure.error;
        }
    };
    const renewNow = () => {
        if (renewalFailure)
            return Promise.reject(renewalFailure.error);
        if (renewalInFlight)
            return renewalInFlight;
        const renewal = performRenewal();
        const tracked = (async () => {
            try {
                await renewal;
            }
            finally {
                renewalInFlight = undefined;
            }
        })();
        renewalInFlight = tracked;
        return tracked;
    };
    async function renewAndSchedule() {
        try {
            await renewNow();
            schedule();
        }
        catch {
            // Renewal failure is retained and raised by the fenced lane.
        }
    }
    function schedule() {
        if (stopped || renewalFailure)
            return;
        timer = setTimeout(() => {
            timer = undefined;
            scheduledRenewal = renewAndSchedule();
        }, Math.max(1, lease.renewAfterMs));
        timer.unref?.();
    }
    schedule();
    return {
        signal: controller.signal,
        run: async (participant) => {
            await renewNow();
            const result = await participant();
            await renewNow();
            return result;
        },
        stop: async () => {
            stopped = true;
            if (timer)
                clearTimeout(timer);
            await scheduledRenewal;
            await renewalInFlight;
            if (renewalFailure)
                throw renewalFailure.error;
        },
    };
}
function uniqueFailures(outcomes) {
    return [...new Set(outcomes.flatMap((outcome) => (outcome.ok ? [] : [outcome.error])))];
}
async function captureOutcome(operation) {
    try {
        return { ok: true, value: await operation() };
    }
    catch (error) {
        return { ok: false, error };
    }
}
//# sourceMappingURL=maintenance-service.js.map