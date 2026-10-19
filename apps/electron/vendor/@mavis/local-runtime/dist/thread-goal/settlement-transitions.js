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
export function goalFailureTransition(failureClass) {
    if (failureClass === 'provider_quota') {
        return { status: 'usage_limited', statusReason: 'usage_limited(provider_quota)' };
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