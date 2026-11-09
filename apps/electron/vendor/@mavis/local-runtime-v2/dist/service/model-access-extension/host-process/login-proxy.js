import { captureLoginValues, captureLoginView, captureNextLoginView, ModelAccessLoginError, } from '../login/validation.js';
/** A login's result observation is separate from begin/submit RPC and the parent's commit. */
export function createModelAccessHostLoginHandler(peer, options) {
    return {
        async begin(context, input) {
            context.signal.throwIfAborted();
            const initial = await peer.request('login.begin', {
                providerId: options.providerId,
                sourceId: options.sourceId,
                methodId: options.methodId,
                kind: options.kind,
                context: {
                    profileId: context.profileId,
                    installationId: context.installationId,
                    operationId: context.operationId,
                    generation: context.generation,
                    dataDir: context.dataDir,
                    hostDataDir: context.hostDataDir,
                    enabledTargets: context.enabledTargets,
                    policyRevision: context.policyRevision,
                },
                input,
            }, { signal: context.signal, timeoutMs: options.timeoutMs });
            if (!initial ||
                typeof initial.flowRef !== 'string' ||
                !initial.flowRef.startsWith(`${peer.epoch}:`) ||
                initial.flowRef.length > 256 ||
                initial.seq !== 0 ||
                typeof initial.hasSubmit !== 'boolean')
                throw new ModelAccessLoginError('login_invalid');
            try {
                const view = captureLoginView(initial.view, options.kind);
                if (view.kind === 'secret-form' && !initial.hasSubmit)
                    throw new ModelAccessLoginError('login_invalid');
                return new RemoteLoginFlow(peer, options, context, { ...initial, view }).open();
            }
            catch (cause) {
                await peer.request('login.cancel', { flowRef: initial.flowRef, disposition: 'discarded' });
                throw cause;
            }
        },
    };
}
class RemoteLoginFlow {
    peer;
    options;
    context;
    initial;
    observed = new Map();
    result;
    resolve;
    reject;
    resultController = new AbortController();
    stopListening = () => { };
    cancelWork;
    terminal = false;
    delivered = false;
    submitting = false;
    lastSeq = 0;
    resultSeq;
    onAbort = () => this.fail(new ModelAccessLoginError('login_cancelled'));
    start;
    view;
    constructor(peer, options, context, initial) {
        this.peer = peer;
        this.options = options;
        this.context = context;
        this.initial = initial;
        this.view = initial.view;
        this.result = new Promise((resolve, reject) => {
            this.resolve = resolve;
            this.reject = reject;
        });
        // The consumer may attach after begin resolves or after checking the initial view.
        this.observe(this.result);
    }
    open() {
        this.stopListening = this.peer.subscribeFlow(this.initial.flowRef, (event) => this.onEvent(event));
        this.context.signal.addEventListener('abort', this.onAbort, { once: true });
        const flow = Object.freeze({
            view: this.view,
            result: this.result,
            ...(this.initial.hasSubmit
                ? { submit: (values) => this.submit(values) }
                : {}),
            cancel: () => this.cancel(),
        });
        // Let login.service capture the returned flow/submit before queued form callbacks arrive.
        this.start = setImmediate(() => {
            this.start = undefined;
            if (!this.terminal)
                this.observe(this.observeResult());
        });
        if (this.context.signal.aborted)
            this.onAbort();
        return flow;
    }
    async observeResult() {
        const signal = AbortSignal.any([this.context.signal, this.resultController.signal]);
        const work = this.peer.request('login.result', {
            flowRef: this.initial.flowRef,
        }, { signal, timeoutMs: this.options.timeoutMs ?? 10 * 60_000 });
        try {
            const value = await work;
            if (this.terminal)
                return;
            if (!isLoginResultResponse(value, this.resultSeq)) {
                this.fail(new ModelAccessLoginError('login_invalid'));
                return;
            }
            if (this.context.signal.aborted) {
                this.onAbort();
                return;
            }
            this.delivered = true;
            this.terminal = true;
            this.unlisten();
            // After delivery, login.service owns validation, Keychain commit and late forget.
            this.resolve(value.result);
        }
        catch (cause) {
            if (!this.terminal)
                this.fail(cause instanceof Error ? cause : new ModelAccessLoginError('login_failed'));
        }
    }
    onEvent(event) {
        if (this.terminal)
            return;
        try {
            if (event.seq !== this.lastSeq + 1 || this.resultSeq !== undefined)
                throw new ModelAccessLoginError('login_invalid');
            this.lastSeq = event.seq;
            if (event.event === 'result') {
                this.resultSeq = event.seq;
                return;
            }
            const view = captureNextLoginView(event.view);
            if (view.kind === 'secret-form' && !this.initial.hasSubmit)
                throw new ModelAccessLoginError('login_invalid');
            this.context.updateLoginView?.(view);
            this.view = view;
        }
        catch {
            // The child cannot synchronously see parent expiry; mark terminal before reading any success.
            this.fail(new ModelAccessLoginError('login_invalidated'));
        }
    }
    async submit(values) {
        if (this.terminal || this.submitting)
            throw new ModelAccessLoginError('login_not_waiting');
        const captured = captureLoginValues(this.view, values);
        this.submitting = true;
        try {
            await this.peer.request('login.submit', { flowRef: this.initial.flowRef, values: captured }, {
                // Before result delivery, onAbort cancels this controller. After delivery the host's
                // finish() aborts its context too: only the explicit delivered cleanup may cancel then.
                signal: this.resultController.signal,
                timeoutMs: this.options.timeoutMs,
            });
            if (this.terminal && !this.delivered)
                throw new ModelAccessLoginError('login_cancelled');
        }
        catch (cause) {
            if (!this.terminal)
                this.fail(new ModelAccessLoginError('login_failed'));
            throw cause;
        }
        finally {
            this.submitting = false;
        }
    }
    cancel() {
        if (!this.terminal)
            this.fail(new ModelAccessLoginError('login_cancelled'));
        return this.cancelRemote();
    }
    fail(error) {
        if (this.terminal)
            return;
        this.terminal = true;
        this.unlisten();
        this.resultController.abort();
        this.reject(error);
        this.observe(this.cancelRemote());
    }
    cancelRemote() {
        this.cancelWork ??= this.sendCancellation();
        return this.cancelWork;
    }
    async sendCancellation() {
        if (!this.peer.closed) {
            await this.peer.request('login.cancel', {
                flowRef: this.initial.flowRef,
                disposition: this.delivered ? 'delivered' : 'discarded',
            }, { timeoutMs: 5_000 });
        }
    }
    unlisten() {
        this.stopListening();
        this.context.signal.removeEventListener('abort', this.onAbort);
        if (this.start)
            clearImmediate(this.start);
    }
    observe(work) {
        this.observed.set(work, this.observeSettlement(work));
    }
    async observeSettlement(work) {
        try {
            await work;
        }
        catch {
            /* The result/cancel caller observes the safe failure; no raw logs. */
        }
        finally {
            this.observed.delete(work);
        }
    }
}
function isLoginResultResponse(value, seq) {
    return !!value && value.seq === seq && !!value.result && typeof value.result === 'object';
}
//# sourceMappingURL=login-proxy.js.map