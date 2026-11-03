import { parentPort } from 'node:worker_threads';
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
    const result = await executePtcQuickJsProgram({
        code: message.code,
        tools: message.toolNames.map((name) => ({ name })),
        maxHeapBytes: message.limits.maxHeapBytes,
        maxComputeMs: message.limits.maxComputeMs,
        maxToolCalls: message.limits.maxToolCalls,
        signal: signalOwner.signal,
        onActivityChange: (active) => post({ type: 'activity', active }),
        onLimitExceeded: (budget) => post({ type: 'limit_rejected', budget }),
        onConsole: consoleSink,
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