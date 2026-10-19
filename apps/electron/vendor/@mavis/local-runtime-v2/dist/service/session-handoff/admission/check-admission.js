import { SessionHandoffError } from '../errors.js';
export async function checkHandoffAdmission(options, state, localSessionId, query) {
    const { nowMs, readOnly = false, signal } = query;
    signal?.throwIfAborted();
    const existing = await state.getCurrentUploadOperation(localSessionId);
    if (existing && !terminalOperation(existing)) {
        if (existing.state === 'awaiting_approval' && (existing.expiresAtMs ?? 0) <= nowMs()) {
            if (!readOnly)
                await state.putUploadOperation({ ...existing, state: 'expired', updatedAtMs: nowMs() });
        }
        else {
            const reason = existing.state === 'awaiting_approval' || existing.state === 'recommending'
                ? 'proposal-pending'
                : 'in-progress';
            try {
                options.logger?.info({ localSessionId, state: existing.state, reason }, '[handoff-local-admission]');
            }
            catch {
                /* Diagnostic only. */
            }
            return reason;
        }
    }
    signal?.throwIfAborted();
    return checkCloudAdmission(options, localSessionId, signal);
}
async function checkCloudAdmission(options, localSessionId, signal) {
    const cloud = options.cloud;
    const identity = options.identity;
    if (!cloud?.preflight || !identity) {
        throw new SessionHandoffError('HANDOFF_UNAVAILABLE', 'Cloud handoff eligibility check is unavailable');
    }
    try {
        options.logger?.info({ localSessionId, reason: 'check-cloud' }, '[handoff-local-admission]');
    }
    catch {
        /* Diagnostic only. */
    }
    const deviceId = await identity.getDeviceId();
    signal?.throwIfAborted();
    return signal
        ? cloud.preflight(deviceId, localSessionId, signal)
        : cloud.preflight(deviceId, localSessionId);
}
export function terminalOperation(operation) {
    return (operation.state === 'completed' || operation.state === 'failed' || operation.state === 'expired');
}
//# sourceMappingURL=check-admission.js.map