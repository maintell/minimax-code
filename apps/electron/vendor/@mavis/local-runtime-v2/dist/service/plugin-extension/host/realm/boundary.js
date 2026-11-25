import { types } from 'node:util';
import vm from 'node:vm';
/**
 * Captures the realm intrinsics before any plugin code runs, so later changes to realm globals
 * (a replaced `Promise`, a patched `Reflect`) cannot intercept what the boundary builds. No host
 * function is ever stored where plugin code can reach it: `call` lives only in a wrapper closure.
 */
const INTRINSICS_SCRIPT = new vm.Script(`(() => {
    'use strict';
    const P = Promise;
    const apply = Reflect.apply;
    const resolve = P.resolve;
    const then = P.prototype.then;
    const define = Object.defineProperty;
    const errors = {
      __proto__: null,
      Error, TypeError, RangeError, SyntaxError, ReferenceError, EvalError, URIError, AggregateError,
    };
    return {
      objectPrototype: Object.prototype,
      arrayPrototype: Array.prototype,
      adopt: (value, onFulfilled, onRejected) => {
        apply(then, apply(resolve, P, [value]), [onFulfilled, onRejected]);
      },
      object: () => ({}),
      array: () => [],
      wrap: (name, call) => ({ [name](...args) { return call(this, args); } })[name],
      deferred: () => {
        let resolve;
        let reject;
        const promise = new P((yes, no) => { resolve = yes; reject = no; });
        return { promise, resolve, reject };
      },
      error: (name, message) => {
        const made = new (errors[name] ?? Error)(message);
        if (made.name !== name) {
          define(made, 'name', { value: name, writable: true, configurable: true });
        }
        return made;
      },
    };
  })()`, { filename: 'mcode-extension:boundary' });
/**
 * A vm context with a null-prototype global, no string or wasm code generation, and `globals`
 * installed through the boundary.
 */
export function createHardenedContext(name, globals) {
    const sandbox = Object.create(null);
    const context = vm.createContext(sandbox, {
        name,
        codeGeneration: { strings: false, wasm: false },
    });
    const boundary = new RealmBoundary(INTRINSICS_SCRIPT.runInContext(context));
    for (const [key, value] of Object.entries(globals))
        sandbox[key] = boundary.toRealm(value);
    return { context, boundary, globals: sandbox };
}
export class RealmBoundary {
    intrinsics;
    realmOf = new WeakMap();
    hostOf = new WeakMap();
    /** Values that came out of the realm without its prototypes (null-prototype objects). */
    fromRealm = new WeakSet();
    constructor(intrinsics) {
        this.intrinsics = intrinsics;
    }
    /** A fresh empty object of the realm, for state the host and plugin code share. */
    object() {
        return this.intrinsics.object();
    }
    /** `value` as plugin code may see it; only values this realm made pass unchanged. */
    toRealm(value) {
        if (!isObjectLike(value))
            return value;
        const known = this.realmOf.get(value);
        if (known !== undefined)
            return known;
        if (this.madeByRealm(value))
            return value;
        if (typeof value === 'function')
            return this.wrapHostFunction(value);
        // By internal slot, not `instanceof`: a promise or error of another context is one too, and
        // copying a promise would drag along whatever its own properties hold (on Node 22 the async
        // hooks' resource store, i.e. the host's AsyncLocalStorage value).
        if (types.isPromise(value))
            return this.realmPromise(value);
        if (types.isNativeError(value))
            return this.realmError(value);
        return this.realmCopy(value);
    }
    /** The host original of a value `toRealm` produced; realm functions get a converting wrapper. */
    toHost(value) {
        if (!isObjectLike(value))
            return value;
        const known = this.hostOf.get(value);
        if (known !== undefined)
            return known;
        if (reachesPrototype(value, Object.prototype))
            return value;
        this.fromRealm.add(value);
        if (typeof value !== 'function')
            return value;
        const realmFn = value;
        const call = (self, args) => this.callRealm(realmFn, self, args);
        const wrapper = function realmCallback(...args) {
            return call(this, args);
        };
        this.link(wrapper, realmFn);
        return wrapper;
    }
    /**
     * A realm value whose nested functions host code calls later (a test's `mount({ mcp, mods })`),
     * where `toHost` would convert only the value itself and leave each nested callback to receive
     * raw host arguments. Realm objects and arrays become host snapshots of their own enumerable
     * properties at any depth (getters run now, in the realm), and every function becomes what
     * `toHost` makes of it; host values and the host originals of realm stand-ins pass as `toHost`
     * passes them.
     */
    toHostTree(value) {
        return this.hostTree(value, new Map(), 'mount');
    }
    /**
     * Calls the method `name` of a plugin-made object with host arguments converted first; the way
     * host code calls into anything plugin code supplied (an `AbortSignal`'s `addEventListener`).
     * A missing method is `undefined`.
     */
    callMethod(target, name, args) {
        const method = Reflect.get(target, name);
        if (typeof method !== 'function')
            return undefined;
        return this.callRealm(method, target, args);
    }
    /**
     * What a realm call returned, for host code to use or await: a thenable becomes a host promise
     * adopted on the realm side, so the plugin's `then` sees realm callbacks only.
     */
    toHostResult(value) {
        if (!isObjectLike(value))
            return value;
        if (typeof Reflect.get(value, 'then') !== 'function')
            return this.toHost(value);
        return new Promise((resolve, reject) => {
            this.intrinsics.adopt(value, this.toRealm((settled) => resolve(this.toHost(settled))), this.toRealm((reason) => reject(this.toHost(reason))));
        });
    }
    callRealm(fn, self, args) {
        const realmArgs = this.toRealm([...args]);
        return this.toHostResult(Reflect.apply(fn, this.toRealm(self), realmArgs));
    }
    hostTree(value, copies, field) {
        if (!isObjectLike(value) || typeof value === 'function' || this.hostOf.has(value)) {
            return this.toHost(value);
        }
        if (reachesPrototype(value, Object.prototype))
            return value;
        rejectExotic(value);
        this.assertHostTreePrototype(value, field);
        const done = copies.get(value);
        if (done !== undefined)
            return done;
        const copy = Array.isArray(value) ? [] : {};
        copies.set(value, copy);
        this.realmOf.set(copy, value);
        for (const key of Reflect.ownKeys(value)) {
            if (!Reflect.getOwnPropertyDescriptor(value, key)?.enumerable)
                continue;
            Reflect.defineProperty(copy, key, {
                value: this.hostTree(Reflect.get(value, key), copies, `${field}.${String(key)}`),
                writable: true,
                enumerable: true,
                configurable: true,
            });
        }
        return copy;
    }
    assertHostTreePrototype(value, field) {
        const expectedPrototype = Array.isArray(value)
            ? this.intrinsics.arrayPrototype
            : this.intrinsics.objectPrototype;
        if (Reflect.getPrototypeOf(value) !== expectedPrototype) {
            throw new TypeError(`${field} has an unsupported prototype; class instances are not supported`);
        }
    }
    madeByRealm(value) {
        return this.fromRealm.has(value) || reachesPrototype(value, this.intrinsics.objectPrototype);
    }
    link(host, realm) {
        this.realmOf.set(host, realm);
        this.hostOf.set(realm, host);
    }
    wrapHostFunction(fn) {
        const wrapper = this.intrinsics.wrap(String(fn.name), (self, args) => {
            const hostArgs = [];
            for (let index = 0; index < args.length; index += 1) {
                hostArgs.push(this.toHost(args[index]));
            }
            try {
                return this.toRealm(Reflect.apply(fn, this.toHost(self), hostArgs));
            }
            catch (error) {
                throw this.toRealm(error);
            }
        });
        this.link(fn, wrapper);
        return wrapper;
    }
    /**
     * A realm promise that settles with `promise`'s outcome converted. The realm's own `Promise`
     * adopts it, so `promise`'s `then` (host or another context's) receives realm functions only,
     * and the settled value reaches the host side raw, without being taken for a realm value.
     */
    realmPromise(promise) {
        const deferred = this.intrinsics.deferred();
        this.link(promise, deferred.promise);
        this.intrinsics.adopt(promise, this.intrinsics.wrap('fulfilled', (_self, args) => deferred.resolve(this.toRealm(args[0]))), this.intrinsics.wrap('rejected', (_self, args) => deferred.reject(this.toRealm(args[0]))));
        return deferred.promise;
    }
    realmError(error) {
        const made = this.intrinsics.error(String(error.name), String(error.message));
        this.link(error, made);
        for (const key of Object.keys(error)) {
            if (key === 'name' || key === 'message' || key === 'stack')
                continue;
            Object.defineProperty(made, key, {
                value: this.toRealm(Reflect.get(error, key)),
                writable: true,
                enumerable: true,
                configurable: true,
            });
        }
        return made;
    }
    realmCopy(source) {
        rejectExotic(source);
        const copy = Array.isArray(source) ? this.intrinsics.array() : this.intrinsics.object();
        this.link(source, copy);
        for (const key of Reflect.ownKeys(source)) {
            const descriptor = Reflect.getOwnPropertyDescriptor(source, key);
            if (!descriptor || (key === 'length' && Array.isArray(source)))
                continue;
            Reflect.defineProperty(copy, key, this.realmDescriptor(descriptor));
        }
        mirrorIntegrity(source, copy);
        return copy;
    }
    /** Data stays data, accessors stay lazy: their getter and setter get realm wrappers. */
    realmDescriptor(descriptor) {
        const converted = { ...descriptor };
        if ('value' in converted)
            converted.value = this.toRealm(converted.value);
        if (converted.get)
            converted.get = this.toRealm(converted.get);
        if (converted.set)
            converted.set = this.toRealm(converted.set);
        return converted;
    }
}
function mirrorIntegrity(source, copy) {
    if (Object.isFrozen(source))
        Object.freeze(copy);
    else if (Object.isSealed(source))
        Object.seal(copy);
    else if (!Object.isExtensible(source))
        Object.preventExtensions(copy);
}
function isObjectLike(value) {
    return (typeof value === 'object' && value !== null) || typeof value === 'function';
}
function reachesPrototype(value, prototype) {
    let current = value;
    while (current !== null) {
        if (current === prototype)
            return true;
        current = Reflect.getPrototypeOf(current);
    }
    return false;
}
/** Values whose meaning lives in internal slots: a property copy would silently lose it. */
const EXOTIC = [
    types.isPromise,
    types.isNativeError,
    types.isMap,
    types.isSet,
    types.isWeakMap,
    types.isWeakSet,
    types.isDate,
    types.isRegExp,
    types.isAnyArrayBuffer,
    types.isArrayBufferView,
    types.isBoxedPrimitive,
    types.isProxy,
];
function rejectExotic(source) {
    if (EXOTIC.some((isExotic) => isExotic(source))) {
        throw new TypeError(`${Object.prototype.toString.call(source)} cannot be handed to extension code`);
    }
}
//# sourceMappingURL=boundary.js.map