/**
 * The PTC child tool whose settled results the host reads to record a save.
 * Kept equal to `SAVE_PTC_SCRIPT_NAME` in `@mavis/agent-tools`
 * (desktop/ptc-script-save.ts): the Worker and the orchestration core may not
 * import that package, so the name is spelled out on both sides.
 */
export const PTC_SCRIPT_SAVE_TOOL_NAME = 'save_run_code_script';
/**
 * One line: control characters and newlines become spaces and runs of
 * whitespace collapse. Same rule as `ptcScriptSingleLine` in
 * `@mavis/agent-tools` (desktop/ptc-script-text.ts), repeated here for the same
 * reason as the tool name above.
 */
export function ptcScriptDescriptionText(value) {
    return value
        .replace(/[\u0000-\u001f\u007f]/gu, ' ')
        .replace(/\s+/gu, ' ')
        .trim();
}
export function ptcScriptInvocation(args) {
    if (!args || typeof args !== 'object' || Array.isArray(args))
        return { kind: 'inline' };
    const value = args.path;
    if (value === undefined || value === null)
        return { kind: 'inline' };
    if (typeof value !== 'string')
        return { kind: 'invalid', value };
    const path = value.trim();
    return path === '' ? { kind: 'inline' } : { kind: 'script', path };
}
export const PTC_LIMITS = {
    // Program source length is deliberately not budgeted: nothing here refuses a
    // call for how long its code is. The heap, compute, wall clock and bridge
    // limits below are what bound a program.
    maxHeapBytes: 64 * 1024 * 1024,
    maxComputeMs: 1_000,
    // Default only. run_code passes the time left until the Agent Core batch
    // deadline (raised by timeout_ms), the same deadline that refuses late
    // child calls, so the guest never outlives or undercuts that cutoff.
    // Agent Core's PTC_DEFAULT_WALL_CLOCK_MS, copied rather than imported (see
    // the import above); contracts.test.ts keeps the two equal.
    maxWallClockMs: 120_000,
    shutdownGraceMs: 5_000,
    // Every admitted call counts, failed ones included. Calls past the limit are
    // refused with PTC_TOOL_CALL_LIMIT_EXCEEDED instead of stopping the program.
    maxToolCalls: 100,
    // Parallel tools only; a sequential (writing) tool still runs alone.
    maxConcurrentToolCalls: 16,
    // One serialized message: a child result, a call's arguments, the return
    // value the host parses. Child results are no longer cut to the model caps
    // (agent-tools isPtcChildCall), so 8 MiB became 16 MiB: a result carries its
    // content twice (output and data), so this is about 8 MiB of real content.
    // Measured 2026-10-28: a 64 MiB guest heap holds 16 MiB mixed-language
    // results passed in by the host. A larger child result fails only that call
    // (PTC_RESULT_TOO_LARGE); the program continues.
    maxBridgeMessageBytes: 16 * 1024 * 1024,
    // Results sent to the Worker it has not taken yet; raised with the message
    // limit so one 16 MiB result does not use up the whole allowance. A result
    // that would bring the total over it fails only that call
    // (PTC_RESULT_TOO_LARGE, ptcUnconsumedResultsTooLargeFailure); the program
    // continues and the failed result is not counted.
    maxBridgeResultBytes: 32 * 1024 * 1024,
    maxOuterResultBytes: 64 * 1024,
    // console.* output shown in the outer result; the rest is cut with a note.
    maxConsoleBytes: 16 * 1024,
};
/** Host-enumerated guest error code for a call refused by the per-program call budget. */
const PTC_TOOL_CALL_LIMIT_EXCEEDED = 'PTC_TOOL_CALL_LIMIT_EXCEEDED';
/**
 * Host-enumerated guest error code for a child whose result is larger than
 * `maxBridgeMessageBytes`, or would bring the results the Worker has not
 * taken yet over `maxBridgeResultBytes`. The tool ran; only its result is
 * not delivered.
 */
export const PTC_RESULT_TOO_LARGE = 'PTC_RESULT_TOO_LARGE';
/**
 * Guest result for a child whose serialized result exceeds the per-message
 * bridge limit. Only this call fails, so the program can narrow the
 * arguments and call again. Same shape as ptcToolCallLimitRefusal.
 */
export function ptcResultTooLargeFailure(toolCallId, bytes, limit) {
    return {
        status: 'failed',
        isError: true,
        data: {},
        truncation: { truncated: 'unknown' },
        error: {
            code: PTC_RESULT_TOO_LARGE,
            message: `PTC child result is ${bytes} bytes, over the ${limit}-byte per-call limit, so it was not delivered; the tool itself ran. Narrow the arguments and retry.`,
            toolCallId,
        },
    };
}
/**
 * Guest result for a child whose result fits one message but would bring the
 * results the Worker has not taken yet over `maxBridgeResultBytes` (parallel
 * large calls while the guest is busy). Only this call fails; the program can
 * run fewer calls at once and retry. Same shape as ptcResultTooLargeFailure.
 */
export function ptcUnconsumedResultsTooLargeFailure(toolCallId, bytes, pendingBytes, limit) {
    return {
        ...ptcResultTooLargeFailure(toolCallId, bytes, limit),
        error: {
            code: PTC_RESULT_TOO_LARGE,
            message: `PTC child result is ${bytes} bytes; with ${pendingBytes} bytes of earlier results the program has not taken yet, the total would exceed the ${limit}-byte limit, so it was not delivered; the tool itself ran. Run fewer large calls in parallel or read in smaller batches, then retry.`,
            toolCallId,
        },
    };
}
/**
 * Guest result for a call refused by the call budget. The call never reached a
 * tool, so it has no child record; `toolCallId` is the guest request id. The
 * refusal happens before the tool is looked up, so it cannot tell a native
 * tool from an MCP one and always carries the empty data of a call that did
 * not run.
 */
export function ptcToolCallLimitRefusal(requestId, maxToolCalls) {
    return {
        status: 'failed',
        isError: true,
        data: {},
        truncation: { truncated: 'unknown' },
        error: {
            code: PTC_TOOL_CALL_LIMIT_EXCEEDED,
            message: `PTC refused this call after reaching the ${maxToolCalls}-call limit; it was not executed.`,
            toolCallId: requestId,
        },
    };
}
/**
 * Longest key `store` and `load` accept. The guest's setup script, the Worker
 * and the host store all read it from here, so the three cannot drift.
 */
export const PTC_STORE_MAX_KEY_LENGTH = 256;
/** The key rule's message; `fn` names the entry point that refused the call. */
export function ptcStoreKeyMessage(fn) {
    return `PTC ${fn} key must be a string of 1 to ${PTC_STORE_MAX_KEY_LENGTH} characters.`;
}
/**
 * The whole write rule in one place: key shape, encoded size and desc type.
 * The Worker applies it to what the guest sends and the host store applies it
 * again to what it stages, so both refuse the same writes with the same text.
 */
export function validatePtcStoreWrite(write, maxValueBytes) {
    if (typeof write.key !== 'string' || write.key.length === 0) {
        throw new Error('PTC store key must be a non-empty string.');
    }
    if (write.key.length > PTC_STORE_MAX_KEY_LENGTH) {
        throw new Error(`PTC store key is longer than ${PTC_STORE_MAX_KEY_LENGTH} characters.`);
    }
    if (typeof write.valueJson !== 'string') {
        throw new Error('PTC store value must be JSON text.');
    }
    const bytes = new TextEncoder().encode(write.valueJson).byteLength;
    if (bytes > maxValueBytes) {
        throw new Error(`PTC stored value is ${bytes} bytes, over the ${maxValueBytes}-byte limit; store a smaller value.`);
    }
    // A long desc is not an error: it is only a reminder label, so it is cut
    // when the record is written instead of failing the program's store call.
    if (write.desc !== undefined && typeof write.desc !== 'string') {
        throw new Error('PTC store desc must be a string.');
    }
}
/**
 * The shared memory one blocked `load` is answered through: `Int32Array(buffer,
 * 0, 2)` is `[state, bytesWritten]` and the value starts at `headerBytes`. The
 * Worker allocates it and parks on it, the host writes the answer into it; both
 * sides read the layout from here so the two cannot disagree.
 */
export const PTC_STORE_LOAD = {
    /** The Worker is parked and the host has not answered yet. */
    pending: 0,
    /** The host answered; `bytesWritten` is the value's length, or `missing`. */
    ready: 1,
    /** The execution stopped while the Worker was parked. */
    stopped: 2,
    /** Size of the two control words before the value. */
    headerBytes: 8,
    /** `bytesWritten` of an answer that found no value under the key. */
    missing: -1,
};
export function mergedPtcLimits(overrides = {}) {
    return { ...PTC_LIMITS, ...overrides };
}
function utf8ByteLength(value) {
    return new TextEncoder().encode(value).byteLength;
}
export function parsePtcToolArgs(value) {
    const parsed = JSON.parse(value);
    if (!isPlainRecord(parsed) || !isJsonValue(parsed)) {
        throw new Error('Tool arguments must be a JSON object with safe property names.');
    }
    return parsed;
}
export function serializePtcValue(value, maximumBytes) {
    if (!isPtcJsonValue(value))
        throw new PtcSerializationError('invalid_tool_result', 'Value is not JSON-serializable.');
    const json = JSON.stringify(value);
    if (json === undefined)
        throw new PtcSerializationError('invalid_tool_result', 'Value is not JSON-serializable.');
    const bytes = utf8ByteLength(json);
    if (bytes > maximumBytes) {
        throw new PtcSerializationError('bridge_limit_exceeded', `Serialized value exceeds the ${maximumBytes}-byte PTC transport limit.`, bytes);
    }
    return json;
}
export class PtcSerializationError extends Error {
    code;
    bytes;
    constructor(code, message, 
    /** UTF-8 size of the serialized value; set for bridge_limit_exceeded. */
    bytes) {
        super(message);
        this.code = code;
        this.bytes = bytes;
        this.name = 'PtcSerializationError';
    }
}
/**
 * The bridge's JSON rule: finite numbers, plain objects without reserved keys
 * (`__proto__`, `constructor`, `prototype`) and at most 100 levels deep.
 * Callers use it to drop third-party payloads that the bridge would refuse.
 */
export function isPtcJsonValue(value) {
    return isJsonValue(value);
}
function isJsonValue(value, depth = 0) {
    if (depth > 100)
        return false;
    if (value === null || typeof value === 'string' || typeof value === 'boolean')
        return true;
    if (typeof value === 'number')
        return Number.isFinite(value);
    if (Array.isArray(value))
        return Array.from(value).every((entry) => isJsonValue(entry, depth + 1));
    if (!isPlainRecord(value))
        return false;
    return Object.entries(value).every(([key, entry]) => key !== '__proto__' &&
        key !== 'constructor' &&
        key !== 'prototype' &&
        isJsonValue(entry, depth + 1));
}
function isPlainRecord(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}
//# sourceMappingURL=contracts.js.map