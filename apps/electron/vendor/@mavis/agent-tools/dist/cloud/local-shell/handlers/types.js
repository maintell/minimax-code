/**
 * Shared types for local-shell handlers. Each handler is a pure async
 * function that takes argv (no leading command name? yes, argv[0] is the
 * command name — handlers can re-validate it but the dispatcher already
 * picked the right one based on argv[0]) and returns a structured
 * stdout/stderr/exitCode triple. The dispatcher then concatenates
 * stdout + stderr into the BashTool result text (matching the existing
 * sandbox bash behavior).
 *
 * Handlers MUST honour `ctx.signal?.aborted` at suspendable points
 * (between fs syscalls) so that long file walks can cancel quickly when
 * the turn aborts.
 */
/** Throw this from a handler to signal "I cannot handle this — sandbox should." */
export class HandlerUnsupportedError extends Error {
    constructor(reason) {
        super(`local-shell handler unsupported: ${reason}`);
        this.name = 'HandlerUnsupportedError';
    }
}
export function abortIfCancelled(ctx) {
    if (ctx.signal?.aborted)
        throw new Error('Operation aborted');
}
//# sourceMappingURL=types.js.map