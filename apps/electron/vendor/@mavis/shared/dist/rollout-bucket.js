/**
 * Stable per-user rollout hash shared by Desktop rollouts (desktop update
 * grayscale, the Bunny beta switch, the PTC remote default). One implementation
 * keeps a user in the same bucket across every rollout that reads
 * `userIdHashEndNumbers` or cuts its own percentage from `stableRolloutHash`.
 */
/**
 * The raw DJB2 hash every rollout bucket is cut from. Exported so a rollout that
 * needs a different number of buckets — the PTC remote default cuts 100 from it,
 * the desktop rollouts cut 10 — reuses this loop instead of copying it and
 * drifting into a different hash. Never change the loop: every bucket a user
 * already sits in was computed by it.
 */
export function stableRolloutHash(value) {
    let hash = 5381;
    for (let i = 0; i < value.length; i++) {
        hash = (hash << 5) + hash + value.charCodeAt(i);
        hash >>>= 0;
    }
    return hash;
}
/** Compute the stable DJB2 rollout bucket (0–9) for a real user ID. */
export function getBucketDigit(userId) {
    return stableRolloutHash(userId) % 10;
}
//# sourceMappingURL=rollout-bucket.js.map