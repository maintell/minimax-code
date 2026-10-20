/** Normalize observed and committed usage with the same nonnegative integer contract. */
export function sanitizeUsageCounter(value) {
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}
//# sourceMappingURL=usage-counter.js.map