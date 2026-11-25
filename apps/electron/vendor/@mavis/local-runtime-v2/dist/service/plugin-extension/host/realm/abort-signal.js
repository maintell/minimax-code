import vm from 'node:vm';
/**
 * A minimal `AbortController` / `AbortSignal` defined inside each realm, so authors can build the
 * `signal` that `ctx` call options take. It is the realm's own code, not the host classes: there is
 * no `AbortSignal.timeout` (a host timer that would bypass `ctx.clock`), no `AbortSignal.any` and
 * no `AbortSignal.abort`, and `signal.constructor` leads only to this realm's class. Listeners run
 * synchronously inside `controller.abort(reason)`, so plugin code runs in the Invocation that
 * aborted; a throwing listener is reported to the plugin console and does not stop the others.
 */
const SOURCE = `(() => {
  'use strict';
  const slots = new WeakMap();
  const slotOf = (signal) => {
    const slot = slots.get(signal);
    if (!slot) throw new TypeError('Illegal invocation');
    return slot;
  };
  const isListener = (listener) =>
    typeof listener === 'function' ||
    (typeof listener === 'object' && listener !== null && typeof listener.handleEvent === 'function');
  const deliver = (signal, listener, event) => {
    try {
      if (typeof listener === 'function') listener.call(signal, event);
      else listener.handleEvent(event);
    } catch (error) {
      console.error('abort listener threw:', error);
    }
  };
  class AbortSignal {
    constructor() {
      throw new TypeError('Illegal constructor');
    }
    get aborted() {
      return slotOf(this).aborted;
    }
    get reason() {
      return slotOf(this).reason;
    }
    get onabort() {
      return slotOf(this).onabort;
    }
    set onabort(handler) {
      slotOf(this).onabort = typeof handler === 'function' ? handler : null;
    }
    addEventListener(type, listener, options) {
      const slot = slotOf(this);
      if (type !== 'abort' || !isListener(listener)) return;
      if (slot.listeners.some((entry) => entry.listener === listener)) return;
      const once = typeof options === 'object' && options !== null && options.once === true;
      slot.listeners.push({ listener, once, removed: false });
    }
    removeEventListener(type, listener) {
      const slot = slotOf(this);
      if (type !== 'abort') return;
      slot.listeners = slot.listeners.filter((entry) => {
        if (entry.listener !== listener) return true;
        entry.removed = true;
        return false;
      });
    }
    throwIfAborted() {
      const slot = slotOf(this);
      if (slot.aborted) throw slot.reason;
    }
  }
  class AbortController {
    #signal;
    constructor() {
      const signal = Object.create(AbortSignal.prototype);
      slots.set(signal, { aborted: false, reason: undefined, onabort: null, listeners: [] });
      this.#signal = signal;
    }
    get signal() {
      return this.#signal;
    }
    abort(reason) {
      const signal = this.#signal;
      const slot = slotOf(signal);
      if (slot.aborted) return;
      slot.aborted = true;
      slot.reason =
        reason !== undefined
          ? reason
          : Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
      const event = Object.freeze({ type: 'abort', target: signal, currentTarget: signal });
      const listeners = slot.listeners;
      slot.listeners = listeners.filter((entry) => !entry.once);
      if (slot.onabort) deliver(signal, slot.onabort, event);
      for (const entry of listeners) if (!entry.removed) deliver(signal, entry.listener, event);
    }
  }
  for (const [name, value] of [['AbortSignal', AbortSignal], ['AbortController', AbortController]]) {
    Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });
  }
})();`;
const SCRIPT = new vm.Script(SOURCE, { filename: 'mcode-extension:abort-signal' });
/** Defines the realm's own `AbortController` / `AbortSignal` globals in `context`. */
export function installAbortSignal(context) {
    SCRIPT.runInContext(context);
}
//# sourceMappingURL=abort-signal.js.map