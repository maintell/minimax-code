/**
 * Local fast-path dispatcher for `cloud-bash`. The dispatcher classifies
 * a bash command into one of three outcomes:
 *
 *   1. **Local hit** — the parser produced a clean argv and the leading
 *      command is in the handler map; the handler ran and produced
 *      stdout / stderr / exitCode without touching the sandbox.
 *   2. **Local skip** — the parser rejected the command (pipes / globs
 *      / variables / etc.) or the command isn't whitelisted; caller
 *      should fall back to `executeShell` so the sandbox handles it.
 *   3. **Path escape** — the parser succeeded and the command was
 *      whitelisted but a handler tried to traverse outside the
 *      workspace; caller falls back to the sandbox, which has its
 *      own containment.
 *
 * Other handler errors (file not found, EACCES, etc.) are reported by
 * the handler itself as a non-zero exitCode + stderr; the dispatcher
 * does NOT fall back to the sandbox in those cases — that would
 * potentially execute the command twice with side effects.
 */
import { parseCommand } from './parse.js';
import { LOCAL_HANDLERS } from './handlers/index.js';
import { LocalShellPathError } from './path-resolve.js';
/**
 * Classify-and-dispatch entry point used by `CloudBashTool.execute`.
 * Returns either a `LocalDispatchResult` (caller renders to ToolResult
 * with `dispatched_locally: true`) or a `LocalDispatchSkip` (caller
 * forwards to `executeShell` with `dispatched_locally: false` and the
 * skip reason recorded in details for observability).
 */
export async function tryLocalDispatch(command, workspaceRoot, signal) {
    if (signal?.aborted)
        throw new Error('Operation aborted');
    const parsed = parseCommand(command);
    if ('reason' in parsed) {
        return { reason: `parse-rejected:${parsed.reason}` };
    }
    const argv = parsed.argv;
    const name = argv[0];
    const handler = LOCAL_HANDLERS[name];
    if (!handler) {
        return { reason: `not-whitelisted:${name}` };
    }
    // Reject any argv entry beginning with `~` — local handlers do NOT
    // expand the home directory; let the sandbox shell handle it.
    for (let i = 1; i < argv.length; i++) {
        if (argv[i].startsWith('~'))
            return { reason: 'tilde-expansion' };
    }
    const startedAt = Date.now();
    try {
        const result = await handler(argv, { workspaceRoot, signal });
        if (signal?.aborted)
            throw new Error('Operation aborted');
        return {
            text: result.stdout + result.stderr,
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: result.exitCode,
            durationMs: Date.now() - startedAt,
            handler: name,
        };
    }
    catch (err) {
        if (err instanceof LocalShellPathError) {
            // Fall back to sandbox so the user sees the canonical shell error
            // (sandbox has its own containment policy).
            return { reason: 'path-escape' };
        }
        // Any other unexpected error (programmer bug in a handler / OOM /
        // signal aborted) propagates — bashTool's caller will surface it
        // to the LLM as a tool failure rather than silently fall back.
        throw err;
    }
}
//# sourceMappingURL=dispatch.js.map