import { AsyncLocalStorage } from 'node:async_hooks';
import { isExtensionErrorCode, ExtensionError } from '../../sdk/diagnostics.js';
import { callAllowed, writeAttribution } from '../protocol.js';
import { deepFreeze } from '../render/tree-guard.js';
import { createActivationContext, toJson } from './context.js';
import { describeError, Realm } from './realm.js';
const systemTimers = {
    now: () => Date.now(),
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    setInterval: (callback, ms) => setInterval(callback, ms),
    clear: (handle) => {
        clearTimeout(handle);
        clearInterval(handle);
    },
};
const STALE = { code: 'EXTENSION_HANDLE_STALE', message: 'handle is no longer bound' };
export class RealmRuntime {
    port;
    attribution;
    options;
    realms = new Map();
    calls = new Map();
    pending = new Map();
    callbacks = new Map();
    running = new WeakSet();
    innerErrors = new WeakSet();
    /** The Invocation a realm call (and every async branch it starts) runs on behalf of. */
    current = new AsyncLocalStorage();
    requestSeq = 0;
    callbackSeq = 0;
    timers;
    generation;
    constructor(port, attribution, options = {}) {
        this.port = port;
        this.attribution = attribution;
        this.options = options;
        this.timers = options.timers ?? systemTimers;
        this.generation = options.generation ?? 0;
    }
    handle(message) {
        writeAttribution(this.attribution, 0, 0);
        switch (message.t) {
            case 'load':
                this.load(message);
                return;
            case 'invoke':
                this.start(message.inv);
                return;
            case 'reply':
                this.settleRequest(message);
                return;
            case 'abort':
                this.abort(message.callId);
                return;
            case 'ping':
                this.port.postMessage({ t: 'pong', n: message.n });
                return;
            default:
                this.manage(message);
        }
    }
    manage(message) {
        const entry = this.realms.get(message.realmKey);
        if (message.t === 'release') {
            entry?.realm.release(message.renderSeqs);
            return;
        }
        if (message.t === 'drop-session') {
            entry?.realm.dropSession(message.sessionId);
            this.dropCallbacks((callback) => callback.realmKey === message.realmKey && callback.sessionId === message.sessionId);
            return;
        }
        this.realms.delete(message.realmKey);
        this.dropCallbacks((callback) => callback.realmKey === message.realmKey);
    }
    load(message) {
        writeAttribution(this.attribution, message.realmNo, -1);
        try {
            const realm = new Realm({
                realmNo: message.realmNo,
                pluginId: message.pluginId,
                version: message.version,
                code: message.code,
                expected: message.expected,
                slots: message.slots,
                syncTimeoutMs: message.syncTimeoutMs,
                onConsole: (level, text) => {
                    this.port.postMessage({ t: 'console', realmKey: message.realmKey, level, text });
                },
                ...(this.options.modules ? { modules: this.options.modules } : {}),
            });
            const base = {
                key: message.realmKey,
                calls: message.calls,
                minClockIntervalMs: message.minClockIntervalMs,
            };
            this.realms.set(message.realmKey, {
                ...base,
                realmNo: message.realmNo,
                realm,
                ctx: createActivationContext({ id: message.pluginId, version: message.version }, this.bridge(base)),
            });
            const hooks = realm.hooks.map(({ slot, matcher }) => matcher ? { slot, matcher } : { slot });
            this.port.postMessage({
                t: 'loaded',
                id: message.id,
                ok: true,
                hooks,
                ...(realm.stateDefaults ? { state: realm.stateDefaults } : {}),
            });
        }
        catch (error) {
            this.port.postMessage({
                t: 'loaded',
                id: message.id,
                ok: false,
                error: this.toWireError(error),
            });
        }
        finally {
            writeAttribution(this.attribution, 0, 0);
        }
    }
    /** `invoke` never rejects; the weak set only keeps the floating-promise rule honest. */
    start(wire) {
        this.running.add(this.invoke(wire));
    }
    async invoke(wire) {
        const entry = this.realms.get(wire.realmKey);
        if (!entry) {
            this.post(wire.callId, {
                ok: false,
                error: { code: 'EXTENSION_REALM_NOT_LOADED', message: wire.realmKey },
            });
            return;
        }
        const call = {
            live: liveInvocation(wire),
            entry,
            nextCalled: false,
            aborted: false,
        };
        this.calls.set(wire.callId, call);
        try {
            const target = this.target(call, wire);
            writeAttribution(this.attribution, entry.realmNo, call.live.hookRef);
            const value = await this.current.run(call.live, () => entry.realm.call(target.fn, target.args));
            if (!call.aborted)
                this.post(wire.callId, this.finish(call, wire, value));
        }
        catch (error) {
            if (!call.aborted) {
                const thrown = entry.realm.hostValue(error);
                this.post(wire.callId, { ok: false, error: this.toWireError(thrown) });
            }
        }
        finally {
            call.live.settled = true;
            this.calls.delete(wire.callId);
            writeAttribution(this.attribution, 0, 0);
        }
    }
    target(call, wire) {
        const { entry } = call;
        const target = wire.target;
        if (target.type === 'hook')
            return this.hookTarget(call, wire, entry.ctx, target.index);
        const fn = target.type === 'handle'
            ? entry.realm.callbackFor(target.renderSeq, target.handle)
            : this.takeCallback(target.id);
        if (!fn)
            throw new WireFailure(STALE);
        // Callbacks get only their own values (`onInput(value)`, `onDidChange(change)`); `ctx` is the
        // hook's, from the closure.
        return { fn, args: wire.args ?? [] };
    }
    hookTarget(call, wire, ctx, index) {
        const hook = call.entry.realm.hooks[index];
        if (!hook)
            throw new WireFailure(STALE);
        const event = deepFreeze(toJson(wire.event ?? null, 'event'));
        if (wire.kind !== 'render')
            return { fn: hook.fn, args: [ctx, event] };
        return {
            fn: hook.fn,
            args: [ctx, event, (next) => this.next(call, next ?? event)],
        };
    }
    /** One-shot timers are consumed by their Invocation; intervals and listeners stay. */
    takeCallback(id) {
        const callback = this.callbacks.get(id);
        if (callback && !callback.repeat && !callback.listener)
            this.callbacks.delete(id);
        return callback?.fn;
    }
    finish(call, wire, value) {
        const reads = [...call.live.reads];
        if (wire.kind !== 'render' || wire.renderSeq === undefined)
            return { ok: true, reads };
        const { tree, own } = call.entry.realm.serialize(value, { renderSeq: wire.renderSeq, sessionId: wire.sessionId }, wire.limits);
        return { ok: true, tree, own, reads };
    }
    async next(call, event) {
        if (call.nextCalled)
            throw new ExtensionError('EXTENSION_NEXT_TWICE');
        if (call.live.settled)
            throw new ExtensionError('INVOCATION_SETTLED');
        call.nextCalled = true;
        const json = toJson(event, 'next event');
        return this.request(call, (id, gen) => ({
            t: 'next',
            id,
            gen,
            callId: call.live.callId,
            event: json,
        }));
    }
    /**
     * With a `signal`, an abort settles the request at once with `CANCELLED` and asks the main thread
     * to abort the call it runs (`cancel`); its late reply finds no pending entry and is dropped. An
     * already-aborted signal rejects without posting anything.
     */
    request(call, build, signal) {
        if (signal?.aborted) {
            return Promise.reject(new ExtensionError('CANCELLED', 'the signal was already aborted'));
        }
        this.requestSeq += 1;
        const id = this.requestSeq;
        const gen = this.generation;
        return new Promise((resolve, reject) => {
            if (!signal) {
                this.pending.set(id, { call, resolve, reject });
                this.port.postMessage(build(id, gen));
                return;
            }
            const onAbort = () => {
                if (!this.pending.delete(id))
                    return;
                this.port.postMessage({ t: 'cancel', id, gen });
                // Write point: the plugin continuation runs right after this rejection.
                writeAttribution(this.attribution, call.entry.realmNo, call.live.hookRef);
                reject(new ExtensionError('CANCELLED', 'the caller aborted the signal'));
            };
            // The signal is plugin-made: its methods get realm values only, never `onAbort` itself.
            const { realm } = call.entry;
            const detach = () => realm.callMethod(signal, 'removeEventListener', ['abort', onAbort]);
            realm.callMethod(signal, 'addEventListener', ['abort', onAbort, { once: true }]);
            this.pending.set(id, {
                call,
                resolve: (value) => {
                    detach();
                    resolve(value);
                },
                reject: (error) => {
                    detach();
                    reject(error);
                },
            });
            this.port.postMessage(build(id, gen));
        });
    }
    settleRequest(message) {
        if (message.gen !== this.generation)
            return;
        const request = this.pending.get(message.id);
        if (!request)
            return;
        this.pending.delete(message.id);
        // Write point 2/3: the plugin continuation runs right after this resolution.
        writeAttribution(this.attribution, request.call.entry.realmNo, request.call.live.hookRef);
        if (message.ok)
            request.resolve(message.value);
        else
            request.reject(this.makeError(message.error));
    }
    abort(callId) {
        const call = this.calls.get(callId);
        if (!call)
            return;
        call.aborted = true;
        call.live.settled = true;
        for (const [id, request] of this.pending) {
            if (request.call !== call)
                continue;
            this.pending.delete(id);
            request.reject(new ExtensionError('INVOCATION_SETTLED', 'invocation aborted'));
        }
    }
    bridge(entry) {
        return {
            current: () => {
                const inv = this.current.getStore();
                return inv?.realmKey === entry.key ? inv : undefined;
            },
            request: (inv, method, args, signal) => this.request(this.callOf(inv), (id, gen) => ({ t: 'ctx', id, gen, callId: inv.callId, method, args }), signal),
            notify: (inv, method, args) => {
                this.port.postMessage({ t: 'notify', callId: inv.callId, method, args });
            },
            checkCall: (inv, name, server) => {
                if (callAllowed(entry.calls, name, server))
                    return;
                this.port.postMessage({
                    t: 'notify',
                    callId: inv.callId,
                    method: 'calls.violation',
                    args: [name],
                });
                throw new ExtensionError('CALL_NOT_DECLARED', server ? `${name}(${server})` : name);
            },
            addTimer: (inv, ms, repeat, fn) => this.addTimer(entry, inv, { ms, repeat, fn }),
            now: () => this.timers.now(),
            addStoreListener: (inv, fn) => this.addListener(entry.key, inv, fn),
            dispose: (id) => this.disposeCallback(id),
        };
    }
    callOf(inv) {
        const call = this.calls.get(inv.callId);
        if (!call || inv.settled)
            throw new ExtensionError('INVOCATION_SETTLED');
        return call;
    }
    addTimer(entry, inv, spec) {
        if (!Number.isFinite(spec.ms) || spec.ms < entry.minClockIntervalMs) {
            throw new RangeError(`ctx.clock interval must be at least ${entry.minClockIntervalMs} ms`);
        }
        this.callbackSeq += 1;
        const id = this.callbackSeq;
        const fire = () => {
            this.port.postMessage({
                t: 'fire',
                realmKey: entry.key,
                sessionId: inv.sessionId,
                callbackId: id,
                breakerKey: inv.breakerKey,
                args: [],
            });
        };
        const timer = spec.repeat
            ? this.timers.setInterval(fire, spec.ms)
            : this.timers.setTimeout(fire, spec.ms);
        this.callbacks.set(id, {
            realmKey: entry.key,
            sessionId: inv.sessionId,
            breakerKey: inv.breakerKey,
            fn: spec.fn,
            timer,
            repeat: spec.repeat,
            listener: false,
        });
        return id;
    }
    addListener(realmKey, inv, fn) {
        this.callbackSeq += 1;
        const id = this.callbackSeq;
        this.callbacks.set(id, {
            realmKey,
            sessionId: inv.sessionId,
            breakerKey: inv.breakerKey,
            fn: fn,
            repeat: true,
            listener: true,
        });
        this.port.postMessage({
            t: 'notify',
            callId: inv.callId,
            method: 'store.subscribe',
            args: [id],
        });
        return id;
    }
    disposeCallback(id) {
        const callback = this.callbacks.get(id);
        if (!callback)
            return;
        this.callbacks.delete(id);
        if (callback.timer !== undefined)
            this.timers.clear(callback.timer);
        if (callback.listener) {
            this.port.postMessage({ t: 'notify', callId: 0, method: 'store.unsubscribe', args: [id] });
        }
    }
    dropCallbacks(match) {
        for (const [id, callback] of this.callbacks) {
            if (match(callback))
                this.disposeCallback(id);
        }
    }
    post(callId, result) {
        this.port.postMessage({ t: 'result', callId, ...result });
    }
    makeError(error) {
        const made = isExtensionErrorCode(error.code)
            ? new ExtensionError(error.code)
            : Object.assign(new Error(error.message), { code: error.code });
        made.message = error.message;
        if (error.fromInner)
            this.innerErrors.add(made);
        return made;
    }
    toWireError(error) {
        if (error instanceof WireFailure)
            return error.wire;
        const message = describeError(error);
        if (typeof error === 'object' && error !== null && this.innerErrors.has(error)) {
            return { code: errorCode(error) ?? 'thrown', message, fromInner: true };
        }
        const code = errorCode(error);
        if (code === 'ERR_SCRIPT_EXECUTION_TIMEOUT')
            return { code: 'timeout', message };
        if (code !== undefined && isExtensionErrorCode(code))
            return { code, message };
        return { code: 'thrown', message };
    }
}
class WireFailure extends Error {
    wire;
    constructor(wire) {
        super(wire.message);
        this.wire = wire;
    }
}
function liveInvocation(wire) {
    return {
        callId: wire.callId,
        realmKey: wire.realmKey,
        kind: wire.kind,
        sessionId: wire.sessionId,
        session: wire.session,
        writable: wire.writable,
        breakerKey: wire.breakerKey,
        hookRef: hookRefOf(wire),
        snapshot: { ...wire.state },
        reads: new Set(),
        settled: false,
    };
}
function hookRefOf(wire) {
    const target = wire.target;
    if (target.type === 'hook')
        return target.index + 1;
    if (target.type === 'handle')
        return -target.handle;
    return 100_000 + target.id;
}
function errorCode(error) {
    try {
        const code = error?.code;
        return typeof code === 'string' ? code : undefined;
    }
    catch {
        return undefined;
    }
}
//# sourceMappingURL=runtime.js.map