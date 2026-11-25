import { CodeHostRequestError } from './cli-runner.js';
const HOUR_MS = 3_600_000;
const BACKOFF_START_MS = 60_000;
const BACKOFF_MAX_MS = 600_000;
const SLOW_AFTER_TIMEOUTS = 3;
const TIMEOUT_POLL_MS = 300_000;
/** Share of the hourly budget after which background refresh slows down. */
const SLOWDOWN_SHARE = 0.8;
/** No caller reuses an answer older than this (project defaults, the longest, keep 10 minutes). */
const CACHE_MAX_AGE_MS = 10 * 60_000;
/** Answers kept per host, the newest; panel rounds with many query shapes stay bounded. */
const CACHE_MAX_ENTRIES = 200;
/**
 * How long ago `atMs` was. A time ahead of the clock means the clock was set
 * back since; it counts as long ago, so whatever was kept then is read again
 * instead of passing for fresh until the clock catches up.
 */
export function ageMs(atMs, nowMs) {
    return atMs > nowMs ? Number.POSITIVE_INFINITY : nowMs - atMs;
}
/**
 * Two lanes per host, one for user actions and one for background reads. Each
 * lane runs one task at a time, so a click never waits behind a slow background
 * read; a task that reads several pages may send a few requests at once.
 * Identical concurrent tasks share one run, results are cached briefly, and each
 * request a task sends counts against the host's hourly budget, shared by all
 * Sessions.
 */
export class CodeHostScheduler {
    options;
    hosts = new Map();
    constructor(options) {
        this.options = options;
    }
    async run(host, key, task, options) {
        const state = this.state(host);
        if (!options.force) {
            const cached = state.cache.get(key);
            const window = Math.min(options.cacheTtlMs, CACHE_MAX_AGE_MS);
            if (cached && ageMs(cached.atMs, this.options.nowMs()) < window)
                return cached.value;
            // Only an unforced request joins one in flight: that one may have left before
            // the change a forced request reads after.
            const pending = state.inflight.get(key);
            if (pending)
                return (await pending);
        }
        this.admit(state, options.priority);
        const run = this.enqueue(state, options.priority, async () => {
            // A user action goes out even inside the platform's backoff window, the same
            // way it goes out past the hourly budget: the user asked for it. The platform
            // answers with the wait it wants, which observeFailure records.
            if (options.priority !== 'user')
                this.assertNotRateLimited(state);
            const sentAtMs = this.options.nowMs();
            try {
                const value = await task();
                // A write or another call without a window is never reused, so it is not kept.
                if (options.cacheTtlMs > 0)
                    this.keep(state, key, value, sentAtMs);
                state.backoffMs = 0;
                state.consecutiveTimeouts = 0;
                // The platform accepted this request, so whatever limit was in force has lifted.
                state.rateLimitedUntilMs = undefined;
                return value;
            }
            catch (error) {
                this.observeFailure(state, error);
                throw error;
            }
        });
        state.inflight.set(key, run);
        try {
            return await run;
        }
        finally {
            // A forced request may have taken the key over while this one was in flight.
            if (state.inflight.get(key) === run)
                state.inflight.delete(key);
        }
    }
    /** Counts one request sent to the host against its hourly budget. */
    countRequest(host) {
        this.state(host).sentAtMs.push(this.options.nowMs());
    }
    usage(host) {
        const state = this.hosts.get(host);
        if (!state)
            return { requestsThisHour: 0 };
        const now = this.options.nowMs();
        this.prune(state, now);
        return {
            requestsThisHour: state.sentAtMs.length,
            ...(state.rateLimitedUntilMs !== undefined && state.rateLimitedUntilMs > now
                ? { rateLimitedUntilMs: state.rateLimitedUntilMs }
                : {}),
        };
    }
    /** When background refresh of these hosts should run again. */
    pollAfterMs(hosts, baseMs) {
        const now = this.options.nowMs();
        const budget = this.options.budgetPerHour();
        let delay = baseMs;
        for (const host of hosts) {
            const state = this.hosts.get(host);
            if (!state)
                continue;
            this.prune(state, now);
            if (state.rateLimitedUntilMs !== undefined && state.rateLimitedUntilMs > now) {
                delay = Math.max(delay, state.rateLimitedUntilMs - now);
            }
            const used = state.sentAtMs.length;
            if (used >= budget)
                delay = Math.max(delay, (state.sentAtMs[0] ?? now) + HOUR_MS - now);
            else if (used >= budget * SLOWDOWN_SHARE)
                delay = Math.max(delay, baseMs * 2);
            if (state.consecutiveTimeouts >= SLOW_AFTER_TIMEOUTS)
                delay = Math.max(delay, TIMEOUT_POLL_MS);
        }
        return Math.min(Math.max(delay, 1_000), HOUR_MS);
    }
    admit(state, priority) {
        // The hourly budget and the backoff are both our own bookkeeping; an explicit
        // user action overrides them and still counts against the budget.
        if (priority === 'user')
            return;
        this.assertNotRateLimited(state);
        const now = this.options.nowMs();
        this.prune(state, now);
        if (state.sentAtMs.length >= this.options.budgetPerHour()) {
            this.options.onBudgetSkip?.();
            throw new CodeHostRequestError('rate_limited', 'The hourly request budget for this host is used up', (state.sentAtMs[0] ?? now) + HOUR_MS - now);
        }
    }
    assertNotRateLimited(state) {
        const now = this.options.nowMs();
        if (state.rateLimitedUntilMs !== undefined && state.rateLimitedUntilMs > now) {
            throw new CodeHostRequestError('rate_limited', 'Waiting for the platform rate limit to reset', state.rateLimitedUntilMs - now);
        }
    }
    observeFailure(state, error) {
        if (!(error instanceof CodeHostRequestError))
            return;
        if (error.kind === 'timeout')
            state.consecutiveTimeouts += 1;
        if (error.kind !== 'rate_limited')
            return;
        state.backoffMs =
            error.retryAfterMs ??
                (state.backoffMs > 0 ? Math.min(state.backoffMs * 2, BACKOFF_MAX_MS) : BACKOFF_START_MS);
        state.rateLimitedUntilMs = this.options.nowMs() + state.backoffMs;
    }
    enqueue(state, lane, work) {
        const result = runAfter(state.tails[lane], work);
        state.tails[lane] = settle(result);
        return result;
    }
    /**
     * Caches an answer under the time its request left, unless the answer held was
     * sent later, and drops the ones nobody may reuse anymore, oldest first.
     */
    keep(state, key, value, sentAtMs) {
        const now = this.options.nowMs();
        const held = state.cache.get(key);
        if (held && held.atMs > sentAtMs && held.atMs <= now)
            return;
        state.cache.delete(key);
        state.cache.set(key, { value, atMs: sentAtMs });
        for (const [oldKey, entry] of state.cache) {
            if (state.cache.size <= CACHE_MAX_ENTRIES && ageMs(entry.atMs, now) < CACHE_MAX_AGE_MS)
                break;
            state.cache.delete(oldKey);
        }
    }
    prune(state, now) {
        const first = state.sentAtMs.findIndex((at) => ageMs(at, now) < HOUR_MS);
        if (first === -1)
            state.sentAtMs = [];
        else if (first > 0)
            state.sentAtMs = state.sentAtMs.slice(first);
    }
    state(host) {
        let state = this.hosts.get(host);
        if (!state) {
            state = {
                tails: { user: Promise.resolve(), background: Promise.resolve() },
                sentAtMs: [],
                backoffMs: 0,
                consecutiveTimeouts: 0,
                inflight: new Map(),
                cache: new Map(),
            };
            this.hosts.set(host, state);
        }
        return state;
    }
}
/** Starts work once the previous request settled; a failed predecessor does not stall the queue. */
async function runAfter(previous, work) {
    await previous;
    return work();
}
/** Resolves once the promise settles. Its own caller sees a failure; the queue only waits its turn. */
async function settle(promise) {
    try {
        await promise;
    }
    catch {
        // Reported to the caller of the queued request.
    }
}
//# sourceMappingURL=host-scheduler.js.map