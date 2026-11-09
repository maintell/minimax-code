import { createHash } from 'node:crypto';
/**
 * Failover state. Cooldowns, unnamed-failure counts and refused sealed content live in memory
 * only. Session affinity (a session-id hash to a provider key) and revoked sign-in marks (a
 * provider key to its binding stamp) are handed to an optional store that keeps them in the
 * profile; no credential ever reaches it.
 * @internal Exported for focused tests.
 */
export const FAILOVER_SESSION_LIMIT = 2048;
/** The first rest after a failure nobody can name. */
export const FAILOVER_FALLBACK_COOLDOWN_MS = 60_000;
/** The longest such rest, however often it failed again. */
export const FAILOVER_LONGEST_RETRY_MS = 10 * 60_000;
/** The reason an unnamed-failure rest is recorded under. */
const FAILOVER_UNAVAILABLE_REASON = 'unavailable';
/** @internal Exported for focused tests. */
export const FAILOVER_SESSION_TTL_MS = 24 * 60 * 60_000;
/** The most a rate limit that keeps coming back is waited out. */
export const FAILOVER_LONGEST_RATE_REST_MS = 30 * 60_000;
/** A rate limit this long after the last rest ended starts at a minute again. */
export const FAILOVER_RATE_FORGET_MS = 30 * 60_000;
/** An account its vendor restricted is out until an appeal lifts it. */
const FAILOVER_RESTRICTED_REST_MS = 2 * 60 * 60_000;
/** Slow starts in a row that rest a model on an account. */
const FAILOVER_SLOW_RESTS = 2;
const FAILOVER_SLOW_FORGET_MS = 30 * 60_000;
const FAILOVER_RATE_REASON = 'rate-limit';
const FAILOVER_RESTRICTED_REASON = 'restricted';
const FAILOVER_SLOW_REASON = 'slow';
/** At most this many revoked sign-in marks are kept. */
const FAILOVER_REVOKED_LIMIT = 256;
/** A provider's usage reading is asked for at most this often per account. */
const FAILOVER_USAGE_PROBE_INTERVAL_MS = 60_000;
const REFUSED_LIMIT = 4096;
/**
 * What a reauth mark is tied to: the identity revision (a new login/borrow commit) and the
 * runtime credential-write count (a renewal). Either changing lifts the mark.
 */
export function bindingStamp(facts) {
    return `${facts.identityRevision}:${facts.credentialWrites ?? 0}`;
}
export function sealHash(value) {
    return createHash('sha256').update(value).digest('hex');
}
export class FailoverPoolState {
    now;
    store;
    members = new Map();
    models = new Map();
    reauth = new Map();
    /** The last rate-limit rest per member and how many came in a row. */
    rates = new Map();
    /** Slow starts in a row per member model. */
    slow = new Map();
    usageProbes = new Map();
    /** When each live rest was set (a call started before it may lift it by answering). */
    since = new WeakMap();
    sessions = new Map();
    served = new Map();
    refused = new Map();
    inflight = new Map();
    /** Unnamed failures in a row per member. */
    failures = new Map();
    constructor(now = Date.now, store) {
        this.now = now;
        this.store = store;
        this.restore();
    }
    coolMember(providerKey, until, reason) {
        const previous = this.memberCooldown(providerKey);
        // A longer rest already known is kept; a shorter one never shortens it.
        if (previous && previous.until >= until)
            return;
        const rest = { until, reason };
        this.since.set(rest, this.now());
        this.members.set(providerKey, rest);
    }
    /**
     * A minute when the vendor names no time, twice as long each time the member
     * is limited again within 30 minutes of its last rest ending, at most 30 minutes. Limited again
     * while still resting (the last one left, tried anyway) keeps the count. A time the vendor names
     * stands when it is at least that long. Returns the end of the rest.
     */
    rateLimitMember(providerKey, saidUntil) {
        const now = this.now();
        const previous = this.rates.get(providerKey);
        let n = 1;
        if (previous && now < previous.until)
            n = previous.n;
        else if (previous && now - previous.until < FAILOVER_RATE_FORGET_MS)
            n = previous.n + 1;
        let until = now +
            Math.min(FAILOVER_FALLBACK_COOLDOWN_MS * 2 ** Math.min(n - 1, 10), FAILOVER_LONGEST_RATE_REST_MS);
        if (saidUntil !== undefined && saidUntil >= until)
            until = saidUntil;
        this.rates.set(providerKey, { n, until });
        this.coolMember(providerKey, until, FAILOVER_RATE_REASON);
        return until;
    }
    /** Two hours, or the vendor's own longer time. */
    restrictMember(providerKey, saidUntil) {
        const until = Math.max(this.now() + FAILOVER_RESTRICTED_REST_MS, saidUntil ?? 0);
        this.coolMember(providerKey, until, FAILOVER_RESTRICTED_REASON);
        return until;
    }
    /**
     * A start with no first token is counted against the member's model; from the
     * second in a row that model rests there a minute, doubling each time, at most 10 minutes. One
     * alone rests nothing (a long prompt is slow anywhere). A slow start while it rests for one
     * keeps the count; 30 minutes without one starts a new run. Returns the rest's end, if any.
     */
    slowStart(providerKey, modelId) {
        const now = this.now();
        const key = modelKey(providerKey, modelId);
        const run = this.slow.get(key) ?? { n: 0, at: 0 };
        if (now - run.at >= FAILOVER_SLOW_FORGET_MS)
            run.n = 0;
        const resting = this.modelCooldown(providerKey, modelId)?.reason === FAILOVER_SLOW_REASON;
        if (!resting || run.n === 0)
            run.n += 1;
        run.at = now;
        this.slow.set(key, run);
        if (run.n < FAILOVER_SLOW_RESTS)
            return undefined;
        const until = now +
            Math.min(FAILOVER_FALLBACK_COOLDOWN_MS * 2 ** Math.min(run.n - FAILOVER_SLOW_RESTS, 10), FAILOVER_LONGEST_RETRY_MS);
        this.coolModel(providerKey, modelId, until, FAILOVER_SLOW_REASON);
        return this.modelCooldown(providerKey, modelId)?.until ?? until;
    }
    /**
     * A member that answered a call which started at `startedAt`: rests set before that call
     * began are over (it answered after them). Rests set while it ran are kept.
     */
    liftRestsBefore(providerKey, modelId, startedAt) {
        const own = this.memberCooldown(providerKey);
        if (own && (this.since.get(own) ?? 0) <= startedAt)
            this.members.delete(providerKey);
        const model = this.modelCooldown(providerKey, modelId);
        if (model && (this.since.get(model) ?? 0) <= startedAt)
            this.models.delete(modelKey(providerKey, modelId));
    }
    /**
     * Takes back a rest a failure set, and the unnamed failure it counted, when a mate's alike
     * failure said it was the request's. A rest set since, that isn't this one,
     * stays.
     */
    unrest(providerKey, rest) {
        if (this.members.get(providerKey) !== rest)
            return;
        this.members.delete(providerKey);
        const n = this.failures.get(providerKey) ?? 0;
        if (n > 1)
            this.failures.set(providerKey, n - 1);
        else
            this.failures.delete(providerKey);
    }
    /** A usage reading found the used-up window renewed: its quota rest ends now. */
    liftQuotaRest(providerKey, readAt) {
        const own = this.memberCooldown(providerKey);
        if (!own || own.reason !== 'quota' || (this.since.get(own) ?? 0) > readAt)
            return false;
        this.members.delete(providerKey);
        return true;
    }
    /** Whether a usage reading of this member may be asked for now; claims the slot when it may. */
    claimUsageProbe(providerKey) {
        const now = this.now();
        const last = this.usageProbes.get(providerKey);
        if (last !== undefined && now - last < FAILOVER_USAGE_PROBE_INTERVAL_MS)
            return false;
        this.usageProbes.set(providerKey, now);
        return true;
    }
    /**
     * A failure nobody can name rests the member 1 minute,
     * doubling with each failure in a row, at most 10 minutes. Returns the rest given.
     */
    backOffMember(providerKey) {
        const n = (this.failures.get(providerKey) ?? 0) + 1;
        this.failures.set(providerKey, n);
        const rest = Math.min(FAILOVER_FALLBACK_COOLDOWN_MS * 2 ** Math.min(n - 1, 10), FAILOVER_LONGEST_RETRY_MS);
        this.coolMember(providerKey, this.now() + rest, FAILOVER_UNAVAILABLE_REASON);
        return rest;
    }
    failureCount(providerKey) {
        return this.failures.get(providerKey) ?? 0;
    }
    /**
     * A member that answered starts over — its failure count and its
     * unnamed-failure rest go. Quota, credit, rate-limit and model rests keep their own end.
     */
    servedMember(providerKey, modelId) {
        this.failures.delete(providerKey);
        this.rates.delete(providerKey);
        if (this.members.get(providerKey)?.reason === FAILOVER_UNAVAILABLE_REASON)
            this.members.delete(providerKey);
        if (modelId === undefined)
            return;
        const key = modelKey(providerKey, modelId);
        this.slow.delete(key);
        if (this.models.get(key)?.reason === FAILOVER_SLOW_REASON)
            this.models.delete(key);
    }
    coolModel(providerKey, modelId, until, reason) {
        const key = modelKey(providerKey, modelId);
        const previous = this.modelCooldown(providerKey, modelId);
        if (previous && previous.until >= until)
            return;
        const rest = { until, reason };
        this.since.set(rest, this.now());
        this.models.set(key, rest);
    }
    memberCooldown(providerKey) {
        return live(this.members, providerKey, this.now());
    }
    modelCooldown(providerKey, modelId) {
        return live(this.models, modelKey(providerKey, modelId), this.now());
    }
    /** Every live cooldown of a member: its own and its models'. */
    cooldowns(providerKey) {
        const now = this.now();
        const out = [];
        const own = live(this.members, providerKey, now);
        if (own)
            out.push(own);
        for (const key of [...this.models.keys()]) {
            if (!key.startsWith(`${providerKey}\0`))
                continue;
            const entry = live(this.models, key, now);
            if (entry)
                out.push(entry);
        }
        return out;
    }
    /**
     * Marked at the binding stamp (binding + credential revision) that failed: a new sign-in or a
     * rotated credential clears it. `until` lets a source that changes outside MCode (a borrowed
     * CLI signing in again) be asked again later; Infinity waits for the stamp to change.
     */
    markReauth(providerKey, stamp, until = Infinity, revoked = false) {
        const wasRevoked = this.reauth.get(providerKey)?.revoked === true;
        // Only a direct sign-in waits for a new one (until Infinity); a borrowed one is asked again.
        const persistent = revoked && until === Infinity;
        this.reauth.set(providerKey, {
            stamp,
            until,
            at: this.now(),
            ...(persistent ? { revoked: true } : {}),
        });
        if (persistent || wasRevoked)
            this.persist();
    }
    /**
     * A member that answered a call begun at `startedAt`: an ordinary sign-in mark set before
     * then is over (the sign-in works). A revoked one waits for a new sign-in.
     */
    liftReauthBefore(providerKey, startedAt) {
        const marked = this.reauth.get(providerKey);
        if (marked && !marked.revoked && (marked.at ?? 0) <= startedAt)
            this.reauth.delete(providerKey);
    }
    needsReauth(providerKey, stamp) {
        const marked = this.reauth.get(providerKey);
        if (marked === undefined)
            return false;
        if (marked.stamp === stamp && this.now() < marked.until)
            return true;
        // A new sign-in (identity revision) or a renewal write moved the stamp: the mark is over.
        this.reauth.delete(providerKey);
        if (marked.revoked)
            this.persist();
        return false;
    }
    /** A direct sign-in the vendor revoked at this stamp: skipped even without a pool. */
    revoked(providerKey, stamp) {
        return this.needsReauth(providerKey, stamp) && this.reauth.get(providerKey)?.revoked === true;
    }
    boundMember(sessionId, primaryKey) {
        let key = sessionKey(sessionId, primaryKey);
        let entry = this.sessions.get(key);
        if (!entry) {
            // A binding restored from the profile is found by the session's hash, then re-keyed.
            const restored = sessionKey(`${HASHED_SESSION}${sealHash(sessionId)}`, primaryKey);
            entry = this.sessions.get(restored);
            if (entry) {
                this.sessions.delete(restored);
                this.sessions.set(key, entry);
            }
            key = sessionKey(sessionId, primaryKey);
        }
        if (!entry)
            return undefined;
        if (this.now() - entry.at > FAILOVER_SESSION_TTL_MS) {
            this.sessions.delete(key);
            return undefined;
        }
        return entry.member;
    }
    bindSession(sessionId, primaryKey, member) {
        const key = sessionKey(sessionId, primaryKey);
        const previous = this.sessions.get(key);
        this.sessions.delete(key);
        this.sessions.set(key, { member, at: this.now() });
        while (this.sessions.size > FAILOVER_SESSION_LIMIT) {
            const oldest = this.sessions.keys().next().value;
            if (oldest === undefined)
                break;
            this.sessions.delete(oldest);
        }
        // A store write per answered call: new bindings and member changes, else at most hourly.
        if (previous?.member !== member || this.now() - previous.at > FAILOVER_SESSION_TTL_MS / 24)
            this.persist();
        const served = this.served.get(key) ?? { at: 0, members: new Set() };
        served.at = this.now();
        served.members.add(member);
        this.served.delete(key);
        this.served.set(key, served);
        while (this.served.size > FAILOVER_SESSION_LIMIT) {
            const oldest = this.served.keys().next().value;
            if (oldest === undefined)
                break;
            this.served.delete(oldest);
        }
    }
    /** Whether another member of this pool already answered in this session (sealed state is theirs). */
    servedByOther(sessionId, primaryKey, member) {
        const entry = this.served.get(sessionKey(sessionId, primaryKey));
        if (!entry || this.now() - entry.at > FAILOVER_SESSION_TTL_MS)
            return false;
        return [...entry.members].some((item) => item !== member);
    }
    refusedSeals(sessionId, member) {
        const key = sessionKey(sessionId, member);
        const entry = this.refused.get(key);
        if (!entry)
            return new Set();
        if (this.now() - entry.at > FAILOVER_SESSION_TTL_MS) {
            this.refused.delete(key);
            return new Set();
        }
        return entry.seals;
    }
    addRefusedSeals(sessionId, member, hashes) {
        if (hashes.length === 0)
            return;
        const key = sessionKey(sessionId, member);
        const entry = this.refused.get(key) ?? { at: 0, seals: new Set() };
        entry.at = this.now();
        for (const hash of hashes)
            entry.seals.add(hash);
        this.refused.delete(key);
        this.refused.set(key, entry);
        while (this.refused.size > REFUSED_LIMIT) {
            const oldest = this.refused.keys().next().value;
            if (oldest === undefined)
                break;
            this.refused.delete(oldest);
        }
    }
    persist() {
        if (!this.store)
            return;
        const now = this.now();
        const sessions = [];
        for (const [key, entry] of this.sessions) {
            if (now - entry.at > FAILOVER_SESSION_TTL_MS)
                continue;
            const [sessionId, primaryKey] = splitKey(key);
            const hash = sessionId.startsWith(HASHED_SESSION)
                ? sessionId.slice(HASHED_SESSION.length)
                : sealHash(sessionId);
            sessions.push([hash, primaryKey, entry.member, entry.at]);
        }
        const revoked = [];
        for (const [key, mark] of this.reauth)
            if (mark.revoked)
                revoked.push([key, mark.stamp]);
        try {
            this.store.save({
                version: 1,
                sessions,
                revoked: revoked.slice(-FAILOVER_REVOKED_LIMIT),
            });
        }
        catch {
            /* Persistence is best effort; routing goes on from memory. */
        }
    }
    restore() {
        const saved = this.loadSaved();
        if (!saved)
            return;
        const now = this.now();
        for (const entry of Array.isArray(saved.sessions) ? saved.sessions : []) {
            const restored = restoredSession(entry, now);
            // Restored entries are keyed by the session hash (HASHED_SESSION marks them).
            if (restored)
                this.sessions.set(sessionKey(`${HASHED_SESSION}${restored.hash}`, restored.primaryKey), {
                    member: restored.member,
                    at: restored.at,
                });
        }
        this.trimSessions();
        const revoked = Array.isArray(saved.revoked) ? saved.revoked : [];
        for (const entry of revoked.slice(-FAILOVER_REVOKED_LIMIT)) {
            const mark = restoredRevocation(entry);
            if (mark)
                this.reauth.set(mark.key, { stamp: mark.stamp, until: Infinity, revoked: true });
        }
    }
    /** The persisted state, or nothing when it is missing, unreadable or of another version. */
    loadSaved() {
        try {
            const saved = this.store?.load();
            return saved?.version === 1 ? saved : undefined;
        }
        catch {
            return undefined;
        }
    }
    trimSessions() {
        while (this.sessions.size > FAILOVER_SESSION_LIMIT) {
            const oldest = this.sessions.keys().next().value;
            if (oldest === undefined)
                break;
            this.sessions.delete(oldest);
        }
    }
    inflightCount(providerKey) {
        return this.inflight.get(providerKey) ?? 0;
    }
    /** Counts one open member call; the returned release is idempotent. */
    acquire(providerKey) {
        this.inflight.set(providerKey, this.inflightCount(providerKey) + 1);
        let released = false;
        return () => {
            if (released)
                return;
            released = true;
            const next = this.inflightCount(providerKey) - 1;
            if (next > 0)
                this.inflight.set(providerKey, next);
            else
                this.inflight.delete(providerKey);
        };
    }
}
/** A persisted session pin that is well formed and still within its time to live. */
function restoredSession(entry, now) {
    if (!Array.isArray(entry) || entry.length !== 4)
        return undefined;
    const [hash, primaryKey, member, at] = entry;
    if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/u.test(hash))
        return undefined;
    if (!validKey(primaryKey) || !validKey(member) || !freshAt(at, now))
        return undefined;
    return { hash, primaryKey, member, at };
}
function freshAt(at, now) {
    return (typeof at === 'number' &&
        Number.isFinite(at) &&
        at <= now &&
        now - at <= FAILOVER_SESSION_TTL_MS);
}
/** A persisted revoked sign-in: a member key and its binding stamp. */
function restoredRevocation(entry) {
    if (!Array.isArray(entry) || entry.length !== 2)
        return undefined;
    const [key, stamp] = entry;
    if (!validKey(key) || typeof stamp !== 'string' || !/^\d{1,15}:\d{1,15}$/u.test(stamp))
        return undefined;
    return { key, stamp };
}
/** Prefix of a restored session entry's id (a hash, never a raw session id). */
const HASHED_SESSION = '\u0001sha256:';
const PROVIDER_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
function validKey(value) {
    return typeof value === 'string' && PROVIDER_KEY.test(value);
}
function splitKey(key) {
    const index = key.lastIndexOf('\0');
    return [key.slice(0, index), key.slice(index + 1)];
}
function modelKey(providerKey, modelId) {
    return `${providerKey}\0${modelId}`;
}
function sessionKey(sessionId, key) {
    return `${sessionId}\0${key}`;
}
function live(map, key, now) {
    const entry = map.get(key);
    if (!entry)
        return undefined;
    if (entry.until <= now) {
        map.delete(key);
        return undefined;
    }
    return entry;
}
//# sourceMappingURL=pool-state.js.map