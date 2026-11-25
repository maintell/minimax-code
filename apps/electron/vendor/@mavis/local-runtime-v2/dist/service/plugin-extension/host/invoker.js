import { ExtensionError } from '../sdk/diagnostics.js';
import { TREE_PROFILE_SPECS } from '@mavis/shared/plugin-extension';
import { LayerAborted, LayerError } from './dispatcher.js';
import { callAllowed, realmKeyOf } from './protocol.js';
import { RealmLoadError } from './supervisor.js';
/**
 * Issues Invocations (two.md §0, §2.4): loads the realm when a revision is prepared (again on first
 * use after a Worker rebuild), stamps identity per call id, forwards `next` into the fold and serves
 * cross-thread `ctx` calls while pausing own-time.
 */
const HOST_CALL_METHODS = new Set([
    'agent.list',
    'agent.spawn',
    'model.complete',
    'mcp.call',
    'store.get',
    'store.set',
    'store.delete',
    'store.keys',
    'ui.toast',
    'ui.open',
    'ui.close',
    'prompt.fill',
    'prompt.suggest',
    'prompt.read',
    'session.usage',
]);
function sameHook(left, right) {
    return (left.slot === right.slot &&
        JSON.stringify(sortMatcher(left.matcher)) === JSON.stringify(sortMatcher(right.matcher)));
}
function sortMatcher(matcher) {
    return Object.entries(matcher ?? {}).sort(([a], [b]) => a.localeCompare(b));
}
export class Invoker {
    deps;
    active = new Map();
    settlers = new Map();
    callSeq = 0;
    constructor(deps) {
        this.deps = deps;
    }
    /** Loads `input`'s revision and runs its `register`; a load failure throws `RealmLoadError`. */
    async load(input) {
        const realmKey = realmKeyOf(input.pluginId, input.artifact.digest);
        await this.ensureRealm(this.deps.supervisor.slotFor(input.pluginId), input, realmKey);
    }
    /**
     * Arena release of a replaced activation (two.md §11): its running Invocations settle, so a
     * continuation that resumes later gets `INVOCATION_SETTLED` and in-flight calls see the abort.
     */
    retire(activation) {
        for (const [callId, invocation] of [...this.active]) {
            if (invocation.activation !== activation)
                continue;
            this.active.delete(callId);
            this.settlers.get(callId)?.abort('retired');
        }
    }
    async invoke(request) {
        const { activation } = request;
        let session;
        const resume = request.budget.pause();
        let onAbort = () => undefined;
        try {
            const aborted = new Promise((_resolve, reject) => {
                onAbort = () => reject(new LayerAborted(String(request.signal.reason)));
                if (request.signal.aborted)
                    onAbort();
                else
                    request.signal.addEventListener('abort', onAbort, { once: true });
            });
            session = await Promise.race([
                aborted,
                this.deps.services.sessionFacts(activation.input.sessionId),
            ]);
        }
        catch (error) {
            if (error instanceof LayerAborted)
                throw error;
            throw new LayerError('EXTENSION_REQUEST_INVALID', `session facts unavailable: ${error instanceof Error ? error.message : String(error)}`);
        }
        finally {
            request.signal.removeEventListener('abort', onAbort);
            resume();
        }
        const { pluginId } = activation.input;
        const slot = this.deps.supervisor.slotFor(pluginId);
        const info = await this.loadRealm(slot, activation, request.budget);
        const target = this.targetOf(request.target, info);
        const snapshot = this.deps.services.state.snapshot(activation.input);
        this.callSeq += 1;
        const callId = this.callSeq;
        const settled = new AbortController();
        const forward = () => settled.abort(request.signal.reason);
        request.signal.addEventListener('abort', forward, { once: true });
        const identity = this.identity(request, callId, settled.signal);
        this.active.set(callId, {
            identity,
            activation,
            budget: request.budget,
            writable: request.writable,
            breakerKey: request.breakerKey,
            slot,
        });
        this.settlers.set(callId, settled);
        try {
            const invocation = await slot.invoke(this.wire(request, callId, { target, state: snapshot.values, session }), this.handlers(callId, request), request.signal);
            const deps = (invocation.reads ?? []).map((key) => ({
                pluginId,
                key,
                version: snapshot.versions[key],
            }));
            return { invocation, deps };
        }
        finally {
            this.active.delete(callId);
            this.settlers.delete(callId);
            request.signal.removeEventListener('abort', forward);
            settled.abort('settled');
        }
    }
    async loadRealm(slot, activation, budget) {
        const resume = budget.pause();
        try {
            return await this.ensureRealm(slot, activation.input, activation.realmKey);
        }
        catch (error) {
            if (!(error instanceof RealmLoadError))
                throw error;
            this.deps.events.realmRejected(activation, error.wire);
            throw new LayerError(error.wire.code, error.wire.message);
        }
        finally {
            resume();
        }
    }
    async ensureRealm(slot, input, realmKey) {
        const fresh = !slot.hasRealm(realmKey);
        const info = await slot.ensureRealm({
            realmKey,
            pluginId: input.pluginId,
            // `ctx.plugin.version` is the revision the realm runs.
            version: input.artifact.digest,
            code: input.artifact.code,
            expected: input.artifact.hooks,
            calls: input.artifact.calls,
        });
        if (fresh && info.state)
            this.deps.services.state.declare(input.pluginId, input.artifact.digest, info.state);
        return info;
    }
    targetOf(target, info) {
        if (target.type !== 'expected')
            return target;
        const index = info.hooks.findIndex((hook) => sameHook(hook, target.hook));
        if (index < 0)
            throw new LayerError('EXTENSION_ENTRY_MISMATCH', `${target.hook.slot} hook is not registered`);
        return { type: 'hook', index };
    }
    identity(request, callId, signal) {
        const { input } = request.activation;
        return {
            callId,
            kind: request.kind,
            pluginId: input.pluginId,
            source: input.source,
            artifactDigest: input.artifact.digest,
            tier: input.tier,
            sessionId: input.sessionId,
            ...(request.site ? { slot: request.site.slot, key: request.site.key } : {}),
            signal,
        };
    }
    wire(request, callId, input) {
        const profile = request.render?.spec.treeProfile;
        return {
            callId,
            kind: request.kind,
            realmKey: request.activation.realmKey,
            sessionId: request.activation.input.sessionId,
            session: input.session,
            target: input.target,
            ...(request.event === undefined ? {} : { event: request.event }),
            ...(request.args ? { args: request.args } : {}),
            ...(request.render ? { renderSeq: request.render.renderSeq } : {}),
            ...(profile ? { limits: TREE_PROFILE_SPECS[profile].limits } : {}),
            state: input.state,
            writable: request.writable,
            breakerKey: request.breakerKey,
        };
    }
    handlers(callId, request) {
        return {
            onNext: async (event) => {
                if (!request.onNext)
                    throw new LayerError('EXTENSION_REQUEST_INVALID', 'next outside a render');
                return (await request.onNext(event));
            },
            onCtx: (method, args, signal) => this.handleCtx(callId, method, args, signal),
            onNotify: (method, args) => this.handleNotify(callId, method, args),
        };
    }
    async handleCtx(callId, method, args, signal) {
        const invocation = this.active.get(callId);
        if (!invocation)
            throw new ExtensionError('INVOCATION_SETTLED');
        const server = method === 'mcp.call' && typeof args[0] === 'string' ? args[0] : undefined;
        if (!callAllowed(invocation.activation.input.artifact.calls, method, server)) {
            this.deps.ledger.recordFailure(invocation.breakerKey);
            throw new ExtensionError('CALL_NOT_DECLARED', method);
        }
        const resume = invocation.budget.pause();
        // A cancelled request is already settled in the Worker and the plugin runs on: its own-time
        // counts again at once, even if the service is slow to notice the abort.
        signal.addEventListener('abort', resume, { once: true });
        try {
            return await this.dispatchCtx(invocation, method, args, signal);
        }
        finally {
            signal.removeEventListener('abort', resume);
            resume();
        }
    }
    async dispatchCtx(invocation, method, args, signal) {
        // `state.update` arrives with the value its function computed in the realm.
        if (method === 'state.set' || method === 'state.update') {
            if (!invocation.writable)
                throw new ExtensionError('STATE_WRITE_IN_RENDER');
            const [key, value] = args;
            if (typeof key !== 'string' || value === undefined)
                throw new LayerError('EXTENSION_REQUEST_INVALID', `${method}(key, value)`);
            await this.deps.services.state.set(invocation.identity, key, value);
            this.deps.events.stateWritten(invocation.identity, key);
            return undefined;
        }
        if (!HOST_CALL_METHODS.has(method))
            throw new LayerError('EXTENSION_REQUEST_INVALID', `unknown ctx method ${method}`);
        return this.deps.services.call(invocation.identity, method, args, signal);
    }
    handleNotify(callId, method, args) {
        const invocation = this.active.get(callId);
        if (!invocation)
            return;
        if (method === 'ui.invalidate') {
            this.deps.events.invalidated(invocation);
        }
        else if (method === 'calls.violation') {
            this.deps.events.callViolation(invocation, String(args[0]));
        }
        else if (method === 'store.subscribe' && typeof args[0] === 'number') {
            this.deps.events.storeSubscribed(invocation, args[0]);
        }
    }
}
//# sourceMappingURL=invoker.js.map