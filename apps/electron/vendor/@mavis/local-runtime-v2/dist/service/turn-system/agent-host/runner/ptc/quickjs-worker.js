import { parentPort } from 'node:worker_threads';
import { PTC_STORE_LOAD, validatePtcStoreWrite, } from '../../execution/ptc/contracts.js';
import { createPtcConsoleSink, executePtcQuickJsProgram } from './quickjs-runtime.js';
if (!parentPort)
    throw new Error('PTC QuickJS worker requires a parent MessagePort.');
let controller;
let activeProgram;
const replies = new Map();
parentPort.on('message', (message) => {
    if (message.type === 'start') {
        if (controller || activeProgram)
            return;
        controller = new AbortController();
        activeProgram = run(message, controller);
        return;
    }
    if (message.type === 'tool_result') {
        settleReply(message);
        return;
    }
    controller?.abort(message.reason);
    rejectReplies(new Error(`PTC stopped: ${message.reason}`));
});
post({ type: 'ready' });
async function run(message, signalOwner) {
    try {
        await runProgram(message, signalOwner);
    }
    catch (error) {
        post({
            type: 'failed',
            error: {
                code: 'worker_error',
                message: error instanceof Error ? error.message : String(error),
            },
            pendingRequestIds: [...replies.keys()],
        });
    }
    finally {
        activeProgram = undefined;
    }
}
async function runProgram(message, signalOwner) {
    const consoleSink = createPtcConsoleSink(message.limits.maxConsoleBytes, (text, truncated) => post({ type: 'console', text, ...(truncated ? { truncated: true } : {}) }));
    // Values this program stored: `load` reads them back without asking the host,
    // and they are sent on as they happen so the host can stage them.
    const staged = new Map();
    const storeIndex = new Map((message.storeIndex ?? []).map((entry) => [entry.key, entry.bytes]));
    let loadSeq = 0;
    // The only place that sees every `store` and `load`: a value read back from
    // this same call and a key the Session never stored never reach the host, and
    // a refused call never reaches the bridge at all.
    const storeCounts = { loads: 0, rejected: 0 };
    // Reported as the calls happen, not with the terminal message, so a program
    // that is stopped or killed still accounts for what it already did. The
    // numbers are absolute, so the host assigns them and cannot double-count.
    const reportStoreCounts = () => post({ type: 'store_count', ...storeCounts });
    const result = await executePtcQuickJsProgram({
        code: message.code,
        tools: message.toolNames.map((name) => ({ name })),
        ...(message.directOnlyToolNames ? { directOnlyTools: message.directOnlyToolNames } : {}),
        maxHeapBytes: message.limits.maxHeapBytes,
        maxComputeMs: message.limits.maxComputeMs,
        maxToolCalls: message.limits.maxToolCalls,
        signal: signalOwner.signal,
        scriptRoots: message.scriptRoots,
        onScriptLoaded: (source) => post({ type: 'script_loaded', source }),
        onScriptRejected: (status) => post({ type: 'script_rejected', status }),
        onActivityChange: (active) => post({ type: 'activity', active }),
        onRuntimeDisposeFailed: (diagnostic) => post({ type: 'diagnostic', ...diagnostic }),
        onLimitExceeded: (budget) => post({ type: 'limit_rejected', budget }),
        onConsole: consoleSink,
        onStoreLoad: () => {
            storeCounts.loads += 1;
            reportStoreCounts();
        },
        onStoreRejected: () => {
            storeCounts.rejected += 1;
            reportStoreCounts();
        },
        // No `storeIndex` means the host wired no store (`beta.ptcStore` off), so
        // neither callback exists and QuickJS binds neither global: a program that
        // calls one fails exactly as it did before the feature existed.
        ...(message.storeIndex === undefined
            ? {}
            : {
                storeValue: (key, valueJson, desc) => {
                    const write = { key, valueJson, ...(desc === undefined ? {} : { desc }) };
                    // The program can catch this and store a smaller value. The guest's
                    // own catch counts the refusal, so this side must not count it again.
                    validatePtcStoreWrite(write, message.limits.maxBridgeMessageBytes);
                    staged.set(key, valueJson);
                    storeIndex.set(key, new TextEncoder().encode(valueJson).byteLength);
                    post({ type: 'store_write', ...write });
                },
                loadValue: (key) => staged.get(key) ?? loadFromHost(key, ++loadSeq, storeIndex),
            }),
        callTool: (request) => new Promise((resolve, reject) => {
            replies.set(request.requestId, { resolve, reject });
            post({ type: 'tool_call', ...request });
        }),
    });
    if (result.ok) {
        post({
            type: 'completed',
            valueJson: result.valueJson,
            pendingRequestIds: result.pendingRequestIds,
            droppedUndefinedPaths: result.droppedUndefinedPaths,
            droppedUndefinedCount: result.droppedUndefinedCount,
        });
    }
    else {
        post({ type: 'failed', error: result.error, pendingRequestIds: result.pendingRequestIds });
    }
}
/** How long one Atomics.wait blocks before the loop checks for a stop again. */
const LOAD_WAIT_MS = 50;
/**
 * Fetches one stored value synchronously: the guest is blocked inside `load`,
 * so the value cannot come back as a message. The Worker allocates shared
 * memory from the index size, asks the host to fill it, and waits on it. The
 * wait wakes every 50 ms so a stop is noticed; a stop that arrives while the
 * thread is parked is delivered by the host terminating the Worker.
 */
function loadFromHost(key, requestId, storeIndex) {
    const bytes = storeIndex.get(key);
    if (bytes === undefined)
        return undefined;
    const buffer = new SharedArrayBuffer(PTC_STORE_LOAD.headerBytes + bytes);
    const control = new Int32Array(buffer, 0, 2);
    post({ type: 'store_load', requestId: `store-${requestId}`, key, buffer });
    while (Atomics.wait(control, 0, PTC_STORE_LOAD.pending, LOAD_WAIT_MS) === 'timed-out') {
        // Parked again; a terminated Worker never returns from here.
    }
    if (Atomics.load(control, 0) !== PTC_STORE_LOAD.ready) {
        throw new Error('PTC execution stopped while loading a stored value.');
    }
    const written = Atomics.load(control, 1);
    if (written === PTC_STORE_LOAD.missing)
        return undefined;
    return new TextDecoder().decode(new Uint8Array(buffer, PTC_STORE_LOAD.headerBytes, Math.max(0, written)));
}
function settleReply(message) {
    const reply = replies.get(message.requestId);
    if (!reply)
        return;
    replies.delete(message.requestId);
    if (message.resultJson !== undefined) {
        reply.resolve(message.resultJson);
        post({ type: 'tool_consumed', requestId: message.requestId });
    }
    else {
        reply.reject(new PtcWorkerToolError(message.error ?? { code: 'guest_error', message: 'PTC tool call failed.' }));
    }
}
class PtcWorkerToolError extends Error {
    failure;
    constructor(failure) {
        super(failure.message);
        this.failure = failure;
        this.name = 'PtcWorkerToolError';
    }
}
function rejectReplies(reason) {
    for (const reply of replies.values())
        reply.reject(reason);
    replies.clear();
}
function post(message) {
    parentPort?.postMessage(message);
}
//# sourceMappingURL=quickjs-worker.js.map