export function settlementTransitionDecision(stage, reason, result) {
    if (result.status === 'stale') {
        return {
            stage,
            action: 'stale',
            reason: result.staleReason,
            ...(result.goal ? { goalId: result.goal.goalId } : {}),
        };
    }
    return {
        stage,
        action: 'settled',
        reason,
        goalId: result.goal.goalId,
        decisionEpoch: result.decisionEpoch,
    };
}
/**
 * Map one classified Turn failure onto the stop it should record.
 *
 * `usageRecoveryAtMs` is only consulted for an explicit account-quota stop, and
 * only when the provider actually supplied a trustworthy instant. Every other
 * failure — a plain rate limit, a safety block, an unknown provider fault —
 * records no schedule, which is what keeps automatic recovery restricted to the
 * one case where the wait is known rather than guessed.
 */
export function goalFailureTransition(failureClass, usageRecoveryAtMs) {
    if (failureClass === 'provider_quota') {
        return {
            status: 'usage_limited',
            statusReason: 'usage_limited(provider_quota)',
            ...(usageRecoveryAtMs !== undefined ? { usageRecoveryAtMs } : {}),
        };
    }
    if (failureClass === 'rate_limit') {
        return { status: 'usage_limited', statusReason: 'usage_limited(rate_limit)' };
    }
    if (failureClass === 'safety') {
        return { status: 'blocked', statusReason: 'blocked(safety_policy)' };
    }
    return { status: 'paused', statusReason: 'paused(infra_retryable)' };
}
//# sourceMappingURL=settlement-transitions.js.map