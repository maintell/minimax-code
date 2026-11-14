import { readFile } from 'node:fs/promises';
import { readJsonl, replaceFileAtomically } from '../../../infra/file/jsonl.js';
import { decodeRequestDelta } from './request-payload-chain.js';
export async function readEvents(path) {
    let contents;
    try {
        contents = await readFile(path, 'utf8');
    }
    catch (error) {
        if (hasErrorCode(error, 'ENOENT'))
            return [];
        throw error;
    }
    try {
        return await readJsonl(path, decodeEvent);
    }
    catch (error) {
        if (contents.endsWith('\n'))
            throw error;
        const lastBoundary = contents.lastIndexOf('\n');
        const tail = contents.slice(lastBoundary + 1);
        try {
            JSON.parse(tail);
            throw error;
        }
        catch (tailError) {
            if (tailError === error || !(tailError instanceof SyntaxError))
                throw tailError;
        }
        const committedPrefix = lastBoundary < 0 ? '' : contents.slice(0, lastBoundary + 1);
        await replaceFileAtomically(path, committedPrefix, async (temporaryPath) => {
            await readJsonl(temporaryPath, decodeEvent);
        });
        return readJsonl(path, decodeEvent);
    }
}
export function decodeEvent(value) {
    if (!isObject(value) || value.v !== 1 || typeof value.type !== 'string') {
        throw new Error('unsupported Inspector event');
    }
    switch (value.type) {
        case 'compaction.completed':
            return decodeCompactionEvent(value);
        case 'tool.execution_started':
            return decodeToolStartedEvent(value);
        case 'tool.execution_completed':
            return decodeToolCompletedEvent(value);
        case 'call.captured':
            return decodeCallEvent(value);
        default:
            throw new Error('unknown Inspector event');
    }
}
export function decodeSessionDiscoveredRecord(value) {
    if (!isObject(value) ||
        value.v !== 1 ||
        value.type !== 'session.discovered' ||
        (value.source !== 'electron' && value.source !== 'tui')) {
        throw new Error('unsupported Inspector Session index');
    }
    return {
        v: 1,
        type: 'session.discovered',
        sessionId: requiredString(value.sessionId),
        source: value.source,
    };
}
function decodeCompactionEvent(value) {
    return {
        v: 1,
        type: 'compaction.completed',
        attemptId: requiredString(value.attemptId),
        completedAtMs: finiteNumber(value.completedAtMs),
        captureEpoch: finiteNumber(value.captureEpoch),
    };
}
function decodeToolStartedEvent(value) {
    return {
        v: 1,
        type: 'tool.execution_started',
        callId: requiredString(value.callId),
        toolCallId: requiredString(value.toolCallId),
        startedAtMs: finiteNumber(value.startedAtMs),
        ...(value.parentToolCallId === undefined
            ? {}
            : {
                parentToolCallId: requiredString(value.parentToolCallId),
                toolName: requiredString(value.toolName),
            }),
    };
}
function optionalFiniteNumber(value) {
    return value === undefined ? undefined : finiteNumber(value);
}
function optionalField(key, value) {
    return (value === undefined ? {} : { [key]: value });
}
function decodeToolCompletedEvent(value) {
    return {
        v: 1,
        type: 'tool.execution_completed',
        callId: requiredString(value.callId),
        toolCallId: requiredString(value.toolCallId),
        endedAtMs: finiteNumber(value.endedAtMs),
        isError: requiredBoolean(value.isError),
    };
}
function decodeCallEvent(value) {
    return {
        v: 1,
        type: 'call.captured',
        callId: requiredString(value.callId),
        turnId: requiredString(value.turnId),
        startedAtMs: finiteNumber(value.startedAtMs),
        durationMs: finiteNumber(value.durationMs),
        providerId: requiredString(value.providerId),
        modelId: requiredString(value.modelId),
        apiId: requiredString(value.apiId),
        attemptCount: finiteNumber(value.attemptCount),
        ...optionalField('attemptStartedAtMs', optionalFiniteNumber(value.attemptStartedAtMs)),
        ...optionalField('firstEventAtMs', optionalFiniteNumber(value.firstEventAtMs)),
        ...(isUsage(value.usage) ? { usage: value.usage } : {}),
        expectedTools: decodeExpectedTools(value.expectedTools),
        requestState: payloadState(value.requestState),
        ...(typeof value.requestByteLength === 'number'
            ? { requestByteLength: finiteNumber(value.requestByteLength) }
            : {}),
        ...optionalField('requestDelta', decodeRequestDelta(value.requestDelta)),
        responseState: payloadState(value.responseState),
        ...(typeof value.responseByteLength === 'number'
            ? { responseByteLength: finiteNumber(value.responseByteLength) }
            : {}),
        captureEpoch: finiteNumber(value.captureEpoch),
        ...(value.outcome === 'error' ? { outcome: 'error' } : {}),
    };
}
function decodeExpectedTools(value) {
    if (value === undefined)
        return [];
    if (!Array.isArray(value))
        throw new Error('invalid expected tools');
    return value.map((tool) => {
        if (!isObject(tool))
            throw new Error('invalid expected tool');
        return {
            toolCallId: requiredString(tool.toolCallId),
            toolName: requiredString(tool.toolName),
        };
    });
}
function requiredString(value) {
    if (typeof value !== 'string' || value.length === 0)
        throw new Error('expected string');
    return value;
}
function finiteNumber(value) {
    if (typeof value !== 'number' || !Number.isFinite(value))
        throw new Error('expected number');
    return value;
}
function requiredBoolean(value) {
    if (typeof value !== 'boolean')
        throw new Error('expected boolean');
    return value;
}
function payloadState(value) {
    if (value === 'AVAILABLE' || value === 'OMITTED_TOO_LARGE' || value === 'CAPTURE_FAILED') {
        return value;
    }
    throw new Error('invalid payload state');
}
function isUsage(value) {
    return (isObject(value) &&
        ['input', 'output', 'cacheRead', 'cacheWrite'].every((key) => typeof value[key] === 'number' && Number.isFinite(value[key])));
}
function isObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function hasErrorCode(error, code) {
    return isObject(error) && error.code === code;
}
//# sourceMappingURL=records.js.map