import { ExtensionError } from '../../sdk/diagnostics.js';
function currentOf(bridge) {
    const inv = bridge.current();
    if (!inv)
        throw new ExtensionError('INVOCATION_SETTLED', 'no current invocation');
    return inv;
}
/** The current Invocation, still running; every grant-bearing call starts here. */
function liveOf(bridge) {
    const inv = currentOf(bridge);
    if (inv.settled)
        throw new ExtensionError('INVOCATION_SETTLED');
    return inv;
}
export function toJson(value, label) {
    try {
        const text = JSON.stringify(value);
        if (text !== undefined)
            return JSON.parse(text);
    }
    catch {
        // Reported below.
    }
    throw new TypeError(`${label} must be JSON-serializable`);
}
/** `options.signal` when it behaves like an `AbortSignal`; any other value is ignored. */
function requestSignalOf(options) {
    const signal = options?.signal;
    if (typeof signal !== 'object' || signal === null)
        return undefined;
    const candidate = signal;
    return typeof candidate.aborted === 'boolean' && typeof candidate.addEventListener === 'function'
        ? signal
        : undefined;
}
function copy(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}
function disposable(bridge, id) {
    let disposed = false;
    return Object.freeze({
        dispose: () => {
            if (disposed)
                return;
            disposed = true;
            bridge.dispose(id);
        },
    });
}
async function remote(scope, name, args) {
    const inv = scope.live();
    scope.bridge.checkCall(inv, name);
    return scope.bridge.request(inv, name, args);
}
function stateDomain(scope) {
    const { bridge } = scope;
    /**
     * `set` and `update` are separate declared calls; each goes to the host under its own name with
     * the final value (`update` runs its function here, against the Invocation snapshot).
     */
    const writable = (name) => {
        const inv = scope.live();
        bridge.checkCall(inv, name);
        if (!inv.writable)
            throw new ExtensionError('STATE_WRITE_IN_RENDER');
        return inv;
    };
    const write = async (inv, name, key, value) => {
        const json = toJson(value, 'ctx.state value');
        inv.snapshot[String(key)] = json;
        await bridge.request(inv, name, [String(key), json]);
    };
    return Object.freeze({
        get: (key) => {
            const inv = scope.live();
            bridge.checkCall(inv, 'state.get');
            inv.reads.add(String(key));
            return copy(inv.snapshot[String(key)]);
        },
        set: async (key, value) => {
            const inv = writable('state.set');
            await write(inv, 'state.set', key, value);
        },
        update: async (key, fn) => {
            const inv = writable('state.update');
            await write(inv, 'state.update', key, fn(copy(inv.snapshot[String(key)])));
        },
    });
}
function storeDomain(scope) {
    const { bridge } = scope;
    return Object.freeze({
        get: async (key) => remote(scope, 'store.get', [String(key)]),
        set: async (key, value) => {
            await remote(scope, 'store.set', [String(key), toJson(value, 'ctx.store value')]);
        },
        delete: async (key) => {
            await remote(scope, 'store.delete', [String(key)]);
        },
        keys: async () => {
            const keys = await remote(scope, 'store.keys', []);
            return Array.isArray(keys) ? keys.map(String) : [];
        },
        onDidChange: (listener) => {
            const inv = scope.live();
            bridge.checkCall(inv, 'store.onDidChange');
            if (typeof listener !== 'function')
                throw new TypeError('listener must be a function');
            return disposable(bridge, bridge.addStoreListener(inv, listener));
        },
    });
}
function clockDomain(scope) {
    const { bridge } = scope;
    const schedule = (name, repeat) => (ms, fn) => {
        const inv = scope.live();
        bridge.checkCall(inv, name);
        if (typeof fn !== 'function')
            throw new TypeError(`ctx.${name} needs a callback`);
        return disposable(bridge, bridge.addTimer(inv, Number(ms), repeat, fn));
    };
    return Object.freeze({
        after: schedule('clock.after', false),
        every: schedule('clock.every', true),
        now: () => {
            bridge.checkCall(scope.live(), 'clock.now');
            return bridge.now();
        },
    });
}
function uiDomain(scope) {
    const { bridge } = scope;
    return Object.freeze({
        toast: async (text, opts) => {
            await remote(scope, 'ui.toast', [
                String(text),
                opts === undefined ? null : toJson(opts, 'toast options'),
            ]);
        },
        invalidate: () => {
            const inv = scope.live();
            bridge.checkCall(inv, 'ui.invalidate');
            bridge.notify(inv, 'ui.invalidate', []);
        },
        open: async (options) => {
            await remote(scope, 'ui.open', [toJson(options, 'ctx.ui.open options')]);
        },
        close: async (id) => {
            await remote(scope, 'ui.close', [String(id)]);
        },
    });
}
/**
 * Session facts are read from the current Invocation, settled or not: they carry no grant, so a
 * late branch may still read the facts of the Invocation that started it.
 */
function sessionDomain(scope) {
    const { bridge } = scope;
    return Object.freeze({
        get id() {
            return currentOf(bridge).sessionId;
        },
        get cwd() {
            return currentOf(bridge).session.cwd;
        },
        get root() {
            return currentOf(bridge).session.root;
        },
        get model() {
            return currentOf(bridge).session.model;
        },
        usage: async () => (await remote(scope, 'session.usage', [])),
    });
}
/** The one `ctx` of a realm, built when the realm loads; see the header for how calls resolve. */
export function createActivationContext(plugin, bridge) {
    const scope = { bridge, live: () => liveOf(bridge) };
    return Object.freeze({
        plugin: Object.freeze({ id: plugin.id, version: plugin.version }),
        session: sessionDomain(scope),
        agent: Object.freeze({
            list: async () => (await remote(scope, 'agent.list', [])),
            spawn: async (spec) => (await remote(scope, 'agent.spawn', [toJson(spec, 'ctx.agent.spawn spec')])),
        }),
        model: modelDomain(scope),
        mcp: Object.freeze({
            call: async (server, tool, args, options) => {
                const inv = scope.live();
                bridge.checkCall(inv, 'mcp.call', String(server));
                const callArgs = [
                    String(server),
                    String(tool),
                    args === undefined ? null : toJson(args, 'mcp args'),
                ];
                return (await bridge.request(inv, 'mcp.call', callArgs, requestSignalOf(options)));
            },
        }),
        store: storeDomain(scope),
        state: stateDomain(scope),
        clock: clockDomain(scope),
        ui: uiDomain(scope),
        prompt: Object.freeze({
            fill: async (args) => (await remote(scope, 'prompt.fill', [
                toJson(args, 'ctx.prompt.fill argument'),
            ])),
            suggest: async (args) => (await remote(scope, 'prompt.suggest', [
                toJson(args, 'ctx.prompt.suggest argument'),
            ])),
            read: async () => (await remote(scope, 'prompt.read', [])),
        }),
    });
}
/**
 * `request.signal` goes the way `mcp.call`'s does: its abort settles the request with `CANCELLED`
 * and cancels the main-thread inference. Here `CANCELLED` is a result, `{ reason: 'aborted' }`,
 * never an error the author has to catch.
 */
function modelDomain(scope) {
    const { bridge } = scope;
    return Object.freeze({
        complete: async (request) => {
            const inv = scope.live();
            bridge.checkCall(inv, 'model.complete');
            if (request === null || typeof request !== 'object')
                throw Object.assign(new TypeError('model.complete takes a request object'), {
                    code: 'ARGUMENT_INVALID',
                });
            const { signal, ...wire } = request;
            const args = [toJson(wire, 'model.complete request')];
            try {
                return (await bridge.request(inv, 'model.complete', args, requestSignalOf({ signal })));
            }
            catch (error) {
                if (error?.code === 'CANCELLED')
                    return { isAnswered: false, reason: 'aborted' };
                throw error;
            }
        },
    });
}
//# sourceMappingURL=context.js.map