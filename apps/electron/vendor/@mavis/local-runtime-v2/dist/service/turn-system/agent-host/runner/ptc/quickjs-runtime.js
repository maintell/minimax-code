import { getQuickJS } from 'quickjs-emscripten';
import { PTC_STORE_MAX_KEY_LENGTH, ptcStoreKeyMessage, ptcToolCallLimitRefusal, } from '../../execution/ptc/contracts.js';
import { PtcScriptLoadError, ptcScriptError } from './script/errors.js';
import { loadPtcScript, normalizePtcScriptSpecifier } from './script/loader.js';
/**
 * Applies the console byte budget in the Worker: lines are forwarded while
 * they fit, then the part that still fits goes out once with `truncated` and
 * the rest is dropped, so a chatty loop can neither flood the bridge nor grow
 * the outer result.
 */
export function createPtcConsoleSink(maxBytes, emit) {
    const encoder = new TextEncoder();
    let used = 0;
    let exhausted = false;
    return (line) => {
        if (exhausted)
            return;
        const encoded = encoder.encode(`${line}\n`);
        if (used + encoded.byteLength <= maxBytes) {
            used += encoded.byteLength;
            emit(`${line}\n`, false);
            return;
        }
        exhausted = true;
        const fitted = new TextDecoder().decode(encoded.slice(0, Math.max(0, maxBytes - used)), {
            stream: true,
        });
        used = maxBytes;
        emit(fitted, true);
    };
}
/**
 * Lets the guest `import()` the allowed PTC script directories. The loader and
 * the normalizer are synchronous because QuickJS resolves modules while the
 * guest is on the stack, so the file has to be read here in the Worker.
 */
function installPtcScriptModuleLoader(runtime, input, roots, measureCompute) {
    // QuickJS retries with an empty name after a refused dynamic import; that is
    // the same attempt, so only the first refusal is counted.
    const reportRejected = (status) => {
        input.onScriptRejected?.(status);
    };
    // The specifier the program wrote, kept from the last normalization. QuickJS
    // asks the normalizer first and then the loader, so the retry below knows
    // what was refused even though its own name is empty.
    let lastRequested = '';
    runtime.setModuleLoader((moduleName) => {
        if (!moduleName.trim()) {
            // The retry of a refused import. The program never wrote an empty
            // path, so the refusal names what it did write instead of reporting a
            // not-found with nothing after the colon.
            throw ptcScriptError(`run_code script import was refused: ${lastRequested || 'an unnamed module'}.`, roots);
        }
        let script;
        try {
            script = measureCompute(() => loadPtcScript(moduleName, roots));
        }
        catch (error) {
            reportRejected(error instanceof PtcScriptLoadError ? error.status : 'rejected');
            throw error;
        }
        input.onScriptLoaded?.({ path: script.path, scope: script.scope, sha256: script.sha256 });
        return script.source;
    }, (base, requested) => {
        // A blank request is QuickJS asking again after a refusal, not a new
        // import, so it neither replaces the specifier nor counts again.
        if (requested.trim())
            lastRequested = requested.trim();
        try {
            return normalizePtcScriptSpecifier(base, requested, roots);
        }
        catch (error) {
            if (requested.trim()) {
                reportRejected(error instanceof PtcScriptLoadError ? error.status : 'rejected');
            }
            throw error;
        }
    });
}
/** At most this many dropped-field paths travel to the host; the outer line lists up to 5. */
const MAX_REPORTED_DROPPED_PATHS = 5;
/**
 * The guest compute clock. Calls nest: only the outermost one opens the
 * window, so a nested call neither restarts the clock, charges its time a
 * second time, nor reports the guest idle while an outer one is still on the
 * stack.
 *
 * Nesting happens for real: the module loader runs inside the window the job
 * pump opened, and the guest runs a module's top-level code right after the
 * loader returns. Closing the window there cleared the clock and told the host
 * the guest was idle, so an imported module whose top level loops ran on with
 * nothing left to stop it, and the host cleared its own compute timer on the
 * same signal.
 */
function createComputeClock(onActivityChange) {
    let elapsedMs = 0;
    let startedAtMs;
    let depth = 0;
    return {
        currentMs() {
            return elapsedMs + (startedAtMs === undefined ? 0 : performance.now() - startedAtMs);
        },
        measure(operation) {
            depth += 1;
            if (depth > 1) {
                try {
                    return operation();
                }
                finally {
                    depth -= 1;
                }
            }
            const startedAt = performance.now();
            startedAtMs = startedAt;
            onActivityChange?.(true);
            try {
                return operation();
            }
            finally {
                depth -= 1;
                elapsedMs += performance.now() - startedAt;
                startedAtMs = undefined;
                onActivityChange?.(false);
            }
        },
    };
}
/** Bounded so a lost runtime cannot flood the log. */
const DISPOSE_FAILURE_MESSAGE_MAX_CHARS = 200;
function disposeFailureMessage(error) {
    const text = error instanceof Error ? error.message : String(error);
    return text.slice(0, DISPOSE_FAILURE_MESSAGE_MAX_CHARS);
}
/** Runs one untrusted async function body in a fresh QuickJS runtime. */
export async function executePtcQuickJsProgram(input) {
    const quickJs = await getQuickJS();
    const runtime = quickJs.newRuntime();
    const context = runtime.newContext();
    const pending = new Map();
    // Refused calls whose result is still to be delivered from a host microtask
    // (see the refusal branch in __ptcCall). Kept apart from `pending`: they
    // never reached the bridge, so they are not unsettled child calls.
    const refusals = new Map();
    const pendingDeliveries = new Map();
    let rootHandle;
    // Setup-script decoder that calls the JSON.parse saved before guest code
    // ran; see resolveDecoded.
    let decodeHandle;
    let stopped = input.signal.aborted;
    const compute = createComputeClock(input.onActivityChange);
    let callCount = 0;
    let pumping = false;
    const checkInterrupted = () => {
        if (stopped || input.signal.aborted)
            return true;
        return compute.currentMs() >= input.maxComputeMs;
    };
    const pump = () => {
        if (pumping || stopped)
            return;
        pumping = true;
        try {
            compute.measure(() => {
                const result = runtime.executePendingJobs();
                if ('error' in result && result.error)
                    result.error.dispose();
            });
        }
        finally {
            pumping = false;
        }
    };
    const rejectPending = (message) => {
        for (const deferred of pending.values()) {
            if (!deferred.alive)
                continue;
            const error = context.newError(message);
            deferred.reject(error);
            error.dispose();
        }
        pump();
    };
    const abort = () => {
        stopped = true;
        rejectPending('PTC execution stopped.');
    };
    runtime.setMemoryLimit(input.maxHeapBytes);
    runtime.setInterruptHandler(checkInterrupted);
    if (input.scriptRoots) {
        installPtcScriptModuleLoader(runtime, input, input.scriptRoots, compute.measure);
    }
    input.signal.addEventListener('abort', abort, { once: true });
    try {
        const names = new Set(input.tools.map((tool) => tool.name));
        const callback = context.newFunction('__ptcCall', (nameHandle, argsHandle) => {
            const deferred = context.newPromise();
            try {
                const name = context.getString(nameHandle);
                const argsJson = context.getString(argsHandle);
                if (!names.has(name))
                    throw new Error(`Tool is not available to PTC: ${name}`);
                if (stopped || input.signal.aborted)
                    throw new Error('PTC execution stopped.');
                const requestId = `ptc-${++callCount}`;
                if (callCount > input.maxToolCalls) {
                    // Over the budget the call is refused without running, and the program
                    // keeps going: earlier results stay usable instead of being discarded
                    // with a stopped program. The host counts each refusal for the outer note.
                    input.onLimitExceeded?.('tool_calls');
                    // Delivered from a host microtask, never inside this callback: guest
                    // frames are on the stack here, and resolving with an object looks
                    // up `then` on it, which guest code can turn into an accessor that
                    // calls tools again and so re-enters this callback without bound
                    // (the runtime then aborts at teardown with
                    // list_empty(&rt->gc_obj_list) and the result is lost). From a
                    // microtask such an accessor runs once per refusal, within the
                    // compute budget.
                    refusals.set(requestId, deferred);
                    queueMicrotask(() => settleRefusal(requestId));
                    return deferred.handle;
                }
                pending.set(requestId, deferred);
                const delivery = (async () => {
                    try {
                        settleDeferred(requestId, deferred, await input.callTool({ requestId, name, argsJson }));
                    }
                    catch (error) {
                        rejectDeferred(requestId, deferred, error);
                    }
                    finally {
                        pendingDeliveries.delete(requestId);
                    }
                })();
                pendingDeliveries.set(requestId, delivery);
            }
            catch (error) {
                const handle = guestErrorHandle(context, error);
                deferred.reject(handle);
                handle.dispose();
            }
            return deferred.handle;
        });
        context.setProp(context.global, '__ptcCall', callback);
        callback.dispose();
        // Console output leaves the guest at once, so it survives a later guest
        // error or a host stop; the Worker applies the byte budget.
        const consoleCallback = context.newFunction('__ptcConsole', (lineHandle) => {
            if (!stopped)
                input.onConsole?.(readConsoleLine(context, lineHandle));
        });
        context.setProp(context.global, '__ptcConsole', consoleCallback);
        consoleCallback.dispose();
        const withStore = typeof input.storeValue === 'function';
        if (withStore)
            bindStore(context, input);
        const setup = compute.measure(() => evaluate(context, createToolsSetup(input.tools.map((tool) => tool.name), input.directOnlyTools ?? [], withStore), 'ptc_runtime.js'));
        setup.dispose();
        // The setup script leaves its decoder on the global object only long
        // enough for the host to take a handle; guest code never sees it.
        decodeHandle = context.getProp(context.global, '__ptcDecodeForHost');
        evaluate(context, 'delete globalThis.__ptcDecodeForHost;', 'ptc_runtime.js').dispose();
        rootHandle = compute.measure(() => evaluate(context, wrapCode(input.code), 'run_code.js'));
        const rootResult = context.resolvePromise(rootHandle);
        pump();
        const resolved = await rootResult;
        const valueHandle = unwrap(context, resolved);
        try {
            return {
                ok: true,
                ...readEncodedResult(context, valueHandle),
                pendingRequestIds: [...pending.keys()],
            };
        }
        finally {
            valueHandle.dispose();
        }
    }
    catch (error) {
        return {
            ok: false,
            error: guestFailure(error, stopped || input.signal.aborted, compute.currentMs() >= input.maxComputeMs),
            pendingRequestIds: [...pending.keys()],
        };
    }
    finally {
        input.signal.removeEventListener('abort', abort);
        stopped = true;
        pendingDeliveries.clear();
        rejectPending('PTC execution ended.');
        rootHandle?.dispose();
        decodeHandle?.dispose();
        for (const deferred of pending.values())
            if (deferred.alive)
                deferred.dispose();
        // A refusal still waiting for its microtask holds QuickJS handles too.
        for (const deferred of refusals.values())
            if (deferred.alive)
                deferred.dispose();
        refusals.clear();
        // WASM memory grows inside the job queue while large modules compile, and
        // JS_FreeRuntime then aborts the process ("Assertion failed:
        // list_empty(&rt->gc_obj_list)") after the program already produced its
        // result. The result is already computed here, so a failed teardown must
        // not replace it with a lost one; only the reason is reported.
        disposeGuest(context, runtime, input.onRuntimeDisposeFailed);
    }
    /**
     * Delivers a refused call's result after the guest call returned (see the
     * refusal branch in __ptcCall). A program that already ended disposed the
     * deferred in its finally block; a stopped one never resumes, so only the
     * handles are freed.
     */
    function settleRefusal(requestId) {
        const deferred = refusals.get(requestId);
        if (!deferred)
            return;
        refusals.delete(requestId);
        if (stopped) {
            deferred.dispose();
            return;
        }
        const refusal = ptcToolCallLimitRefusal(requestId, input.maxToolCalls);
        settleDeferred(requestId, deferred, JSON.stringify(refusal));
    }
    function settleDeferred(requestId, deferred, resultJson) {
        pending.delete(requestId);
        if (stopped || !deferred.alive)
            return;
        // Copying the host result into QuickJS and parsing it is host work, so it
        // is not charged to the guest compute budget: two multi-megabyte reads
        // spent about a second there without running one line of guest code, and
        // the program was killed with compute_budget_exceeded.
        const decoded = decodeResult(context, decodeHandle, resultJson);
        // Settling stays inside the budget: resolving looks up `then` on the
        // result, which guest code can define as an accessor (see the refusal
        // branch in __ptcCall), so moving this out too would let a guest loop
        // there with only the wall clock left to stop it.
        compute.measure(() => settleDecoded(deferred, decoded));
        deferred.dispose();
        queueMicrotask(pump);
    }
    function rejectDeferred(requestId, deferred, error) {
        pending.delete(requestId);
        if (stopped || !deferred.alive)
            return;
        const handle = guestErrorHandle(context, error);
        deferred.reject(handle);
        handle.dispose();
        deferred.dispose();
        queueMicrotask(pump);
    }
}
/**
 * Binds the two host halves of `store` and `load` before the setup script
 * wraps them in the guest-visible functions. `__ptcLoadValue` hands back the
 * value's JSON text so the guest parses it with the JSON.parse saved before
 * guest code ran; `__ptcStore` receives the text the guest encoded with
 * `__ptcToJsonData`, so both sides follow one encoding rule.
 */
function bindStore(context, input) {
    const countLoad = context.newFunction('__ptcCountLoad', () => {
        input.onStoreLoad?.();
    });
    context.setProp(context.global, '__ptcCountLoad', countLoad);
    countLoad.dispose();
    const countRejected = context.newFunction('__ptcCountRejected', () => {
        input.onStoreRejected?.();
    });
    context.setProp(context.global, '__ptcCountRejected', countRejected);
    countRejected.dispose();
    const store = context.newFunction('__ptcStore', (keyHandle, valueHandle, descHandle) => {
        const key = readStoreKey(context, keyHandle, 'store');
        // The guest always sends JSON text. Anything else must not be read as
        // text: a value that encoded to nothing arrives as undefined, and reading
        // it would store the word "undefined", which the next load cannot parse.
        if (context.typeof(valueHandle) !== 'string') {
            throw new Error('PTC store value must be JSON text.');
        }
        const valueJson = context.getString(valueHandle);
        const desc = context.typeof(descHandle) === 'string' ? context.getString(descHandle) : undefined;
        input.storeValue?.(key, valueJson, desc);
    });
    context.setProp(context.global, '__ptcStore', store);
    store.dispose();
    const load = context.newFunction('__ptcLoadValue', (keyHandle) => {
        const key = readStoreKey(context, keyHandle, 'load');
        const json = input.loadValue?.(key);
        return json === undefined ? context.undefined : context.newString(json);
    });
    context.setProp(context.global, '__ptcLoadValue', load);
    load.dispose();
}
/** Reads a guest key, refusing anything the host store would refuse. */
function readStoreKey(context, handle, fn) {
    const key = context.typeof(handle) === 'string' ? context.getString(handle) : '';
    if (key.length === 0 || key.length > PTC_STORE_MAX_KEY_LENGTH) {
        throw new Error(ptcStoreKeyMessage(fn));
    }
    return key;
}
function evaluate(context, source, fileName) {
    return unwrap(context, context.evalCode(source, fileName));
}
/**
 * Frees the guest at the end of a program without letting a teardown abort
 * discard the result that was already computed.
 *
 * quickjs-emscripten 0.31 can reach `JS_FreeRuntime` with objects still on
 * the runtime's GC list and abort on `list_empty(&rt->gc_obj_list)`: a program
 * that allocates a few MiB or more after it awaited a host call leaves such
 * objects behind (the allocation happens in a resumed job, after the host
 * already handed a handle back). The abort used to propagate out of this
 * `finally`, so a program that had already produced its return value lost it
 * and the whole Worker died. The guest is unreachable from here either way,
 * and the Worker is terminated right after, so swallowing the abort only
 * gives up memory the process is about to release anyway.
 *
 * Both calls are attempted: `context.dispose()` can throw the same way, and
 * skipping `runtime.dispose()` after it would leak the whole runtime. Either
 * failure is reported through the same callback, with its own code, so a
 * context that could not be freed leaves the same trace a lost runtime does.
 */
function disposeGuest(context, runtime, onRuntimeDisposeFailed) {
    try {
        context.dispose();
    }
    catch (error) {
        // Teardown aborts are not the program's outcome; see the comment above.
        onRuntimeDisposeFailed?.({
            code: 'context_dispose_failed',
            message: disposeFailureMessage(error),
        });
    }
    try {
        runtime.dispose();
    }
    catch (error) {
        // The Worker is torn down right after this anyway, so the result stands
        // and only the reason is reported.
        onRuntimeDisposeFailed?.({
            code: 'runtime_dispose_failed',
            message: disposeFailureMessage(error),
        });
    }
}
/**
 * Parses a host result and returns the handle to settle the guest call with.
 * JSON.parse runs in a direct host-to-guest call, not in a promise job (the
 * former `.then(JSON.parse)`): with quickjs-emscripten 0.31, parsing a string
 * of about 4 MB or more inside a job leaks QuickJS objects, so freeing the
 * runtime aborts the Worker with "Assertion failed:
 * list_empty(&rt->gc_obj_list)" after the program already finished and its
 * result is lost. Sixteen parallel ~1 MiB glob results hit it; the same parse
 * in a direct call frees cleanly. The decoder calls the JSON.parse saved
 * before guest code ran, so decoding itself never runs guest code. Only
 * called from host microtasks, never inside a guest-to-host callback:
 * settling with an object looks up `then` on it, and a guest accessor there
 * must not be able to re-enter the callback.
 *
 * The caller does not measure compute time here. This step only copies bytes
 * into QuickJS and runs the saved JSON.parse, and a multi-megabyte result
 * takes long enough on a loaded machine to exhaust the budget on its own; the
 * wall clock still covers it.
 */
function decodeResult(context, decoder, resultJson) {
    if (!decoder)
        throw new Error('PTC result decoder is not ready.');
    const text = context.newString(resultJson);
    try {
        const decoded = context.callFunction(decoder, context.undefined, text);
        return 'value' in decoded ? { value: decoded.value } : { error: decoded.error };
    }
    finally {
        text.dispose();
    }
}
/**
 * Settles a guest call with an already parsed result. The caller measures
 * compute time here, unlike the decode step: `resolve` looks up `then` on
 * the result and the guest can define that as an accessor, so this is guest
 * code and has to stay inside the compute budget.
 *
 * Invalid JSON, or the guest heap or compute budget running out while
 * parsing, rejects only this call: the guest sees that error here, as with
 * the former promise-job parse, and the program decides what to do with it.
 */
function settleDecoded(deferred, decoded) {
    if ('value' in decoded) {
        deferred.resolve(decoded.value);
        decoded.value.dispose();
        return;
    }
    deferred.reject(decoded.error);
    decoded.error.dispose();
}
/**
 * `store` and `load`, added only when the host gave this program a store.
 *
 * Both are synchronous. `store` encodes with the same rule as a return value
 * (`__ptcToJsonData`), so a value that could be returned can be stored, and
 * refuses `undefined` — and a value whose encoding is `undefined`, such as one
 * whose `toJSON` returns it — because the store has no delete: storing `null`
 * over a key only appends another record, it does not free the bytes already
 * written.
 * `load` returns whatever `__ptcLoadValue` holds, or
 * undefined when the Session never stored that key; the parse uses the
 * JSON.parse saved before guest code ran, so a program that replaced JSON
 * still gets its real stored values, and the result is always a fresh copy.
 */
const STORE_SETUP = `
const __ptcStoreSink = globalThis.__ptcStore;
const __ptcLoadSink = globalThis.__ptcLoadValue;
const __ptcCountLoadSink = globalThis.__ptcCountLoad;
const __ptcCountRejectedSink = globalThis.__ptcCountRejected;
const __ptcStoreKey = (key, fn) => {
  if (typeof key !== "string" || key.length === 0 || key.length > ${PTC_STORE_MAX_KEY_LENGTH}) {
    throw new TypeError(fn === "load" ? ${JSON.stringify(ptcStoreKeyMessage('load'))} : ${JSON.stringify(ptcStoreKeyMessage('store'))});
  }
  return key;
};
// One catch per entry point counts the refusal exactly once, whatever raised
// it: the key rules, an undefined value, a desc that is not a string, anything
// __ptcToJsonData refuses (cycles, BigInt, Map/Set, class instances) and the
// bridge's own size limit. Counting at each throw site instead would miss the
// encoder's failures and double-count the ones the host also sees.
globalThis.store = (key, value, desc) => {
  try {
    __ptcStoreKey(key, "store");
    if (value === undefined) {
      throw new TypeError("PTC store cannot delete a key: store(key, undefined) is not supported.");
    }
    if (desc !== undefined && typeof desc !== "string") {
      throw new TypeError("PTC store desc must be a string.");
    }
    const encoded = __ptcToJsonData(value, "PTC stored value is");
    if (encoded.value === __ptcSkipped) {
      throw new TypeError("PTC stored value is not JSON-serializable at $: a function is not JSON data");
    }
    // JSON.stringify of this symbol is undefined, which the host sink would
    // otherwise read as the text "undefined" and the next load could not
    // parse. A return value treats the same encoding as "no value"; the store
    // cannot, because it has no delete.
    if (encoded.value === __ptcUndefined) {
      throw new TypeError("PTC store cannot delete a key: this value encodes to undefined, e.g. its toJSON returned undefined.");
    }
    __ptcStoreSink(key, JSON.stringify(encoded.value), desc);
  } catch (error) {
    __ptcCountRejectedSink();
    throw error;
  }
};
globalThis.load = (key) => {
  __ptcCountLoadSink();
  try {
    __ptcStoreKey(key, "load");
    const json = __ptcLoadSink(key);
    return json === undefined ? undefined : __ptcJsonParse(json);
  } catch (error) {
    __ptcCountRejectedSink();
    throw error;
  }
};
delete globalThis.__ptcStore;
delete globalThis.__ptcLoadValue;
delete globalThis.__ptcCountLoad;
delete globalThis.__ptcCountRejected;
`;
/** Shown instead of a console line that was not a primitive string. */
const DROPPED_CONSOLE_LINE = '[PTC dropped a console line that was not a string]';
/**
 * Only a primitive string is read. getString on anything else runs the
 * guest's toString inside the console host callback, where it can log again
 * and re-enter without bound. The setup formatter always passes a string
 * unless guest code replaced Array.prototype.map or join; the marker line
 * keeps such a drop visible in the outer result.
 */
function readConsoleLine(context, handle) {
    return context.typeof(handle) === 'string' ? context.getString(handle) : DROPPED_CONSOLE_LINE;
}
function unwrap(context, result) {
    if ('value' in result)
        return result.value;
    const failure = result.error;
    if (!failure)
        throw new Error('QuickJS returned an empty failure.');
    try {
        throw new Error(guestErrorText(context.dump(failure)));
    }
    finally {
        failure.dispose();
    }
}
/**
 * The error of tools.<name> for a tool this Turn offers only as a direct call.
 * The Chinese sentence is the product wording the model and the user read; the
 * English one says what to do instead.
 */
function ptcDirectOnlyToolError(name) {
    return `${name} 只能直接调用，不能在 run_code 里调用。Call ${name} as a top-level tool call outside run_code.`;
}
function createToolsSetup(names, directOnly, withStore = false) {
    const callable = new Set(names);
    const definitions = names
        .map((name) => `Object.defineProperty(__ptcTools, ${JSON.stringify(name)}, { enumerable: true, value: (args) => __ptcCall(${JSON.stringify(name)}, __ptcEncodeArgs(args)) });`)
        .join('\n');
    // Not enumerable: Object.keys(tools) still lists only what a program can call.
    // The throw stops the program like the "not a function" it replaces, so no
    // later call of the same program runs on a wrong assumption.
    const directOnlyStubs = [...new Set(directOnly)]
        .filter((name) => !callable.has(name))
        .map((name) => `Object.defineProperty(__ptcTools, ${JSON.stringify(name)}, { enumerable: false, value: () => { throw new TypeError(${JSON.stringify(ptcDirectOnlyToolError(name))}); } });`)
        .join('\n');
    // The JSON boundary follows JSON.stringify (undefined fields dropped, array
    // holes/undefined/NaN/Infinity become null, functions dropped, toJSON
    // honoured) because models write code that relies on it. What JSON.stringify
    // would turn into silent garbage still fails, naming the field path: cycles,
    // BigInt, and class instances such as Map or Set (they would become {}).
    return `
const __ptcTools = Object.create(null);
const __ptcUnsafeKeys = new Set(["__proto__", "constructor", "prototype"]);
const __ptcUndefined = Symbol("undefined");
const __ptcSkipped = Symbol("skipped");
const __ptcIdentifier = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const __ptcMaxDepth = 100;
const __ptcMaxReportedDrops = ${MAX_REPORTED_DROPPED_PATHS};
const __ptcChildPath = (path, key) => typeof key === "number"
  ? path + "[" + key + "]"
  : __ptcIdentifier.test(key) ? path + "." + key : path + "[" + JSON.stringify(key) + "]";
const __ptcUnsupported = (value) => {
  if (value instanceof Map) return "Map is not JSON data; convert it with Object.fromEntries(map)";
  if (value instanceof Set) return "Set is not JSON data; convert it with Array.from(set)";
  if (value instanceof Promise) return "a Promise is not JSON data; await it first";
  let name = "Object";
  try {
    const candidate = Object.getPrototypeOf(value)?.constructor?.name;
    if (typeof candidate === "string" && candidate) name = candidate;
  } catch {}
  return name + " instance is not JSON data; use plain objects and arrays";
};
const __ptcToJsonData = (root, label) => {
  const seen = new Set();
  const dropped = [];
  let droppedCount = 0;
  const fail = (path, reason) => {
    throw new TypeError(label + " not JSON-serializable at " + path + ": " + reason);
  };
  const visit = (key, input, path, depth) => {
    let value = input;
    if ((typeof value === "object" && value !== null) || typeof value === "bigint") {
      const toJSON = value.toJSON;
      if (typeof toJSON === "function") value = toJSON.call(value, String(key));
    }
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (value === undefined) return __ptcUndefined;
    if (typeof value === "function" || typeof value === "symbol") return __ptcSkipped;
    if (typeof value === "bigint") fail(path, "BigInt is not JSON data; convert it with String() or Number()");
    if (value instanceof Number) return visit(key, Number(value), path, depth);
    if (value instanceof String) return String(value);
    if (value instanceof Boolean) return value.valueOf();
    if (depth >= __ptcMaxDepth) fail(path, "nesting is deeper than " + __ptcMaxDepth + " levels");
    if (seen.has(value)) fail(path, "circular reference");
    seen.add(value);
    let output;
    if (Array.isArray(value)) {
      output = [];
      for (let index = 0; index < value.length; index += 1) {
        const item = visit(index, value[index], __ptcChildPath(path, index), depth + 1);
        output.push(typeof item === "symbol" ? null : item);
      }
    } else {
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) fail(path, __ptcUnsupported(value));
      output = {};
      for (const name of Object.keys(value)) {
        const childPath = __ptcChildPath(path, name);
        if (__ptcUnsafeKeys.has(name)) fail(childPath, "unsafe property name");
        const item = visit(name, value[name], childPath, depth + 1);
        if (item === __ptcUndefined) {
          droppedCount += 1;
          if (dropped.length < __ptcMaxReportedDrops) dropped.push(childPath);
          continue;
        }
        if (item === __ptcSkipped) continue;
        output[name] = item;
      }
    }
    seen.delete(value);
    return output;
  };
  return { value: visit("", root, "$", 0), dropped, droppedCount };
};
const __ptcEncodeArgs = (args) => {
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    throw new TypeError("PTC tool arguments must be an object.");
  }
  const encoded = __ptcToJsonData(args, "PTC tool arguments are");
  if (encoded.value === null || typeof encoded.value !== "object" || Array.isArray(encoded.value)) {
    throw new TypeError("PTC tool arguments must be an object.");
  }
  return JSON.stringify(encoded.value);
};
// No return (undefined) is a valid outcome: the outer result then says
// "No return value." instead of failing a program that already did its work.
const __ptcEncodeResult = (value) => {
  if (value === undefined) return { json: undefined, dropped: [], droppedCount: 0 };
  const encoded = __ptcToJsonData(value, "PTC return value is");
  if (encoded.value === __ptcUndefined) return { json: undefined, dropped: [], droppedCount: 0 };
  if (encoded.value === __ptcSkipped) {
    throw new TypeError("PTC return value is not JSON-serializable at $: a function is not JSON data");
  }
  return { json: JSON.stringify(encoded.value), dropped: encoded.dropped, droppedCount: encoded.droppedCount };
};
// console.*: arguments joined by spaces, strings as is, other values as JSON.
const __ptcFormat = (value) => {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.name + ": " + value.message;
  try {
    const json = JSON.stringify(value);
    if (json !== undefined) return json;
  } catch {}
  try {
    return String(value);
  } catch {
    return "[unprintable]";
  }
};
const __ptcConsoleSink = globalThis.__ptcConsole;
const __ptcLog = (...args) => {
  __ptcConsoleSink(args.map(__ptcFormat).join(" "));
};
// Saved before any guest code runs. The host calls the decoder directly, so it
// must never run code the guest can replace: a JSON.parse replaced with a
// function that called tools again re-entered the host without bound and broke
// runtime teardown. JSON.parse without a reviver creates properties with
// CreateDataProperty, so no prototype setter runs either. As a consequence a
// guest that replaces or removes JSON still receives the real tool results.
// (A const: guest code can see the binding but cannot rebind it.)
const __ptcJsonParse = JSON.parse;
// The host takes this decoder and deletes the global before guest code runs;
// results are parsed by a direct host call, never in a promise job.
globalThis.__ptcDecodeForHost = (json) => __ptcJsonParse(json);
${definitions}
${directOnlyStubs}
Object.freeze(__ptcTools);
globalThis.tools = __ptcTools;
globalThis.console = Object.freeze({ log: __ptcLog, info: __ptcLog, warn: __ptcLog, error: __ptcLog, debug: __ptcLog });
// Codex code mode habits. Models write text(r.output) and, after reading an
// image, image(r.data.content); in the 969645 eval 168 programs failed with
// "'text' is not defined" (99) or "'image' is not defined" (69, all GDPval63).
// text() logs exactly like console.log. image() returns its argument: images a
// tool read are already attached to the run_code result (media-projection.ts,
// also when the program fails), so it only has to not throw. Plain writable
// globals, so a program's own const/let/function or assignment still wins.
// Deliberately not in the run_code description or PTC section.
globalThis.text = __ptcLog;
globalThis.image = (value) => value;
${withStore ? STORE_SETUP : ''}
delete globalThis.__ptcConsole;
delete globalThis.process;
delete globalThis.require;
delete globalThis.fetch;
delete globalThis.setTimeout;
delete globalThis.setInterval;
`;
}
/**
 * Reads the `{ json, dropped, droppedCount }` envelope built by
 * `__ptcEncodeResult`. Guest code can monkeypatch JSON or Array globals, so
 * every field is validated here instead of being trusted.
 */
function readEncodedResult(context, handle) {
    const json = readProp(context, handle, 'json');
    if (json === undefined)
        return { droppedUndefinedPaths: [], droppedUndefinedCount: 0 };
    if (typeof json !== 'string')
        throw new Error('PTC returned a value that is not JSON text.');
    const dropped = readProp(context, handle, 'dropped');
    const droppedCount = readProp(context, handle, 'droppedCount');
    const paths = Array.isArray(dropped)
        ? dropped.filter((path) => typeof path === 'string')
        : [];
    return {
        valueJson: json,
        droppedUndefinedPaths: paths.slice(0, MAX_REPORTED_DROPPED_PATHS),
        droppedUndefinedCount: typeof droppedCount === 'number' && Number.isSafeInteger(droppedCount) && droppedCount >= 0
            ? Math.max(droppedCount, paths.length)
            : paths.length,
    };
}
function readProp(context, handle, key) {
    const property = context.getProp(handle, key);
    try {
        return context.dump(property);
    }
    finally {
        property.dispose();
    }
}
function wrapCode(code) {
    return `(async () => {\n${code}\n})().then(__ptcEncodeResult)`;
}
function guestFailure(error, stopped, computeExceeded) {
    if (computeExceeded) {
        return {
            code: 'compute_budget_exceeded',
            message: 'PTC exceeded its JavaScript compute budget.',
        };
    }
    if (stopped)
        return { code: 'cancelled', message: 'PTC execution was stopped.' };
    return { code: 'guest_error', message: scrubGuestError(errorMessage(error)) };
}
function errorMessage(error) {
    if (error instanceof Error)
        return error.message;
    return guestErrorText(error);
}
function guestErrorHandle(context, error) {
    const handle = context.newError(errorMessage(error));
    const failure = readPtcFailure(error);
    if (!failure)
        return handle;
    for (const [key, value] of [
        ['code', failure.code],
        ['toolCallId', failure.toolCallId],
        ['retryable', failure.retryable],
    ]) {
        if (value === undefined)
            continue;
        const property = typeof value === 'boolean' ? booleanHandle(context, value) : context.newString(value);
        context.setProp(handle, key, property);
        if (typeof value !== 'boolean')
            property.dispose();
    }
    return handle;
}
function booleanHandle(context, value) {
    return value ? context.true : context.false;
}
function readPtcFailure(error) {
    if (!error || typeof error !== 'object')
        return undefined;
    const failure = Reflect.get(error, 'failure');
    if (!failure || typeof failure !== 'object')
        return undefined;
    const code = Reflect.get(failure, 'code');
    if (typeof code !== 'string' || !code)
        return undefined;
    const toolCallId = Reflect.get(failure, 'toolCallId');
    const retryable = Reflect.get(failure, 'retryable');
    return {
        code,
        ...(typeof toolCallId === 'string' && toolCallId ? { toolCallId } : {}),
        ...(typeof retryable === 'boolean' ? { retryable } : {}),
    };
}
function guestErrorText(error) {
    if (error && typeof error === 'object') {
        const message = Reflect.get(error, 'message');
        const stack = Reflect.get(error, 'stack');
        if (typeof message === 'string' && typeof stack === 'string')
            return `${message}\n${stack}`;
        if (typeof message === 'string')
            return message;
    }
    return String(error);
}
function scrubGuestError(message) {
    return message
        .replace(/file:\/\/[^\s)]+/g, 'run_code.js')
        .split('\n')
        .filter((line) => !line.includes('ptc_runtime.js') &&
        !line.includes('__ptcEncodeResult') &&
        !/^\s*at <eval> \(run_code\.js:\d+(?::\d+)?\)\s*$/.test(line))
        .join('\n')
        .replace(/run_code\.js:(\d+)(?::(\d+))?/g, (_match, line, column) => {
        const adjustedLine = Math.max(1, Number(line) - 1);
        return `run_code.js:${adjustedLine}${column ? `:${column}` : ''}`;
    });
}
//# sourceMappingURL=quickjs-runtime.js.map