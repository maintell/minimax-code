import { jsonEqual } from '@mavis/shared/plugin-extension';
import { collectHandles, deepFreeze, errorPlaceholder, guardLayerTree, } from './render/tree-guard.js';
/**
 * Layer fold (two.md §1.3) on the main thread. Layers run in a Worker through `run`; `next` comes
 * back here, so one chain may span several Workers in per-plugin isolation. Failure semantics:
 * before `next` the layer is skipped; after a successful `next` the inner result is kept (brief
 * R10 #1); inner rejections propagate without counting against the outer layer; aborts are never
 * swallowed.
 */
export const DEADLINE = 'deadline';
export const SUPERSEDED = 'superseded';
export const CRASHED = 'crashed';
export const CLOSED = 'closed';
export const EXPIRED = 'expired';
export const systemClock = {
    now: () => Date.now(),
    setTimeout: (callback, ms) => {
        const timer = setTimeout(callback, ms);
        timer.unref();
        return timer;
    },
    clearTimeout: (handle) => clearTimeout(handle),
};
/** Own-time (two.md §2.2): only plugin time counts; waits on `next` and `ctx` pause it. */
export class OwnTimeBudget {
    limitMs;
    clock;
    onExpire;
    used = 0;
    since;
    pauses = 0;
    timer;
    done = false;
    constructor(limitMs, clock, onExpire) {
        this.limitMs = limitMs;
        this.clock = clock;
        this.onExpire = onExpire;
    }
    start() {
        this.run();
    }
    /** The layer is waiting on the host (`next`, a `ctx` request, its realm or session facts). */
    get waiting() {
        return this.pauses > 0;
    }
    /** Returns an idempotent resume function. */
    pause() {
        this.pauses += 1;
        if (this.pauses === 1)
            this.halt();
        let resumed = false;
        return () => {
            if (resumed)
                return;
            resumed = true;
            this.pauses -= 1;
            if (this.pauses === 0)
                this.run();
        };
    }
    stop() {
        this.halt();
        this.done = true;
    }
    get ownMs() {
        const running = this.since === undefined ? 0 : this.clock.now() - this.since;
        return Math.round(this.used + running);
    }
    run() {
        if (this.done || this.since !== undefined)
            return;
        this.since = this.clock.now();
        this.timer = this.clock.setTimeout(() => this.expire(), Math.max(0, this.limitMs - this.used));
    }
    halt() {
        if (this.since === undefined)
            return;
        this.used += this.clock.now() - this.since;
        this.since = undefined;
        this.clock.clearTimeout(this.timer);
    }
    expire() {
        this.halt();
        this.done = true;
        this.onExpire();
    }
}
/** A layer failed; `fromInner` marks the rejection it received from `next`. */
export class LayerError extends Error {
    code;
    fromInner;
    constructor(code, message, fromInner = false) {
        super(message);
        this.code = code;
        this.fromInner = fromInner;
    }
}
/** The runner's signal fired or its Worker died. */
export class LayerAborted extends Error {
    reason;
    constructor(reason) {
        super(`layer aborted: ${reason}`);
        this.reason = reason;
    }
}
function failureOf(error) {
    if (error instanceof LayerError) {
        return { code: error.code, message: error.message, fromInner: error.fromInner };
    }
    if (error instanceof LayerAborted)
        return { code: 'aborted', message: error.message };
    return { code: 'thrown', message: error instanceof Error ? error.message : String(error) };
}
function isProps(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/** `next(e')` may only change `props`; envelope fields stay pinned by the host. */
function pinEnvelope(input, raw) {
    const props = isProps(raw) && isProps(raw.props) ? raw.props : input.props;
    return deepFreeze({ slot: input.slot, key: input.key, surface: input.surface, props });
}
function markInner(error) {
    if (error instanceof LayerAborted)
        return error;
    const failure = failureOf(error);
    return new LayerError(failure.code, failure.message, true);
}
class RenderFold {
    d;
    trace = [];
    core;
    abortReason;
    constructor(d) {
        this.d = d;
    }
    async run() {
        let tree;
        try {
            tree = await this.at(0, pinEnvelope(this.d.event, this.d.event));
        }
        catch (error) {
            tree = errorPlaceholder(undefined, failureOf(error).message);
        }
        return {
            tree,
            layers: this.trace.filter((layer) => layer !== undefined),
            ...(this.core ? { core: this.core } : {}),
            ...(this.abortReason ? { abortReason: this.abortReason } : {}),
        };
    }
    async at(index, event) {
        const layer = this.d.layers[index];
        if (!layer) {
            this.core = event;
            return this.d.core;
        }
        return this.layer(index, layer, event);
    }
    async layer(index, layer, input) {
        const st = {
            nextCalled: false,
            awaitingNext: false,
            hangingAtAbort: false,
            waitingAtAbort: false,
        };
        const ctl = new AbortController();
        const budget = new OwnTimeBudget(this.d.budgetMs, this.d.clock, () => ctl.abort(EXPIRED));
        const onRenderAbort = () => {
            // Waiting on `next` is the inner layer's time; waiting on the host is nobody's fault.
            st.waitingAtAbort = !st.awaitingNext && budget.waiting;
            st.hangingAtAbort = !st.awaitingNext && !budget.waiting;
            ctl.abort(this.d.signal.reason);
        };
        this.d.signal.addEventListener('abort', onRenderAbort, { once: true });
        budget.start();
        try {
            const next = async (event) => this.callNext({ index, input, st, budget }, event);
            const out = await this.d.run({ layer, event: input, signal: ctl.signal, budget, next });
            budget.stop();
            return this.accept(layer, out, st);
        }
        catch (error) {
            budget.stop();
            return await this.recover({ index, input, st, budget }, layer, error);
        }
        finally {
            this.d.signal.removeEventListener('abort', onRenderAbort);
            this.trace[index] = {
                plugin: layer.plugin,
                tier: layer.tier,
                calledNext: st.nextCalled,
                outcome: st.outcome ?? 'rejected',
                ownMs: budget.ownMs,
            };
        }
    }
    async callNext(frame, raw) {
        const { st } = frame;
        if (st.nextCalled)
            throw new LayerError('EXTENSION_NEXT_TWICE', 'next called twice');
        st.nextCalled = true;
        st.awaitingNext = true;
        const resume = frame.budget.pause();
        const inner = this.at(frame.index + 1, pinEnvelope(frame.input, raw));
        st.inner = this.track(st, inner);
        try {
            return await inner;
        }
        catch (error) {
            throw markInner(error);
        }
        finally {
            st.awaitingNext = false;
            resume();
        }
    }
    async track(st, inner) {
        try {
            st.innerValue = await inner;
            st.innerOk = true;
        }
        catch {
            st.innerOk = false;
        }
    }
    accept(layer, out, st) {
        const allowed = st.innerOk ? collectHandles(st.innerValue) : new Set();
        const guarded = guardLayerTree(out.tree, layer.plugin, new Set(out.own), allowed);
        if (guarded.forged > 0) {
            this.d.onFailure(layer, {
                code: 'EXTENSION_HANDLE_FORGED',
                message: `${guarded.forged} subtree(s) carried a handle this layer did not issue`,
            });
        }
        st.outcome = st.innerOk && jsonEqual(guarded.tree, st.innerValue) ? 'passthrough' : 'returned';
        return guarded.tree;
    }
    async recover(frame, layer, error) {
        const { st } = frame;
        if (error instanceof LayerAborted && error.reason !== EXPIRED)
            this.aborted(layer, st, error);
        const failure = failureOf(error);
        if (failure.fromInner) {
            st.outcome = 'rejected';
            throw error;
        }
        const expired = error instanceof LayerAborted;
        this.d.onFailure(layer, expired ? { code: 'EXTENSION_HOOK_EXPIRED', message: 'own-time budget exceeded' } : failure);
        if (!st.nextCalled) {
            st.outcome = expired ? 'expired' : 'skipped';
            return this.at(frame.index + 1, frame.input);
        }
        await st.inner;
        if (st.innerOk && st.innerValue !== undefined) {
            st.outcome = 'kept';
            return st.innerValue;
        }
        st.outcome = 'rejected';
        throw error;
    }
    aborted(layer, st, error) {
        this.abortReason ??= error.reason;
        if (error.reason === DEADLINE && st.hangingAtAbort) {
            st.outcome = 'expired';
            this.d.onFailure(layer, {
                code: 'EXTENSION_RENDER_DEADLINE',
                message: 'render deadline exceeded',
            });
        }
        else if (error.reason === DEADLINE && st.waitingAtAbort) {
            st.outcome = 'timed-out-waiting';
            this.d.onTimedOutWaiting(layer, {
                code: 'EXTENSION_RENDER_DEADLINE',
                message: 'render deadline exceeded while waiting on a host request',
            });
        }
        else {
            st.outcome = 'rejected';
        }
        throw error;
    }
}
export async function dispatchRender(dispatch) {
    return new RenderFold(dispatch).run();
}
/**
 * Gestures, menu items and callbacks (two.md §1.3 "能力调用族、交互族"): one layer, no fallback.
 * Returns the failure, or rethrows an abort that is not the layer's own budget.
 */
export async function dispatchGesture(dispatch) {
    const ctl = new AbortController();
    const forward = () => ctl.abort(dispatch.signal.reason);
    dispatch.signal.addEventListener('abort', forward, { once: true });
    const budget = new OwnTimeBudget(dispatch.budgetMs, dispatch.clock, () => ctl.abort(EXPIRED));
    budget.start();
    try {
        await dispatch.run({ signal: ctl.signal, budget });
        return undefined;
    }
    catch (error) {
        if (error instanceof LayerAborted && error.reason !== EXPIRED)
            throw error;
        const failure = error instanceof LayerAborted
            ? { code: 'EXTENSION_HOOK_EXPIRED', message: 'own-time budget exceeded' }
            : failureOf(error);
        dispatch.onFailure(dispatch.layer, failure);
        return failure;
    }
    finally {
        budget.stop();
        dispatch.signal.removeEventListener('abort', forward);
    }
}
//# sourceMappingURL=dispatcher.js.map