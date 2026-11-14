export function decideQuotaResetResume(result) {
    if (result.status === 'not-applicable')
        return { kind: 'skip', reason: 'quota-not-applicable' };
    if (result.status !== 'available')
        return { kind: 'skip', reason: 'quota-unavailable' };
    const { fiveHour, weekly } = result.windows;
    if (weekly.remainingPercent === 0)
        return { kind: 'skip', reason: 'weekly-window-exhausted' };
    if (weekly.remainingPercent === 'unknown')
        return { kind: 'skip', reason: 'quota-unavailable' };
    if (fiveHour.remainingPercent !== 0) {
        return { kind: 'skip', reason: 'five-hour-window-available' };
    }
    const delaySeconds = fiveHour.resetSeconds;
    if (delaySeconds === undefined || delaySeconds <= 0) {
        return { kind: 'skip', reason: 'reset-time-unavailable' };
    }
    return { kind: 'resume', delaySeconds };
}
export function isQuotaWindowRestored(result) {
    if (result.status !== 'available')
        return false;
    const { fiveHour, weekly } = result.windows;
    return hasRemainingQuota(fiveHour.remainingPercent) && hasRemainingQuota(weekly.remainingPercent);
}
function hasRemainingQuota(percent) {
    return percent === 'unlimited' || (typeof percent === 'number' && percent > 0);
}
//# sourceMappingURL=reset-decision.js.map