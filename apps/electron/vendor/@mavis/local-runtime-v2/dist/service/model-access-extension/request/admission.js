import { ModelAccessRequestError } from './validation.js';
/**
 * Per-account admission before a request goes to the vendor: a hard limit on requests out at
 * once (FIFO queue, no bound) and on requests per rolling minute. Ported in part from an
 * MIT-licensed project; see THIRD_PARTY_NOTICES.md. A waiting request never fails over for want of a slot and never rests the account;
 * it leaves the queue when its signal ends (cancellation or the call's deadline).
 */
const MODEL_ACCESS_MAX_CONCURRENCY = 1000;
const MODEL_ACCESS_MAX_RPM = 10_000;
/** The vendor counts a request when it arrives, a little later. */
const MODEL_ACCESS_RPM_SPAN_MS = 61_000;
function limit(value, maximum) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= maximum
        ? value
        : undefined;
}
/** A package's declared limits for one provider; invalid values mean "no limit". @internal */
export function captureProviderLimits(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return undefined;
    const item = value;
    const maxConcurrency = limit(item.maxConcurrency, MODEL_ACCESS_MAX_CONCURRENCY);
    const maxRequestsPerMinute = limit(item.maxRequestsPerMinute, MODEL_ACCESS_MAX_RPM);
    if (maxConcurrency === undefined && maxRequestsPerMinute === undefined)
        return undefined;
    return Object.freeze({
        ...(maxConcurrency === undefined ? {} : { maxConcurrency }),
        ...(maxRequestsPerMinute === undefined ? {} : { maxRequestsPerMinute }),
    });
}
/** The `providerLimits` export of an entry module, kept to the manifest's provider ids. */
export function captureModuleLimits(value, providerIds) {
    const result = Object.create(null);
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return result;
    for (const id of providerIds) {
        if (!Object.hasOwn(value, id))
            continue;
        const captured = captureProviderLimits(value[id]);
        if (captured)
            result[id] = captured;
    }
    return result;
}
/**
 * Limits travel beside a registered provider's handlers rather than inside them: the host's
 * extension validation accepts only handler functions, and copies the tables it validates while
 * keeping each function. The provider's `bindTransport` function is therefore a stable key for
 * the generation it belongs to (in-process module or subprocess proxy alike).
 */
const limitsByHandler = new WeakMap();
export function noteProviderLimits(handlers, limits) {
    for (const [id, handler] of Object.entries(handlers)) {
        const captured = captureProviderLimits(limits[id]);
        if (captured)
            limitsByHandler.set(handler.bindTransport, captured);
    }
}
export function providerLimitsOf(handler) {
    return handler ? limitsByHandler.get(handler.bindTransport) : undefined;
}
function stopped() {
    return new ModelAccessRequestError('request_closed');
}
/** Requests out at once per account, the rest wait first come first served. @internal */
export class ModelAccessLanes {
    lanes = new Map();
    /** Waits for a slot; resolves with its idempotent release. A limit of 0 takes no slot. */
    take(key, max, signal) {
        if (signal.aborted)
            return Promise.reject(stopped());
        let lane = this.lanes.get(key);
        if (max <= 0) {
            if (lane) {
                // The limit was lifted: whoever waits goes now.
                lane.limit = 0;
                this.grant(lane);
            }
            return Promise.resolve(() => { });
        }
        if (!lane) {
            lane = { limit: max, busy: 0, queue: [] };
            this.lanes.set(key, lane);
        }
        lane.limit = max;
        this.grant(lane);
        if (lane.busy < max && lane.queue.length === 0) {
            lane.busy += 1;
            return Promise.resolve(this.releaser(key, lane));
        }
        const owned = lane;
        return new Promise((resolve, reject) => {
            const granted = () => {
                signal.removeEventListener('abort', abort);
                resolve(this.releaser(key, owned));
            };
            const abort = () => {
                const index = owned.queue.indexOf(granted);
                if (index >= 0)
                    owned.queue.splice(index, 1);
                this.drop(key, owned);
                reject(stopped());
            };
            owned.queue.push(granted);
            signal.addEventListener('abort', abort, { once: true });
        });
    }
    /** Whether a request would be sent at once: no limit, or a free slot with nobody waiting. */
    free(key, max) {
        if (max <= 0)
            return true;
        const lane = this.lanes.get(key);
        return !lane || (lane.busy < max && lane.queue.length === 0);
    }
    /** Requests out and waiting (diagnostics and tests). */
    stats(key) {
        const lane = this.lanes.get(key);
        return { busy: lane?.busy ?? 0, waiting: lane?.queue.length ?? 0 };
    }
    releaser(key, lane) {
        let released = false;
        return () => {
            if (released)
                return;
            released = true;
            lane.busy -= 1;
            this.grant(lane);
            this.drop(key, lane);
        };
    }
    grant(lane) {
        while (lane.queue.length > 0 && (lane.limit <= 0 || lane.busy < lane.limit)) {
            lane.busy += 1;
            lane.queue.shift()();
        }
    }
    drop(key, lane) {
        if (lane.busy <= 0 && lane.queue.length === 0 && this.lanes.get(key) === lane)
            this.lanes.delete(key);
    }
}
/** Each request's time to go, past and to come, per account. */
export class ModelAccessRpm {
    now;
    span;
    times = new Map();
    constructor(now = Date.now, span = MODEL_ACCESS_RPM_SPAN_MS) {
        this.now = now;
        this.span = span;
    }
    /** Waits for room in the minute and counts the request; a limit of 0 counts nothing. */
    async wait(key, max, signal) {
        if (signal.aborted)
            throw stopped();
        if (max <= 0)
            return;
        const now = this.now();
        const at = this.reserve(key, max, now);
        const delay = at - now;
        if (delay <= 0)
            return;
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                signal.removeEventListener('abort', abort);
                resolve();
            }, delay);
            timer.unref?.();
            const abort = () => {
                clearTimeout(timer);
                // The place is given back: nothing is left to send it.
                this.giveBack(key, at);
                reject(stopped());
            };
            signal.addEventListener('abort', abort, { once: true });
        });
    }
    free(key, max) {
        if (max <= 0)
            return true;
        return this.prune(key, this.now()).length < max;
    }
    prune(key, now) {
        const kept = (this.times.get(key) ?? []).filter((at) => at > now - this.span);
        if (kept.length === 0)
            this.times.delete(key);
        else
            this.times.set(key, kept);
        return kept;
    }
    /** Now when the minute has room, else a minute after the max-th from the end. */
    reserve(key, max, now) {
        const times = this.prune(key, now);
        const at = times.length >= max ? Math.max(now, times[times.length - max] + this.span) : now;
        times.push(at);
        this.times.set(key, times);
        return at;
    }
    giveBack(key, at) {
        const times = this.times.get(key);
        if (!times)
            return;
        const index = times.lastIndexOf(at);
        if (index >= 0)
            times.splice(index, 1);
        if (times.length === 0)
            this.times.delete(key);
    }
}
/** Slot first, then room in the minute right before sending. */
export class ModelAccessAdmission {
    lanes = new ModelAccessLanes();
    rpm;
    constructor(now = Date.now, rpmSpanMs = MODEL_ACCESS_RPM_SPAN_MS) {
        this.rpm = new ModelAccessRpm(now, rpmSpanMs);
    }
    async admit(key, limits, signal) {
        const release = await this.lanes.take(key, limits?.maxConcurrency ?? 0, signal);
        try {
            await this.rpm.wait(key, limits?.maxRequestsPerMinute ?? 0, signal);
        }
        catch (error) {
            release();
            throw error;
        }
        return { release };
    }
    ready(key, limits) {
        return (this.lanes.free(key, limits?.maxConcurrency ?? 0) &&
            this.rpm.free(key, limits?.maxRequestsPerMinute ?? 0));
    }
}
//# sourceMappingURL=admission.js.map