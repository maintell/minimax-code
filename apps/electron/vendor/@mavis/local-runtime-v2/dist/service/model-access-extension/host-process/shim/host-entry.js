import { validateModelAccessExtension } from '../../core/extension-validation.js';
import { observeModelAccessWork } from '../../core/settlement.js';
import { captureBoundTransport } from '../../request/validation.js';
import { captureModuleLimits } from '../../request/admission.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { MODEL_ACCESS_HOST_PROTOCOL, } from '../contracts.js';
import { encodeHostMessage, hostError, HostLineDecoder } from '../protocol.js';
import { ChildLoginFlows } from './login-flows.js';
import { HostRequestBodies } from './request-bodies.js';
import { CREDENTIAL_METHODS, dispatchCredential } from '../credentials/dispatch.js';
import { AUXILIARY_METHODS, dispatchAuxiliary } from '../rpc/dispatch.js';
import { MODEL_ACCESS_HOST_MAX_STREAM_CHUNK, ModelAccessHostCreditGate, validStreamWindow, } from '../stream.js';
import { attachHostFailureRef, hostFailureRef, ModelAccessHostFailureStore, restoreHostFailure, } from '../failure-codec.js';
const MAX_LINE_BYTES = 32 * 1024 * 1024;
const inflight = new Map();
const actualWork = new Set();
/** The same work by slot, so draining one extension of a group host does not wait on others. */
const slotWork = new Map();
const gates = new Map();
const transports = new Map();
const requestBodies = new HostRequestBodies((ref) => transports.has(ref));
const failures = new ModelAccessHostFailureStore();
const DEFAULT_SLOT = '';
const MAX_SLOTS = 64;
const slots = new Map();
/** transportRef -> slot, so unload disposes only that extension's transports. */
const transportSlots = new Map();
/**
 * The slot whose request is running, carried into everything that request schedules (timers,
 * promises, emitters), so a crash in a group host can name the extension that caused it.
 */
const slotScope = new AsyncLocalStorage();
let initialized = false;
let shuttingDown = false;
let crashed = false;
const epoch = process.argv.find((argument) => argument.startsWith('--model-access-epoch='))?.slice(21) ?? '';
// stdout is protocol-only. Provider diagnostics cannot corrupt the wire.
const stdoutWrite = process.stdout.write.bind(process.stdout);
const diagnostic = (...values) => {
    process.stderr.write(`${values.map((value) => String(value)).join(' ')}\n`);
};
Object.assign(console, { log: diagnostic, info: diagnostic, debug: diagnostic, warn: diagnostic });
const writeQueue = [];
let writing = false;
function send(message) {
    writeQueue.push(encodeHostMessage({
        ...message,
        version: MODEL_ACCESS_HOST_PROTOCOL,
        epoch,
    }));
    pumpWrites();
}
function pumpWrites() {
    if (writing)
        return;
    const line = writeQueue.shift();
    if (!line)
        return;
    writing = true;
    let accepted = false;
    try {
        accepted = stdoutWrite(line, 'utf8');
    }
    catch {
        process.exitCode = 1;
        return;
    }
    if (accepted) {
        writing = false;
        pumpWrites();
        return;
    }
    process.stdout.once('drain', () => {
        writing = false;
        pumpWrites();
    });
}
function contextOf(input, signal) {
    return Object.freeze({
        profileId: input.profileId,
        installationId: input.installationId,
        generation: input.generation,
        operationId: input.operationId,
        signal,
        enabledTargets: Object.freeze([...(input.enabledTargets ?? [])]),
        policyRevision: input.policyRevision ?? 0,
        dataDir: input.dataDir,
        hostDataDir: input.hostDataDir,
        ...(input.sessionKey ? { sessionKey: input.sessionKey } : {}),
    });
}
const LIFECYCLE_METHODS = new Set(['init', 'drain', 'shutdown', 'unload']);
const BODY_METHODS = new Set(['body.begin', 'body.chunk', 'body.end', 'body.discard']);
async function dispatch(request, signal) {
    if (shuttingDown)
        throw new Error('host_closed');
    const slotKey = request.slot ?? DEFAULT_SLOT;
    if (LIFECYCLE_METHODS.has(request.method))
        return dispatchLifecycle(request, slotKey);
    if (!initialized)
        throw new Error('host_not_initialized');
    const slot = slots.get(slotKey);
    if (!slot)
        throw Object.assign(new Error('host_slot_missing'), { code: 'host_slot_missing' });
    return dispatchSlot(request, signal, slot, slotKey);
}
async function dispatchLifecycle(request, slotKey) {
    if (request.method === 'init')
        return init(request.params, slotKey);
    if (request.method === 'shutdown')
        return shutdown();
    if (request.method === 'unload')
        return unload(slotKey);
    // drain
    if (request.slot === undefined)
        await settleWorkAndLogin();
    else
        await settleSlot(slotKey);
    return null;
}
function dispatchSlot(request, signal, slot, slotKey) {
    const extension = slot.extension;
    if (AUXILIARY_METHODS.has(request.method))
        return dispatchAuxiliary(request.method, request.params, signal, {
            extension,
            manifest: slot.manifest,
        });
    if (CREDENTIAL_METHODS.has(request.method))
        return dispatchCredential(request.method, request.params, signal, extension);
    if (BODY_METHODS.has(request.method))
        return requestBodies.dispatch(request.method, request.params);
    return dispatchActive(request, signal, slot, slotKey);
}
function dispatchActive(request, signal, slot, slotKey) {
    const current = slot.extension;
    const loginFlows = slot.loginFlows;
    const handlers = new Map([
        ['describe', () => describe(slot)],
        ['models', () => models(request.params, signal, current)],
        ['bindTransport', () => bindTransport(request.params, signal, current, slotKey)],
        ['fetch', () => fetchTransport(request.id, request.params, signal)],
        ['disposeTransport', () => disposeTransport(request.params)],
        ['classifyError', () => classifyError(request.params, current)],
        ['login.begin', () => loginFlows.begin(request.params, signal, current, slot.manifest)],
        ['login.submit', () => loginFlows.submit(request.params, signal)],
        ['login.result', () => loginFlows.result(request.params, signal)],
        ['login.cancel', () => loginFlows.cancel(request.params)],
    ]);
    const handler = handlers.get(request.method);
    if (!handler)
        throw new Error('host_method_unknown');
    return handler();
}
async function shutdown() {
    shuttingDown = true;
    requestBodies.clear();
    for (const controller of inflight.values())
        controller.abort();
    for (const gate of gates.values())
        gate.stop();
    await closeResources();
    failures.clear();
    process.exitCode = 0;
    return null;
}
async function settleWork() {
    while (actualWork.size)
        await Promise.all([...actualWork]);
}
async function settleSlot(slotKey) {
    for (;;) {
        const work = slotWork.get(slotKey);
        if (work?.size)
            await Promise.all([...work]);
        await slots.get(slotKey)?.loginFlows.settled();
        if (!slotWork.get(slotKey)?.size)
            return;
    }
}
async function settleWorkAndLogin() {
    do {
        await settleWork();
        await Promise.all([...slots.values()].map((slot) => slot.loginFlows.settled()));
    } while (actualWork.size);
}
async function disposeTransports(refs) {
    const remaining = refs.flatMap((ref) => {
        const transport = transports.get(ref);
        transports.delete(ref);
        transportSlots.delete(ref);
        requestBodies.disposeTransport(ref);
        return transport ? [transport] : [];
    });
    const disposed = await Promise.allSettled(remaining.map(async (transport) => transport.dispose?.()));
    return disposed.every((result) => result.status === 'fulfilled');
}
async function closeResources() {
    await Promise.allSettled([...slots.values()].map((slot) => slot.loginFlows.close()));
    await settleWorkAndLogin();
    const clean = await disposeTransports([...transports.keys()]);
    for (const slot of slots.values())
        await slot.extension.dispose?.();
    if (!clean)
        throw new Error('host_transport_cleanup_failed');
}
/**
 * Removes one extension from a group host. Its login flows are cancelled and its transports
 * disposed; other extensions keep running. Work already started on it may finish.
 */
async function unload(slotKey) {
    const slot = slots.get(slotKey);
    if (!slot)
        return null;
    slots.delete(slotKey);
    await slot.loginFlows.close();
    await slot.loginFlows.settled();
    const refs = [...transportSlots].filter(([, key]) => key === slotKey).map(([ref]) => ref);
    const clean = await disposeTransports(refs);
    await slot.extension.dispose?.();
    if (!clean)
        throw new Error('host_transport_cleanup_failed');
    return null;
}
/** A dedicated host loads exactly one extension; a group host loads one per slot. */
function assertSlotFree(slotKey) {
    if (slots.has(slotKey) || (slotKey === DEFAULT_SLOT && initialized))
        throw new Error('host_init_invalid');
    if (slotKey !== DEFAULT_SLOT && slots.has(DEFAULT_SLOT))
        throw new Error('host_init_invalid');
    if (slots.size >= MAX_SLOTS)
        throw new Error('host_slot_limit');
}
/** The extension module's default export, validated against its manifest. */
async function loadExtension(params) {
    if (typeof params.moduleUrl !== 'string' || !params.moduleUrl.startsWith('file:'))
        throw new Error('host_init_invalid');
    const loaded = await import(params.moduleUrl);
    if (!isRecord(loaded) || !Object.hasOwn(loaded, 'default'))
        throw new Error('host_activation_failed');
    const manifest = params.manifest;
    const extension = validateModelAccessExtension(manifest, loaded.default);
    const providerLimits = captureModuleLimits(loaded.providerLimits, manifest.providers.map((entry) => entry.id));
    return { manifest, extension, providerLimits };
}
async function init(value, slotKey) {
    if (!isRecord(value))
        throw new Error('host_init_invalid');
    assertSlotFree(slotKey);
    const { manifest, extension, providerLimits } = await loadExtension(value);
    if (shuttingDown) {
        await extension.dispose?.();
        throw new Error('host_closed');
    }
    slots.set(slotKey, {
        extension,
        manifest,
        providerLimits,
        loginFlows: new ChildLoginFlows(epoch, send),
    });
    if (!initialized) {
        initialized = true;
        send({ type: 'event', event: 'ready' });
    }
    return { ok: true };
}
function describe(slot) {
    const value = slot.extension;
    const providerLimits = slot.providerLimits;
    const providers = {};
    for (const [id, handler] of Object.entries(value.providers))
        providers[id] = Object.keys(handler);
    const sources = {};
    for (const [id, handlers] of Object.entries(value.sources)) {
        const result = {};
        for (const capability of ['login', 'subscriptionBorrow', 'apiKeyScan']) {
            const entries = handlers[capability];
            if (entries) {
                result[capability] = Object.fromEntries(Object.entries(entries).map(([entryId, handler]) => [entryId, Object.keys(handler)]));
            }
        }
        sources[id] = result;
    }
    return {
        providers,
        sources,
        ...(Object.keys(providerLimits).length > 0 ? { limits: { ...providerLimits } } : {}),
    };
}
async function models(value, signal, valueExtension) {
    const params = value;
    if (!isRecord(value) || typeof params.providerId !== 'string')
        throw new Error('host_models_invalid');
    const handler = provider(valueExtension, params.providerId);
    const result = await handler.models(contextOf(params.context, signal), params.binding, params.credential);
    if (!Array.isArray(result))
        throw new Error('host_models_invalid');
    return result;
}
async function bindTransport(value, signal, valueExtension, slotKey) {
    const params = value;
    if (!isRecord(value) || typeof params.providerId !== 'string')
        throw new Error('host_bind_invalid');
    const handler = provider(valueExtension, params.providerId);
    const transport = captureBoundTransport(await handler.bindTransport(contextOf(params.context, signal), params.credential, params.model));
    if (signal.aborted) {
        await transport.dispose?.();
        signal.throwIfAborted();
    }
    const transportRef = `${params.context.operationId}:${randomUUID()}`;
    transports.set(transportRef, transport);
    transportSlots.set(transportRef, slotKey);
    return {
        transportRef,
        api: transport.api,
        modelId: transport.modelId,
        baseUrl: transport.baseUrl,
        ...(transport.apiKey === undefined ? {} : { apiKey: transport.apiKey }),
        ...(transport.headers === undefined ? {} : { headers: transport.headers }),
    };
}
async function fetchTransport(requestId, value, signal) {
    const params = value;
    validateFetchParams(value);
    const transport = transports.get(params.transportRef);
    if (!transport)
        throw new Error('host_transport_missing');
    if (!validStreamWindow(params.window))
        throw new Error('host_stream_window_invalid');
    const combined = signal;
    const gate = new ModelAccessHostCreditGate(params.window);
    gates.set(requestId, gate);
    let bodyTaken = false;
    try {
        signal.throwIfAborted();
        const body = params.init.body
            ? requestBodies.take(params.init.body.ref, params.transportRef)
            : undefined;
        bodyTaken = body !== undefined;
        const response = await (transport.fetch ?? globalThis.fetch)(params.input, fetchInit(params, body, combined));
        sendHead(requestId, response);
        await sendBody(requestId, response.body, gate);
        send({ type: 'stream', id: requestId, event: 'end' });
        return null;
    }
    catch (error) {
        const ref = failures.remember(error);
        if (!combined.aborted)
            send({
                type: 'stream',
                id: requestId,
                event: 'error',
                error: hostError(errorCode(error) ?? 'host_fetch_failed', ref),
            });
        throw attachHostFailureRef(error, ref);
    }
    finally {
        if (params.init.body && bodyTaken)
            requestBodies.complete(params.init.body.ref, params.transportRef);
        gate.stop();
        gates.delete(requestId);
    }
}
function validateFetchParams(value) {
    if (!isRecord(value) || typeof value.transportRef !== 'string' || typeof value.input !== 'string')
        throw new Error('host_fetch_invalid');
}
function fetchInit(params, body, signal) {
    return {
        ...(params.init.method ? { method: params.init.method } : {}),
        ...(params.init.headers ? { headers: params.init.headers } : {}),
        ...(params.init.body === undefined ? {} : { body }),
        signal,
    };
}
function sendHead(requestId, response) {
    const headers = {};
    response.headers.forEach((entry, key) => {
        headers[key] = entry;
    });
    if (Object.keys(headers).length > 256 || JSON.stringify(headers).length > 64 * 1024)
        throw new Error('host_stream_head_too_large');
    send({ type: 'stream', id: requestId, event: 'head', status: response.status, headers });
}
async function sendBody(requestId, body, gate) {
    if (!body)
        return;
    const reader = body.getReader();
    try {
        for (;;) {
            const next = await reader.read();
            if (next.done)
                break;
            await sendChunks(requestId, next.value, gate);
        }
    }
    finally {
        reader.releaseLock();
    }
}
async function sendChunks(requestId, value, gate) {
    let offset = 0;
    while (offset < value.byteLength) {
        const size = await gate.take(Math.min(MODEL_ACCESS_HOST_MAX_STREAM_CHUNK, value.byteLength - offset));
        if (size <= 0)
            throw new Error('host_request_cancelled');
        const chunk = value.subarray(offset, offset + size);
        gate.spend(chunk.byteLength);
        send({
            type: 'stream',
            id: requestId,
            event: 'chunk',
            data: Buffer.from(chunk).toString('base64'),
        });
        offset += size;
    }
}
async function disposeTransport(value) {
    if (!isRecord(value) || typeof value.transportRef !== 'string')
        throw new Error('host_transport_invalid');
    const transport = transports.get(value.transportRef);
    transports.delete(value.transportRef);
    transportSlots.delete(value.transportRef);
    requestBodies.disposeTransport(value.transportRef);
    await transport?.dispose?.();
    return null;
}
async function classifyError(value, valueExtension) {
    const params = value;
    if (!isRecord(value) || typeof params.providerId !== 'string')
        throw new Error('host_classify_invalid');
    const handler = provider(valueExtension, params.providerId);
    try {
        return handler.classifyError(restoreHostFailure(params.error, failures));
    }
    finally {
        if (params.error?.ref)
            failures.release(params.error.ref);
    }
}
function provider(value, id) {
    const handler = value.providers[id];
    if (!handler)
        throw new Error('host_provider_missing');
    return handler;
}
function onMessage(message) {
    if (message.epoch !== epoch) {
        send({ type: 'event', event: 'fatal', error: hostError('host_epoch_mismatch') });
        process.exitCode = 1;
        return;
    }
    if (message.type === 'cancel') {
        inflight.get(message.id)?.abort();
        gates.get(message.id)?.stop();
        return;
    }
    if (message.type === 'credit') {
        gates.get(message.id)?.add(message.n);
        return;
    }
    if (message.type !== 'request')
        return;
    const controller = new AbortController();
    inflight.set(message.id, controller);
    const work = slotScope.run(message.slot ?? DEFAULT_SLOT, () => dispatch(message, controller.signal));
    if (!['drain', 'shutdown', 'unload'].includes(message.method)) {
        const slotKey = message.slot ?? DEFAULT_SLOT;
        let owned = slotWork.get(slotKey);
        if (!owned) {
            owned = new Set();
            slotWork.set(slotKey, owned);
        }
        const bucket = owned;
        const settled = observeWork(work, () => {
            actualWork.delete(settled);
            bucket.delete(settled);
            if (bucket.size === 0 && slotWork.get(slotKey) === bucket)
                slotWork.delete(slotKey);
        });
        actualWork.add(settled);
        bucket.add(settled);
    }
    observeModelAccessWork(respond(message, work));
}
async function observeWork(work, release) {
    try {
        await work;
    }
    catch {
        // Failures are reported by the response path, not the lifetime tracker.
    }
    finally {
        release();
    }
}
async function respond(message, work) {
    try {
        let result;
        try {
            result = await work;
        }
        catch (error) {
            reportFailure(message.id, error);
            return;
        }
        send({ type: 'response', id: message.id, result });
    }
    finally {
        inflight.delete(message.id);
        if (message.method === 'shutdown')
            setImmediate(() => process.exit(0));
    }
}
function reportFailure(id, error) {
    const ref = hostFailureRef(error) ?? failures.remember(error);
    send({
        type: 'response',
        id,
        error: hostError(errorCode(error) ?? 'host_failed', ref),
    });
}
const decoder = new HostLineDecoder(MAX_LINE_BYTES);
process.stdout.on('error', () => process.exit(1));
process.stdin.on('data', (chunk) => {
    try {
        for (const message of decoder.push(chunk))
            onMessage(message);
    }
    catch (error) {
        send({ type: 'event', event: 'fatal', error: hostError(errorCode(error) ?? 'host_protocol') });
        process.exitCode = 1;
        process.stdin.pause();
    }
});
process.stdin.on('end', () => {
    try {
        decoder.finish();
    }
    catch {
        process.exitCode = 1;
    }
    shuttingDown = true;
    requestBodies.clear();
    for (const controller of inflight.values())
        controller.abort();
    // Parent death still cancels extension-owned CLI/browser login work, with a bounded exit.
    const deadline = setTimeout(() => process.exit(1), 2_000);
    observeModelAccessWork(closeLoginOnParentExit(deadline));
});
async function closeLoginOnParentExit(deadline) {
    try {
        await Promise.allSettled([...slots.values()].map((slot) => slot.loginFlows.close()));
    }
    finally {
        clearTimeout(deadline);
        process.exit(process.exitCode ?? 0);
    }
}
/**
 * An extension's uncaught error still ends the process (its state can no longer be trusted), but
 * first names the slot it came from, so the parent charges the crash to that extension alone
 * rather than to every extension sharing the group process.
 */
function crash(error) {
    if (crashed)
        return;
    crashed = true;
    diagnostic(error instanceof Error ? (error.stack ?? error.message) : String(error));
    const slot = slotScope.getStore();
    process.exitCode = 1;
    shuttingDown = true;
    send({
        type: 'event',
        event: 'fatal',
        error: hostError('host_extension_crashed'),
        ...(slot && slots.has(slot) ? { slot } : {}),
    });
    // The notice is flushed before exit; a stuck pipe still exits within a bound.
    setTimeout(() => process.exit(1), 1_000).unref();
    process.stdout.write('', () => process.exit(1));
}
process.on('uncaughtException', crash);
process.on('unhandledRejection', crash);
send({ type: 'event', event: 'hello' });
function errorCode(error) {
    if (!error || typeof error !== 'object')
        return undefined;
    const code = error.code;
    return typeof code === 'string' ? code : undefined;
}
function isRecord(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}
//# sourceMappingURL=host-entry.js.map