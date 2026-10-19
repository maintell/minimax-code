export function isFutureQueueExpiry(expiresAt, nowMs) {
    return expiresAt === undefined || (Number.isFinite(expiresAt) && expiresAt > nowMs);
}
//# sourceMappingURL=policy.js.map