import { Worker } from 'node:worker_threads';
import { isExtensionErrorCode } from '../sdk/diagnostics.js';
import { unpackedFileUrl } from '../../../infra/util/asar-unpacked-path.js';
import { attributeCrash } from './breaker.js';
import { CLOSED, CRASHED, EXPIRED, LayerAborted, LayerError } from './dispatcher.js';
import { ATTRIBUTION_BYTES, readAttribution } from './protocol.js';
/**
 * Worker supervision (two.md §2.2–§2.3): one shared Worker or one per plugin, a generation per
 * Worker lifetime, an in-flight table that fails on terminate, heartbeat, and attribution read
 * from shared memory when a Worker dies.
 */
/**
 * Real Worker with a minimal environment and a heap cap (two.md §2.4 一期能做的收窄). A packaged app
 * starts it from `app.asar.unpacked`; its import graph must stay inside `asarUnpack`.
 */
export function createNodeWorkerFactory(entry = unpackedFileUrl('./realm/worker.js', import.meta.url)) {
    return (init) => new Worker(entry, {
        name: init.name,
        env: {},
        workerData: { attribution: init.attribution, generation: init.generation },
        resourceLimits: { maxOldGenerationSizeMb: init.resourceLimitMb },
        execArgv: process.execArgv.filter((argument) => !argument.startsWith('--input-type')),
    });
}
export class RealmLoadError extends Error {
    wire;
    constructor(wire) {
        super(wire.message);
        this.wire = wire;
    }
}
function toWireError(error) {
    if (error instanceof LayerError) {
        return {
            code: error.code,
            message: error.message,
            ...(error.fromInner ? { fromInner: true } : {}),
        };
    }
    if (error instanceof LayerAborted)
        return { code: 'aborted', message: error.message, fromInner: true };
    const code = error?.code;
    const message = error instanceof Error ? error.message : String(error);
    if (typeof code === 'string' && isExtensionErrorCode(code))
        return { code, message };
    return { code: 'EXTENSION_SERVICE_FAILED', message };
}
export class WorkerSlot {
    key;
    options;
    generation = 0;
    worker;
    memory = new Int32Array(new SharedArrayBuffer(ATTRIBUTION_BYTES));
    realms = new Map();
    realmByNo = new Map();
    loads = new Map();
    calls = new Map();
    /** `ctx` requests of the current generation still being served, by request id. */
    requests = new Map();
    replies = new WeakSet();
    realmSeq = 0;
    loadSeq = 0;
    pingSeq = 0;
    lastPong = 0;
    heartbeat;
    constructor(key, options) {
        this.key = key;
        this.options = options;
    }
    get loadedRealms() {
        return [...this.realms.keys()];
    }
    hasRealm(realmKey) {
        return this.realms.has(realmKey);
    }
    async ensureRealm(spec) {
        const existing = this.realms.get(spec.realmKey);
        if (existing)
            return existing.load;
        const worker = this.ensureWorker();
        this.realmSeq += 1;
        this.loadSeq += 1;
        const realmNo = this.realmSeq;
        const id = this.loadSeq;
        const load = new Promise((resolve, reject) => {
            this.loads.set(id, { resolve, reject });
        });
        this.realms.set(spec.realmKey, { realmNo, load });
        this.realmByNo.set(realmNo, spec.realmKey);
        worker.postMessage({
            t: 'load',
            id,
            realmKey: spec.realmKey,
            realmNo,
            pluginId: spec.pluginId,
            version: spec.version,
            code: spec.code,
            expected: spec.expected,
            slots: this.options.slots,
            calls: spec.calls,
            syncTimeoutMs: this.options.limits.syncTimeoutMs,
            minClockIntervalMs: this.options.limits.minClockIntervalMs,
        });
        try {
            return await load;
        }
        catch (error) {
            if (this.realms.get(spec.realmKey)?.load === load)
                this.forgetRealm(spec.realmKey);
            throw error;
        }
    }
    invoke(inv, handlers, signal) {
        const worker = this.worker;
        if (!worker || !this.realms.has(inv.realmKey)) {
            return Promise.reject(new LayerAborted(CRASHED));
        }
        return new Promise((resolve, reject) => {
            const onAbort = () => {
                this.calls.delete(inv.callId);
                if (this.worker === worker)
                    worker.postMessage({ t: 'abort', callId: inv.callId });
                reject(new LayerAborted(String(signal.reason)));
            };
            if (signal.aborted) {
                reject(new LayerAborted(String(signal.reason)));
                return;
            }
            signal.addEventListener('abort', onAbort, { once: true });
            this.calls.set(inv.callId, {
                realmKey: inv.realmKey,
                handlers,
                settle: (result) => {
                    signal.removeEventListener('abort', onAbort);
                    if (result.ok)
                        resolve(result);
                    else
                        reject(invocationError(result.error));
                },
                fail: (error) => {
                    signal.removeEventListener('abort', onAbort);
                    reject(error);
                },
            });
            worker.postMessage({ t: 'invoke', inv });
        });
    }
    release(realmKey, renderSeqs) {
        if (this.realms.has(realmKey))
            this.post({ t: 'release', realmKey, renderSeqs });
    }
    dropSession(realmKey, sessionId) {
        if (this.realms.has(realmKey))
            this.post({ t: 'drop-session', realmKey, sessionId });
    }
    unload(realmKey) {
        if (!this.realms.has(realmKey))
            return;
        this.post({ t: 'unload', realmKey });
        this.forgetRealm(realmKey);
    }
    async close() {
        const worker = this.worker;
        this.teardown(new LayerAborted(CLOSED));
        if (worker)
            await terminateQuietly(worker);
    }
    post(message) {
        this.worker?.postMessage(message);
    }
    forgetRealm(realmKey) {
        const realm = this.realms.get(realmKey);
        this.realms.delete(realmKey);
        if (realm)
            this.realmByNo.delete(realm.realmNo);
    }
    ensureWorker() {
        if (this.worker)
            return this.worker;
        const attribution = new SharedArrayBuffer(ATTRIBUTION_BYTES);
        this.memory = new Int32Array(attribution);
        const worker = this.options.factory({
            attribution,
            generation: this.generation,
            name: `mcode-extension-${this.key}`,
            resourceLimitMb: this.options.limits.resourceLimitMb,
        });
        this.worker = worker;
        worker.on('message', (message) => {
            if (this.worker === worker)
                this.receive(message);
        });
        worker.on('error', () => this.die(worker, 'error'));
        worker.on('exit', () => this.die(worker, 'exit'));
        this.lastPong = this.options.clock.now();
        this.scheduleHeartbeat(worker);
        return worker;
    }
    scheduleHeartbeat(worker) {
        const { clock, limits } = this.options;
        this.heartbeat = clock.setTimeout(() => {
            if (this.worker !== worker)
                return;
            if (clock.now() - this.lastPong > limits.heartbeatTimeoutMs) {
                this.die(worker, 'heartbeat');
                return;
            }
            this.pingSeq += 1;
            worker.postMessage({ t: 'ping', n: this.pingSeq });
            this.scheduleHeartbeat(worker);
        }, limits.heartbeatIntervalMs);
    }
    receive(message) {
        switch (message.t) {
            case 'pong':
                this.lastPong = this.options.clock.now();
                return;
            case 'loaded':
                this.settleLoad(message);
                return;
            case 'result':
                this.settleCall(message);
                return;
            case 'next':
            case 'ctx':
                this.replies.add(this.reply(message));
                return;
            case 'cancel':
                if (message.gen === this.generation)
                    this.requests.get(message.id)?.abort('cancelled');
                return;
            default:
                this.forward(message);
        }
    }
    forward(message) {
        const events = this.options.events;
        if (message.t === 'fire') {
            events.onFire(this.key, message);
        }
        else if (message.t === 'console') {
            events.onConsole(message.realmKey, message.level, message.text);
        }
        else {
            const call = this.calls.get(message.callId);
            if (call)
                call.handlers.onNotify(message.method, message.args);
            else
                events.onOrphanNotify(this, message.method, message.args);
        }
    }
    settleLoad(message) {
        const pending = this.loads.get(message.id);
        if (!pending)
            return;
        this.loads.delete(message.id);
        if (message.ok) {
            pending.resolve({ hooks: message.hooks, ...(message.state ? { state: message.state } : {}) });
        }
        else {
            pending.reject(new RealmLoadError(message.error));
        }
    }
    settleCall(message) {
        const call = this.calls.get(message.callId);
        if (!call)
            return;
        this.calls.delete(message.callId);
        call.settle(message);
    }
    /**
     * Answers only the Worker generation that asked. Its in-flight Invocations already failed with
     * `EXTENSION_WORKER_CRASHED` on teardown; a successor numbers its requests from the start again,
     * so a late answer would otherwise satisfy another session's request.
     */
    async reply(message) {
        const generation = this.generation;
        const call = this.calls.get(message.callId);
        const request = new AbortController();
        if (message.t === 'ctx')
            this.requests.set(message.id, request);
        let answer;
        try {
            if (!call)
                throw new LayerError('INVOCATION_SETTLED', 'the invocation has settled');
            const value = message.t === 'next'
                ? await call.handlers.onNext(message.event)
                : await call.handlers.onCtx(message.method, message.args, request.signal);
            answer = {
                t: 'reply',
                id: message.id,
                gen: message.gen,
                ok: true,
                ...(value === undefined ? {} : { value }),
            };
        }
        catch (error) {
            answer = {
                t: 'reply',
                id: message.id,
                gen: message.gen,
                ok: false,
                error: toWireError(error),
            };
        }
        finally {
            if (this.requests.get(message.id) === request)
                this.requests.delete(message.id);
        }
        if (this.generation === generation)
            this.post(answer);
    }
    die(worker, cause) {
        if (this.worker !== worker)
            return;
        const reading = readAttribution(this.memory);
        const written = reading.realmNo > 0 ? this.realmByNo.get(reading.realmNo) : undefined;
        const inflight = [...this.calls.values()].map((call) => call.realmKey);
        const realmKeys = this.loadedRealms;
        this.teardown(new LayerAborted(CRASHED));
        if (cause === 'heartbeat')
            this.replies.add(terminateQuietly(worker));
        this.options.events.onDeath({
            slotKey: this.key,
            cause,
            attribution: attributeCrash(written, inflight),
            realmKeys,
        });
    }
    /** Drops the Worker and fails every in-flight RPC (two.md §2.3 重建). */
    teardown(reason) {
        this.worker = undefined;
        this.generation += 1;
        this.options.clock.clearTimeout(this.heartbeat);
        const calls = [...this.calls.values()];
        const loads = [...this.loads.values()];
        const requests = [...this.requests.values()];
        this.calls.clear();
        this.requests.clear();
        this.loads.clear();
        this.realms.clear();
        this.realmByNo.clear();
        // Nobody waits for these answers any more; stop the work they started.
        for (const request of requests)
            request.abort('worker-replaced');
        for (const call of calls)
            call.fail(reason);
        for (const load of loads)
            load.reject(reason);
    }
}
/** A vm `timeout` on the hook's synchronous entry counts as its own-time running out. */
function invocationError(error) {
    if (error.code === 'timeout')
        return new LayerAborted(EXPIRED);
    return new LayerError(error.code, error.message, error.fromInner === true);
}
async function terminateQuietly(worker) {
    try {
        await worker.terminate();
    }
    catch {
        // A Worker that already exited has nothing left to release.
    }
}
export class WorkerSupervisor {
    options;
    slots = new Map();
    currentMode;
    constructor(options) {
        this.options = options;
        this.currentMode = options.isolation;
    }
    get mode() {
        return this.currentMode;
    }
    slotFor(pluginId) {
        const key = this.currentMode === 'shared' ? 'shared' : `plugin:${pluginId}`;
        let slot = this.slots.get(key);
        if (!slot) {
            slot = new WorkerSlot(key, this.options);
            this.slots.set(key, slot);
        }
        return slot;
    }
    /** Slot currently hosting `realmKey`, if any. */
    slotHosting(realmKey) {
        return [...this.slots.values()].find((slot) => slot.hasRealm(realmKey));
    }
    switchMode(mode) {
        this.currentMode = mode;
    }
    async close() {
        await Promise.all([...this.slots.values()].map((slot) => slot.close()));
        this.slots.clear();
    }
}
//# sourceMappingURL=supervisor.js.map