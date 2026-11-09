import { FAILOVER_FALLBACK_COOLDOWN_MS, FAILOVER_LONGEST_RATE_REST_MS, FAILOVER_LONGEST_RETRY_MS, FAILOVER_RATE_FORGET_MS, } from '../failover/pool-state.js';
/** Enough to keep every provider's keys; old entries go first. */
const POOL_LIMIT = 4096;
/**
 * In-memory state of BYOK keys, keyed `providerKey#keyId`: which key rests and why, and each key's
 * latest test. Nothing is persisted; a restart starts every key fresh, as the extension accounts'
 * in-memory rests do.
 */
export class ByokKeyPool {
    now;
    rests = new Map();
    /** The last rest per key, kept after it ends so a repeat soon after doubles it. */
    history = new Map();
    probes = new Map();
    constructor(now = Date.now) {
        this.now = now;
    }
    static slot(providerKey, keyId) {
        return `${providerKey}#${keyId}`;
    }
    /** The key's live rest, if any (an ended rest is dropped here). */
    rest(providerKey, keyId) {
        const slot = ByokKeyPool.slot(providerKey, keyId);
        const entry = this.rests.get(slot);
        if (!entry)
            return undefined;
        if (entry.until <= this.now()) {
            this.rests.delete(slot);
            return undefined;
        }
        return {
            reason: entry.reason,
            until: entry.until,
            ...(entry.status ? { status: entry.status } : {}),
        };
    }
    resting(providerKey, keyId) {
        return this.rest(providerKey, keyId) !== undefined;
    }
    /**
     * Rests a key. Without a vendor time: a minute, doubled for each repeat of the same reason
     * within 30 minutes of the last one ending, at most 10 minutes for a refused key and 30 for a
     * limit. A vendor time (Retry-After, a reset time) is honored when it is at least as long, as
     * Magpie's rateRest does. A key resting longer already keeps that rest (and its reason): a
     * probe of a used-up key that meets a brief 429 must not cut its hours to a minute. Returns the
     * end of the rest.
     */
    restKey(providerKey, keyId, reason, input = {}) {
        const now = this.now();
        const slot = ByokKeyPool.slot(providerKey, keyId);
        const n = this.repeats(slot, reason, now);
        const longest = reason === 'auth' ? FAILOVER_LONGEST_RETRY_MS : FAILOVER_LONGEST_RATE_REST_MS;
        const doubled = Math.min(longest, FAILOVER_FALLBACK_COOLDOWN_MS * 2 ** (n - 1));
        const until = Math.max(now + doubled, input.until ?? 0);
        const live = this.rests.get(slot);
        if (live && live.until > until)
            return live.until;
        const entry = {
            reason,
            until,
            n,
            ...(input.status ? { status: input.status } : {}),
        };
        this.bound(this.rests);
        this.bound(this.history);
        this.rests.set(slot, entry);
        this.history.set(slot, entry);
        return until;
    }
    /**
     * How many rests of this reason in a row, this one included: one more when the last ended
     * less than 30 minutes ago, the same while it still runs (the key was tried anyway).
     */
    repeats(slot, reason, now) {
        const previous = this.rests.get(slot) ?? this.history.get(slot);
        if (!previous || previous.reason !== reason)
            return 1;
        if (previous.until + FAILOVER_RATE_FORGET_MS <= now)
            return 1;
        return previous.n + (previous.until > now ? 0 : 1);
    }
    /** "Retry now", or the key's value changed: its rest, history and last test are gone. */
    clearKey(providerKey, keyId) {
        const slot = ByokKeyPool.slot(providerKey, keyId);
        this.rests.delete(slot);
        this.history.delete(slot);
        this.probes.delete(slot);
    }
    clearProvider(providerKey) {
        const prefix = `${providerKey}#`;
        for (const map of [this.rests, this.history, this.probes]) {
            for (const slot of [...map.keys()])
                if (slot.startsWith(prefix))
                    map.delete(slot);
        }
    }
    /** A key answered: whatever rest it had is over, and a later failure starts the doubling anew. */
    served(providerKey, keyId) {
        const slot = ByokKeyPool.slot(providerKey, keyId);
        this.rests.delete(slot);
        this.history.delete(slot);
    }
    recordProbe(providerKey, keyId, probe) {
        this.bound(this.probes);
        this.probes.set(ByokKeyPool.slot(providerKey, keyId), probe);
    }
    lastProbe(providerKey, keyId) {
        return this.probes.get(ByokKeyPool.slot(providerKey, keyId));
    }
    /** The first key, in order, that is not resting. */
    pick(providerKey, keys) {
        return keys.find((key) => !this.resting(providerKey, key.id));
    }
    /**
     * With every key resting, the one back soonest from a limit (not a refused key) is asked once:
     * its answer tells whether it is back. Undefined when a key is free or none qualifies.
     */
    probe(providerKey, keys) {
        let best;
        for (const key of keys) {
            const rest = this.rest(providerKey, key.id);
            if (!rest)
                return undefined;
            if (rest.reason === 'auth')
                continue;
            if (!best || rest.until < best.until)
                best = { key, until: rest.until };
        }
        return best?.key;
    }
    /** The soonest any of these keys is back, Unix ms. */
    earliestBack(providerKey, keys) {
        let earliest;
        for (const key of keys) {
            const rest = this.rest(providerKey, key.id);
            if (rest && (earliest === undefined || rest.until < earliest))
                earliest = rest.until;
        }
        return earliest;
    }
    bound(map) {
        while (map.size >= POOL_LIMIT) {
            const oldest = map.keys().next().value;
            if (oldest === undefined)
                return;
            map.delete(oldest);
        }
    }
}
/**
 * One pool per process: the resolver that routes requests and the management service that shows
 * and tests keys must see the same rests.
 */
let sharedPool;
export function sharedByokKeyPool() {
    sharedPool ??= new ByokKeyPool();
    return sharedPool;
}
//# sourceMappingURL=key-pool.js.map