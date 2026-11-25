import vm from 'node:vm';
import { Icon, ICON_NAMES, TREE_LIMITS } from '@mavis/shared/plugin-extension';
import { EXTENSION_SDK_SPECIFIERS } from '../../contracts.js';
import * as authorRoot from '../../sdk/author/index.js';
import { ExtensionError } from '../../sdk/diagnostics.js';
import { createElementRuntime } from '../../sdk/element-runtime.js';
import { installAbortSignal } from './abort-signal.js';
import { createHardenedContext } from './boundary.js';
import { serializeOutput } from './serialize.js';
/**
 * One vm context per `(pluginId, artifactDigest)` (two.md §2.3, §12). It is a hardened execution
 * context, not an OS sandbox: the extension runs with the user's access (the consent card says
 * so). The context has no ambient Node globals and no string or wasm code generation, and
 * everything the host hands it crosses `RealmBoundary`, so no injected value (`require`, `jsx`,
 * `console`, `__on`, `ctx`, events, results) leads back to host intrinsics.
 */
const [SDK_ROOT, SDK_UI, SDK_JSX_RUNTIME, SDK_JSX_DEV_RUNTIME] = EXTENSION_SDK_SPECIFIERS;
const MAX_CONSOLE_TEXT = 2_000;
const INVOKE_SCRIPT = new vm.Script('__mcodeInvoke.result = __mcodeInvoke.apply(__mcodeInvoke.fn, undefined, __mcodeInvoke.args);', { filename: 'mcode-extension:invoke' });
/** The realm-side invoke slot; `apply` is the realm's own `Reflect.apply`, taken before load. */
const INVOKE_SLOT_SCRIPT = new vm.Script(`Object.defineProperty(globalThis, '__mcodeInvoke', {
    value: Object.seal(
      Object.defineProperty({ fn: undefined, args: undefined, result: undefined }, 'apply', {
        value: Reflect.apply,
      }),
    ),
  }).__mcodeInvoke`, { filename: 'mcode-extension:invoke-slot' });
export class Realm {
    options;
    hooks = [];
    stateDefaults;
    context;
    boundary;
    invokeSlot;
    genuine = new WeakMap();
    bound = new Map();
    handleSeq = 0;
    registering = false;
    constructor(options) {
        this.options = options;
        const runtime = createElementRuntime(this.registrar());
        const { context, boundary, globals } = createHardenedContext(`mcode-extension:${options.pluginId}`, {
            jsx: runtime.jsx,
            jsxs: runtime.jsxs,
            Fragment: runtime.Fragment,
            console: createRealmConsole(this.options.onConsole),
            require: sdkRequire(runtime, options.modules),
            __on: (...args) => this.collect(args),
        });
        this.context = context;
        this.boundary = boundary;
        const module = boundary.object();
        module.exports = boundary.object();
        globals.module = module;
        this.invokeSlot = INVOKE_SLOT_SCRIPT.runInContext(context);
        installAbortSignal(this.context);
        this.load(module);
        compareHooks(this.hooks, options.expected);
        this.stateDefaults = stateDefaults(module.exports.state);
    }
    get pluginId() {
        return this.options.pluginId;
    }
    /** Calls a realm function with its synchronous entry under the vm timeout. */
    call(fn, args) {
        const slot = this.invokeSlot;
        slot.fn = this.boundary.toRealm(fn);
        slot.args = this.boundary.toRealm([...args]);
        slot.result = undefined;
        try {
            INVOKE_SCRIPT.runInContext(this.context, { timeout: this.options.syncTimeoutMs });
            return this.boundary.toHostResult(slot.result);
        }
        catch (error) {
            throw this.boundary.toHost(error);
        }
        finally {
            slot.fn = undefined;
            slot.args = undefined;
            slot.result = undefined;
        }
    }
    /** Worker exit for a render: binds genuine handles in the output to `renderSeq`. */
    serialize(value, binding, limits = TREE_LIMITS) {
        const fns = new Map();
        const result = serializeOutput(value, {
            pluginId: this.pluginId,
            limits,
            resolveHandle: (candidate) => {
                const genuine = this.genuine.get(this.boundary.toHost(candidate));
                if (!genuine)
                    return undefined;
                fns.set(genuine.handle, genuine.fn);
                return genuine.handle;
            },
        });
        if (fns.size > 0)
            this.bound.set(binding.renderSeq, { sessionId: binding.sessionId, fns });
        return result;
    }
    /** Calls a method of a plugin-made object, handing it only realm values (see `RealmBoundary`). */
    callMethod(target, name, args) {
        return this.boundary.callMethod(target, name, args);
    }
    /** The host original of a value plugin code got from the host (a rethrown error, say). */
    hostValue(value) {
        return this.boundary.toHost(value);
    }
    callbackFor(renderSeq, handle) {
        return this.bound.get(renderSeq)?.fns.get(handle);
    }
    release(renderSeqs) {
        for (const renderSeq of renderSeqs)
            this.bound.delete(renderSeq);
    }
    dropSession(sessionId) {
        for (const [renderSeq, bound] of this.bound) {
            if (bound.sessionId === sessionId)
                this.bound.delete(renderSeq);
        }
    }
    load(module) {
        const { pluginId, version, code, syncTimeoutMs } = this.options;
        const script = new vm.Script(`(function (module, exports, require) {${code}\n})(module, module.exports, require);\n` +
            `if (typeof module.exports.register !== 'function') throw new TypeError('HOOK_MODULE_EXPORT_INVALID');\n` +
            `module.exports.register(__on, {});`, { filename: `${pluginId}@${version}` });
        this.registering = true;
        try {
            script.runInContext(this.context, { timeout: syncTimeoutMs });
        }
        catch (error) {
            throw loadError(this.boundary.toHost(error));
        }
        finally {
            this.registering = false;
        }
        if (typeof module.exports.register !== 'function') {
            throw new ExtensionError('HOOK_MODULE_EXPORT_INVALID');
        }
    }
    collect(args) {
        if (!this.registering) {
            throw new ExtensionError('EXTENSION_REGISTER_SHAPE_INVALID', 'on() after register returned');
        }
        const [slot] = args;
        if (typeof slot !== 'string' || !this.options.slots.includes(slot)) {
            throw new ExtensionError('EXTENSION_EVENT_UNSUPPORTED', String(slot));
        }
        const hook = args.length === 2 ? args[1] : args[2];
        if (typeof hook !== 'function') {
            throw new ExtensionError('EXTENSION_REGISTER_SHAPE_INVALID', `${slot} without a hook function`);
        }
        const matcher = args.length === 2 ? undefined : normalizeMatcher(slot, args[1]);
        this.hooks.push({
            slot,
            ...(matcher ? { matcher } : {}),
            fn: hook,
        });
    }
    registrar() {
        return {
            register: (callback) => {
                this.handleSeq += 1;
                const handle = Object.freeze({ plugin: this.pluginId, handle: this.handleSeq });
                this.genuine.set(handle, { handle: this.handleSeq, fn: callback });
                return handle;
            },
        };
    }
}
export function createRealmConsole(onConsole) {
    const emit = (level) => (...args) => {
        onConsole(level, args.map(formatConsoleArg).join(' ').slice(0, MAX_CONSOLE_TEXT));
    };
    return Object.freeze({
        log: emit('log'),
        info: emit('info'),
        warn: emit('warn'),
        error: emit('error'),
        debug: emit('debug'),
    });
}
/**
 * The four SDK specifiers as served to plugin code, bound to one element runtime: the root is the
 * values of `sdk/author/index.ts`; `/ui` and the JSX runtimes are the realm's own element runtime,
 * with the names `sdk/author/ui.ts` and `jsx-*.ts` declare.
 */
export function sdkModules(runtime) {
    const jsxRuntime = Object.freeze({
        jsx: runtime.jsx,
        jsxs: runtime.jsxs,
        Fragment: runtime.Fragment,
    });
    return new Map([
        [SDK_ROOT, Object.freeze({ ...authorRoot })],
        [SDK_UI, Object.freeze({ ...runtime.ui, Icon, ICON_NAMES })],
        [SDK_JSX_RUNTIME, jsxRuntime],
        [SDK_JSX_DEV_RUNTIME, Object.freeze({ ...jsxRuntime, jsxDEV: runtime.jsx })],
    ]);
}
function sdkRequire(runtime, extra = new Map()) {
    const modules = new Map([...sdkModules(runtime), ...extra]);
    return (specifier) => {
        const resolved = typeof specifier === 'string' ? modules.get(specifier) : undefined;
        if (resolved === undefined) {
            throw new ExtensionError('EXTENSION_IMPORT_FORBIDDEN', String(specifier));
        }
        return resolved;
    };
}
export function normalizeMatcher(slot, value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new ExtensionError('EXTENSION_MATCHER_INVALID', slot);
    }
    const out = {};
    for (const [field, raw] of Object.entries(value)) {
        if (raw === undefined)
            continue;
        if (typeof raw === 'string') {
            out[field] = raw;
        }
        else if (raw instanceof RegExp || Object.prototype.toString.call(raw) === '[object RegExp]') {
            out[field] = String(raw);
        }
        else {
            throw new ExtensionError('EXTENSION_MATCHER_INVALID', `${slot}.${field}`);
        }
    }
    return out;
}
function hookSignature(hook) {
    const matcher = hook.matcher
        ? Object.keys(hook.matcher)
            .sort()
            .map((field) => [field, hook.matcher?.[field]])
        : null;
    return JSON.stringify([hook.slot, matcher]);
}
/**
 * Load comparison (two.md §2.2): the real `on()` calls must equal validate's record.
 * @internal Exported for focused tests.
 */
export function compareHooks(actual, expected) {
    const remaining = new Map();
    for (const hook of expected) {
        const signature = hookSignature(hook);
        remaining.set(signature, (remaining.get(signature) ?? 0) + 1);
    }
    const extra = [];
    for (const hook of actual) {
        const signature = hookSignature(hook);
        const count = remaining.get(signature) ?? 0;
        if (count === 0)
            extra.push(signature);
        else
            remaining.set(signature, count - 1);
    }
    const missing = [...remaining].filter(([, count]) => count > 0).map(([signature]) => signature);
    if (extra.length > 0 || missing.length > 0) {
        throw new ExtensionError('EXTENSION_ENTRY_MISMATCH', `unexpected ${JSON.stringify(extra)}, missing ${JSON.stringify(missing)}`);
    }
}
function stateDefaults(declaration) {
    if (declaration === undefined)
        return undefined;
    const spec = declaration?.spec;
    if (typeof spec !== 'object' || spec === null) {
        throw new ExtensionError('EXTENSION_STATE_SHAPE_INVALID');
    }
    const defaults = {};
    for (const [key, field] of Object.entries(spec)) {
        const text = JSON.stringify(field?.default);
        if (text === undefined)
            throw new ExtensionError('EXTENSION_STATE_SHAPE_INVALID', key);
        defaults[key] = JSON.parse(text);
    }
    return Object.freeze(defaults);
}
function loadError(error) {
    if (error instanceof ExtensionError)
        return error;
    const message = describeError(error);
    if (message.includes('HOOK_MODULE_EXPORT_INVALID')) {
        return new ExtensionError('HOOK_MODULE_EXPORT_INVALID');
    }
    // The vm timeout keeps its own code; any other throw in the module body or `register` is this.
    if (error?.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT')
        return error;
    return new ExtensionError('EXTENSION_REGISTER_FAILED', message);
}
export function describeError(error) {
    try {
        if (typeof error === 'object' && error !== null) {
            const record = error;
            return `${String(record.name ?? 'Error')}: ${String(record.message ?? '')}`.slice(0, 1_000);
        }
        return String(error).slice(0, 1_000);
    }
    catch {
        return 'unprintable error';
    }
}
function formatConsoleArg(value) {
    if (typeof value === 'string')
        return value;
    try {
        return JSON.stringify(value) ?? String(value);
    }
    catch {
        return describeError(value);
    }
}
//# sourceMappingURL=realm.js.map