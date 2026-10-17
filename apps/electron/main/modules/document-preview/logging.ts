/** Default sink used everywhere a real logger has not been injected. */
export let noopDocumentPreviewLogger = Object.freeze({
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
});
/**
 * Normalize an unknown thrown value into a structured, log-safe detail record.
 * The rich message/stack is intended for the main-process logger only and must
 * never be forwarded to the renderer contract.
 */
export function describeDocumentPreviewError(error) {
    if (error instanceof Error) {
        return error.stack ? { error: error.message, stack: error.stack } : { error: error.message };
    }
    return { error: String(error) };
}
