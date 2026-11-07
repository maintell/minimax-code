/**
 * Helpers for the programmatic (PTC) side channel of tool results.
 *
 * A tool that fails below its own logic (for example an MCP call rejected by
 * the JSON-RPC peer) usually throws; Pi then keeps only `error.message`. The
 * raw protocol error is attached to the thrown object under a registry symbol
 * so the PTC executor can hand it to guest code as `error.raw` while ordinary
 * model calls, logs and persistence keep seeing the unchanged Error.
 */
import { createHash } from 'node:crypto';
const PROGRAMMATIC_ERROR_RAW = Symbol.for('mavis.programmaticTool.errorRaw');
const PROGRAMMATIC_ERROR_DATA = Symbol.for('mavis.programmaticTool.errorData');
/**
 * Attaches a raw error description to a thrown object in place, so the caller
 * can rethrow the original value with its type, message and stack unchanged.
 * Returns false when the value cannot carry it (a primitive or a frozen
 * object); the caller should log that the raw value was lost and still rethrow.
 */
export function attachProgrammaticErrorRaw(error, raw) {
    if (raw === undefined || error === null || typeof error !== 'object')
        return false;
    if (!Object.isExtensible(error))
        return false;
    Object.defineProperty(error, PROGRAMMATIC_ERROR_RAW, {
        value: raw,
        enumerable: false,
        configurable: true,
    });
    return true;
}
export function readProgrammaticErrorRaw(error) {
    if (error === null || typeof error !== 'object')
        return undefined;
    return Reflect.get(error, PROGRAMMATIC_ERROR_RAW);
}
/**
 * Attaches the failure metadata a native tool knows (the path it tried, the
 * kind of read) to an error it rethrows, the same way as the raw error: Pi
 * keeps only the message for the model, so PTC data is the one place it shows.
 */
export function attachProgrammaticErrorData(error, data) {
    if (error === null || typeof error !== 'object' || !Object.isExtensible(error))
        return false;
    Object.defineProperty(error, PROGRAMMATIC_ERROR_DATA, {
        value: data,
        enumerable: false,
        configurable: true,
    });
    return true;
}
export function readProgrammaticErrorData(error) {
    if (error === null || typeof error !== 'object')
        return undefined;
    const data = Reflect.get(error, PROGRAMMATIC_ERROR_DATA);
    return data !== null && typeof data === 'object' && !Array.isArray(data)
        ? data
        : undefined;
}
/** Merges a programmatic payload into a tool result without touching model-visible fields. */
export function withProgrammaticResult(result, programmatic) {
    return { ...result, programmatic: { ...result.programmatic, ...programmatic } };
}
// Module-private, so only code that calls recordImageEncodedContent can mark
// content; a hook that returns its own array, or edits this one, is not marked.
const encodedContent = new WeakMap();
/**
 * Called by the request image encoder on the content array it returns.
 * Digests of both arrays are kept (not the arrays: they carry image data and
 * the output stays in history), so a reader can check that the encoder's input
 * was the tool's own content and that nothing changed its output afterwards.
 */
export function recordImageEncodedContent(source, output, images) {
    const sourceDigest = contentDigest(source);
    const outputDigest = contentDigest(output);
    if (sourceDigest === undefined || outputDigest === undefined || images.length === 0)
        return;
    encodedContent.set(output, { source: sourceDigest, output: outputDigest, images });
}
/**
 * The encoder's facts for `finalContent` when it is exactly the encoder's
 * output and the encoder's input serialized to `ownContentJson` (the tool's
 * content as it left the tool); undefined otherwise.
 */
export function readImageEncodedContent(finalContent, ownContentJson) {
    if (ownContentJson === undefined || finalContent === null || typeof finalContent !== 'object') {
        return undefined;
    }
    const record = encodedContent.get(finalContent);
    if (!record || record.source !== digest(ownContentJson))
        return undefined;
    return record.output === contentDigest(finalContent) ? record.images : undefined;
}
function contentDigest(content) {
    try {
        const json = JSON.stringify(content);
        return json === undefined ? undefined : digest(json);
    }
    catch {
        // Cycles or BigInt: such content cannot be shown to be the encoder's.
        return undefined;
    }
}
function digest(json) {
    return createHash('sha256').update(json).digest('hex');
}
//# sourceMappingURL=programmatic.js.map