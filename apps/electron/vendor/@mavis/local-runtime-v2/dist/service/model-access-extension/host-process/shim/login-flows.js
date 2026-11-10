import { randomUUID } from 'node:crypto';
import { captureHostContext } from './context.js';
import { captureLoginFlow, captureLoginValues, captureLoginView, captureNextLoginView, captureOwnedLoginResult, ModelAccessLoginError, observeLoginResult, } from '../../login/validation.js';
const MAX_FLOWS = 128;
const MAX_VIEWS = 128;
const FLOW_TIMEOUT_MS = 10 * 60_000;
/** Child owns computation and discarded-result cleanup, never the host credential store. */
export class ChildLoginFlows {
    epoch;
    send;
    flows = new Map();
    observed = new Map();
    closed = false;
    constructor(epoch, send) {
        this.epoch = epoch;
        this.send = send;
    }
    async begin(value, signal, extension, manifest) {
        const params = captureBegin(value);
        if (this.closed || this.flows.size >= MAX_FLOWS)
            throw error('login_busy');
        const { method, provider, handler, providerHandler } = loginHandlers(params, extension, manifest);
        signal.throwIfAborted();
        const controller = new AbortController();
        let settle;
        const settled = new Promise((resolve) => {
            settle = resolve;
        });
        const abort = () => {
            this.observe(this.cancelState(state));
        };
        const state = {
            ref: `${this.epoch}:${randomUUID()}`,
            params,
            schema: provider.credentialSchema,
            provider: providerHandler,
            controller,
            settled,
            settle,
            context: Object.freeze({
                ...params.context,
                enabledTargets: params.context.enabledTargets ?? [],
                policyRevision: params.context.policyRevision ?? 0,
                signal: controller.signal,
                updateLoginView: (view) => this.update(state, view),
            }),
            views: [],
            seq: 0,
            subscribed: false,
            submitting: false,
            beginDone: false,
            resultDone: false,
            cleanupDone: false,
            forgetDone: false,
            delivered: false,
            cancelled: false,
            removeBeginAbort: () => signal.removeEventListener('abort', abort),
        };
        this.flows.set(state.ref, state);
        signal.addEventListener('abort', abort, { once: true });
        state.timer = setTimeout(abort, FLOW_TIMEOUT_MS);
        state.timer.unref();
        try {
            const returned = await handler.begin(state.context, Object.freeze({ ...params.input }));
            this.observe(observeLoginResult(returned));
            state.flow = captureLoginFlow(returned);
            // Observe before validating views so a cancelled/invalid begin cannot orphan a credential.
            state.result = this.observeResult(state, state.flow.result);
            const view = captureLoginView(state.flow.view, method.kind);
            validateSubmit(state, view);
            state.currentView ??= view;
            if (signal.aborted || state.cancelled)
                throw error('login_cancelled');
            // No events until login.result: that request proves the parent installed its listener.
            return { flowRef: state.ref, seq: 0, view, hasSubmit: Boolean(state.flow.submit) };
        }
        catch (cause) {
            if (!state.result)
                state.resultDone = true;
            this.observe(this.cancelState(state));
            throw cause;
        }
        finally {
            state.beginDone = true;
            this.prune(state);
        }
    }
    async submit(value, signal) {
        const state = this.require(value);
        if (!isRecord(value))
            throw error('login_invalid');
        this.assertWaiting(state);
        if (!state.flow?.submit || state.submitting)
            throw error('login_not_waiting');
        const values = captureLoginValues(state.currentView, value.values);
        signal.throwIfAborted();
        state.submitting = true;
        const abort = () => {
            this.observe(this.cancelState(state));
        };
        signal.addEventListener('abort', abort, { once: true });
        try {
            await state.flow.submit(values);
            if (state.cancelled || signal.aborted)
                throw error('login_cancelled');
            return null;
        }
        finally {
            signal.removeEventListener('abort', abort);
            state.submitting = false;
            this.prune(state);
        }
    }
    async result(value, signal) {
        const state = this.require(value);
        if (state.cancelled || state.subscribed || !state.result)
            throw error('login_not_waiting');
        state.subscribed = true;
        for (const item of state.views)
            this.sendView(state, item);
        state.views.length = 0;
        try {
            const outcome = await untilAborted(state.result, AbortSignal.any([signal, state.controller.signal]));
            if (state.cancelled || signal.aborted)
                throw error('login_cancelled');
            if (!outcome.ok)
                throw outcome.error;
            captureOwnedLoginResult(outcome.value, state.params.providerId, state.schema);
            // Marker and response share stdout order; secrets cross only in the result response.
            const seq = ++state.seq;
            this.send({ type: 'flow', flowRef: state.ref, seq, event: 'result' });
            return { seq, result: outcome.value };
        }
        catch (cause) {
            this.observe(this.cancelState(state));
            throw cause;
        }
    }
    async cancel(value) {
        if (!isRecord(value) ||
            !validRef(value.flowRef, this.epoch) ||
            !['delivered', 'discarded'].includes(String(value.disposition)))
            throw error('login_invalid');
        const state = this.flows.get(value.flowRef);
        if (!state)
            return null;
        if (value.disposition === 'delivered')
            state.delivered = true;
        await this.cancelState(state);
        return null;
    }
    async close() {
        this.closed = true;
        await Promise.allSettled([...this.flows.values()].map((state) => this.cancelState(state)));
    }
    async settled() {
        await Promise.all([...this.flows.values()].map((state) => state.settled));
    }
    update(state, value) {
        this.assertWaiting(state);
        const view = captureNextLoginView(value);
        if (view.kind === 'secret-form' && state.flow && !state.flow.submit)
            throw error('login_invalid');
        if (state.seq >= MAX_VIEWS)
            throw error('login_invalid');
        const item = { seq: ++state.seq, view };
        state.currentView = view;
        if (state.subscribed)
            this.sendView(state, item);
        else
            state.views.push(item);
    }
    sendView(state, item) {
        this.send({ type: 'flow', flowRef: state.ref, event: 'view', ...item });
    }
    resultArrived(state, outcome) {
        state.outcome = outcome;
        state.resultDone = true;
        if (state.cancelled)
            this.observe(this.forgetDiscarded(state));
        this.prune(state);
        return outcome;
    }
    async observeResult(state, work) {
        try {
            return this.resultArrived(state, { ok: true, value: await work });
        }
        catch (cause) {
            return this.resultArrived(state, { ok: false, error: cause });
        }
    }
    cancelState(state) {
        state.cancelled = true;
        state.controller.abort();
        state.removeBeginAbort();
        if (state.timer)
            clearTimeout(state.timer);
        state.views.length = 0;
        // begin may return late: cancellation must also run on the eventual flow object.
        const flow = state.flow;
        if (!flow)
            return Promise.resolve();
        state.cancellation ??= (async () => {
            // Publish the promise before extension cancellation can reenter this owner.
            await Promise.resolve();
            try {
                await flow.cancel();
            }
            finally {
                state.cleanupDone = true;
                await this.forgetDiscarded(state);
                this.prune(state);
            }
        })();
        return state.cancellation;
    }
    async forgetDiscarded(state) {
        const forget = state.provider.forget;
        if (state.delivered || !state.outcome?.ok || !forget)
            return;
        const value = state.outcome.value;
        if (!isRecord(value) || !Object.hasOwn(value, 'payload'))
            return;
        state.forgetting ??= (async () => {
            await Promise.resolve();
            try {
                await forget.call(state.provider, Object.freeze({
                    ...state.context,
                    signal: AbortSignal.timeout(5_000),
                    updateLoginView: undefined,
                }), {
                    kind: 'direct-owned',
                    providerKey: state.params.input.providerKey,
                    providerId: state.params.providerId,
                    installationId: state.params.context.installationId,
                }, value.payload);
            }
            finally {
                state.forgetDone = true;
                this.prune(state);
            }
        })();
        await state.forgetting;
    }
    prune(state) {
        if (state.cancelled &&
            state.beginDone &&
            state.resultDone &&
            !state.submitting &&
            (!state.forgetting || state.forgetDone) &&
            (state.cleanupDone || !state.flow)) {
            this.flows.delete(state.ref);
            state.settle();
        }
    }
    assertWaiting(state) {
        if (state.cancelled || state.resultDone)
            throw error('login_not_waiting');
    }
    require(value) {
        if (!isRecord(value) || !validRef(value.flowRef, this.epoch))
            throw error('login_invalid');
        const state = this.flows.get(value.flowRef);
        if (!state)
            throw error('login_missing');
        return state;
    }
    observe(work) {
        this.observed.set(work, this.observeSettlement(work));
    }
    async observeSettlement(work) {
        try {
            await work;
        }
        catch {
            /* The host tracks cancellation; private cleanup errors never cross stdout. */
        }
        finally {
            this.observed.delete(work);
        }
    }
}
function captureBegin(value) {
    if (!isRecord(value) || !isRecord(value.context) || !isRecord(value.input))
        throw error('login_invalid');
    const kind = value.kind;
    if (kind !== 'browser-pkce' && kind !== 'device-code' && kind !== 'secret-form' && kind !== 'cli')
        throw error('login_invalid');
    return {
        kind,
        providerId: text(value.providerId),
        sourceId: text(value.sourceId),
        methodId: text(value.methodId),
        input: { providerKey: text(value.input.providerKey), target: text(value.input.target) },
        context: captureHostContext(value.context, 'login_invalid'),
    };
}
function text(value, maximum = 256) {
    if (typeof value !== 'string' || !value || value.length > maximum)
        throw error('login_invalid');
    return value;
}
function loginHandlers(params, extension, manifest) {
    const source = manifest.sources.find((item) => item.id === params.sourceId);
    const method = source?.capabilities.login?.methods.find((item) => item.id === params.methodId);
    const provider = manifest.providers.find((item) => item.id === params.providerId);
    const handler = extension.sources[params.sourceId]?.login?.[params.methodId];
    const providerHandler = extension.providers[params.providerId];
    if (!method || !provider || !handler || !providerHandler)
        throw error('login_invalid');
    validateMethod(params, method, provider);
    return { method, provider, handler, providerHandler };
}
function validateMethod(params, method, provider) {
    if (method.kind !== params.kind ||
        !method.targets.includes(params.input.target) ||
        !provider.credentialKinds.includes('direct-owned') ||
        !params.context.enabledTargets?.includes(params.input.target))
        throw error('login_invalid');
}
function validateSubmit(state, view) {
    if ((view.kind === 'secret-form' || state.views.some((item) => item.view.kind === 'secret-form')) &&
        !state.flow?.submit)
        throw error('login_invalid');
}
function validRef(value, epoch) {
    return typeof value === 'string' && value.startsWith(`${epoch}:`) && value.length <= 256;
}
function error(code) {
    return new ModelAccessLoginError(code);
}
function isRecord(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}
async function untilAborted(work, signal) {
    let abort;
    const cancelled = new Promise((_resolve, reject) => {
        abort = () => reject(error('login_cancelled'));
    });
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted)
        abort();
    try {
        return await Promise.race([work, cancelled]);
    }
    finally {
        signal.removeEventListener('abort', abort);
    }
}
//# sourceMappingURL=login-flows.js.map