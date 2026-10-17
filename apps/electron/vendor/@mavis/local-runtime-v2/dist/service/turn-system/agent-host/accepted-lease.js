const trustedAbortSignalBrand = captureAbortSignalBrand();
export function hasAcceptedLeaseIdentity(turn) {
    return [turn.sessionId, turn.turnId, turn.leaseId].every(isNonEmptyString);
}
export function isAbortSignalLike(value) {
    if (typeof value !== 'object' || value === null || !trustedAbortSignalBrand) {
        return false;
    }
    try {
        const aborted = Reflect.apply(trustedAbortSignalBrand.abortedGetter, value, []);
        if (typeof aborted !== 'boolean')
            return false;
        return (typeof Reflect.get(value, 'addEventListener') === 'function' &&
            typeof Reflect.get(value, 'removeEventListener') === 'function');
    }
    catch {
        return false;
    }
}
function captureAbortSignalBrand() {
    if (typeof AbortSignal === 'undefined')
        return undefined;
    const abortedGetter = Reflect.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')?.get;
    return abortedGetter ? { abortedGetter } : undefined;
}
function isNonEmptyString(value) {
    return typeof value === 'string' && Boolean(value.trim());
}
//# sourceMappingURL=accepted-lease.js.map