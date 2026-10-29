import { agentShellInstructions } from '../../preparation/config/agent-shell-context.js';
import { readPermissionToolRequest, } from './permission-tool-request.js';
/**
 * A first Bash call may wait for the Windows Shell probe, but never longer
 * than this. The detector bounds a single probe (10s per child process) and
 * probes the three Shell families in parallel, so a healthy host settles far
 * inside this budget; only a stalled probe reaches it.
 */
const SHELL_READINESS_TIMEOUT_MS = 30_000;
/**
 * Windows-only, per-Turn handshake: the first native Bash call waits for the
 * Session Shell binding before the permission engine and the tool executor
 * ever see it. No command runs in that batch.
 */
export function createShellReadinessGuard(input) {
    const { hasShell, sessionId, resolveAgentShell } = input;
    let resolvedShell;
    const batches = new Map();
    const isBashCall = (request) => request.toolName === 'bash' && isNativeBashSource(request.toolSource);
    const awaitBashBatch = async (toolCallId, assistantMessage, signal, resolver) => {
        let pending = batches.get(toolCallId);
        if (!pending) {
            const bashToolCallIds = readBashToolCallIds(assistantMessage);
            if (!bashToolCallIds.has(toolCallId))
                return shellUnavailableBlock();
            if (resolvedShell)
                return undefined;
            // Seed before awaiting: parallel calls, serial calls and cloned
            // messages retain the same handshake result. Only a fresh batch
            // may execute afterwards.
            pending = (async () => {
                try {
                    return await resolver(sessionId);
                }
                catch {
                    return undefined;
                }
            })();
            for (const id of bashToolCallIds)
                batches.set(id, pending);
        }
        // The wait is bounded and abort-aware: a stalled Shell probe must not
        // hang the Turn, and a cancelled Turn must not keep waiting. The probe
        // itself keeps running and still binds the Session for a later Turn.
        const outcome = await waitForShellReadiness(pending, signal);
        if (outcome.kind === 'cancelled')
            return shellPendingBlock('Shell discovery was cancelled before it completed.');
        if (outcome.kind === 'timed-out')
            return shellPendingBlock(`Shell discovery did not finish within ${SHELL_READINESS_TIMEOUT_MS / 1000}s.`);
        const shell = outcome.shell;
        if (shell)
            resolvedShell = shell;
        return shell ? shellReadyBlock(shell) : shellUnavailableBlock();
    };
    return async (toolContext, signal) => {
        // Windows-only opt-in: the resolver is absent on non-Windows hosts,
        // so the guard is a structural no-op. `hasShell` short-circuits when
        // the prepare-time binding already proves the session can shell.
        if (!resolveAgentShell || hasShell)
            return undefined;
        const request = readPermissionToolRequest(toolContext, undefined);
        if (!isBashCall(request))
            return undefined;
        if (signal?.aborted)
            return shellPendingBlock('Shell discovery was cancelled before it completed.');
        // `resolveAgentShell` is narrowed to non-undefined above; pass it
        // explicitly so the helper signature is fully typed.
        return awaitBashBatch(request.toolCallId, toolContext.assistantMessage, signal, resolveAgentShell);
    };
}
/**
 * Catalog-owned bash provenance: only the runtime's builtin/builtin-matrix
 * bash triggers the readiness handshake. A user-configured tool that
 * reuses the name "bash" is never treated as the native executor, so the
 * resolver is never called for it.
 */
function isNativeBashSource(source) {
    return source === 'builtin' || source === 'builtin-matrix';
}
/** Raw message blocks only identify the batch; each invocation is separately catalog-checked. */
function readBashToolCallIds(assistantMessage) {
    const ids = new Set();
    for (const block of assistantMessage?.content ?? []) {
        if (block.type === 'toolCall' && block.name === 'bash' && block.id)
            ids.add(block.id);
    }
    return ids;
}
/** Block returned when the Session has no usable Agent-Shell binding. */
function shellUnavailableBlock() {
    return {
        block: true,
        blockedBy: 'permission',
        reason: 'AGENT_SHELL_UNAVAILABLE: no session Shell is bound. Continue with non-shell tools and retry after Shell availability is restored.',
    };
}
/**
 * Block returned when the readiness wait ended without a binding because the
 * Turn was cancelled or the wait exceeded its deadline. The Session is not
 * bound yet, so the model may retry once discovery completes.
 */
function shellPendingBlock(detail) {
    return {
        block: true,
        blockedBy: 'permission',
        reason: `AGENT_SHELL_PENDING: ${detail} No command was executed. Retry the bash call; the Session binds as soon as Shell discovery completes.`,
    };
}
/**
 * Block returned when the handshake resolved a binding. The reason
 * carries the catalog-owned shell instructions so the model can rewrite
 * the command for the resolved shell in a fresh assistant message.
 */
function shellReadyBlock(shell) {
    return {
        block: true,
        blockedBy: 'permission',
        reason: `AGENT_SHELL_READY: No command was executed. Rewrite command using the resolved shell and call bash again. ${agentShellInstructions(shell)}`,
    };
}
/**
 * Waits for the Shell binding without hanging the Turn. A cancelled Turn and
 * an exceeded deadline both end the wait early; the underlying probe keeps
 * running and still binds the Session for a later Turn.
 */
async function waitForShellReadiness(pending, signal) {
    if (signal?.aborted)
        return { kind: 'cancelled' };
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    let timer;
    const cancelled = new Promise((resolve) => {
        controller.signal.addEventListener('abort', () => resolve({ kind: 'cancelled' }), {
            once: true,
        });
    });
    const deadline = new Promise((resolve) => {
        timer = setTimeout(() => resolve({ kind: 'timed-out' }), SHELL_READINESS_TIMEOUT_MS);
        if (typeof timer.unref === 'function')
            timer.unref();
    });
    try {
        return await Promise.race([resolveShellBinding(pending), cancelled, deadline]);
    }
    finally {
        if (timer)
            clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
    }
}
/** A failed probe reads as "no binding" instead of an error. */
async function resolveShellBinding(pending) {
    try {
        return { kind: 'resolved', shell: await pending };
    }
    catch {
        return { kind: 'resolved', shell: undefined };
    }
}
//# sourceMappingURL=shell-readiness-guard.js.map