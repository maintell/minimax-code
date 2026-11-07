const SWITCHED = 'ptc session mode switched';
const SWITCH_FAILED = 'ptc session mode switch failed';
const REFRESH_SKIPPED = 'ptc session mode refresh skipped';
/**
 * Only a summary (`llm_checkpoint`) compaction replaces the earlier tool calls, so only after it
 * does every Session (conversation, Task child, Peek, channel, cron) adopt the current switch.
 * `tool_archive` and `tool_trim` replace tool results but keep the calls; switching there would
 * leave calls of the old catalog in the history, so the mode waits for the next summary
 * compaction or a new Session. A missing or unknown method keeps the mode too. The next Turn
 * assembles with the new mode; the running Turn keeps the catalog it was assembled with.
 * Best-effort: the compaction already succeeded and must not fail because of this; the next
 * summary compaction retries.
 */
export async function refreshToolCallModeAfterCompaction(refresh, sessionId, method) {
    if (!refresh)
        return;
    const { policy, sessions } = refresh;
    try {
        const session = await sessions.get(sessionId);
        if (!session)
            return;
        const from = session.toolCallMode ?? 'native';
        const to = policy.current();
        if (from === to)
            return;
        if (method !== 'llm_checkpoint') {
            const fields = { session_id: sessionId, method: method ?? 'unknown', from, to };
            log(policy, 'info', fields, REFRESH_SKIPPED);
            return;
        }
        await sessions.update(sessionId, { toolCallMode: to });
        log(policy, 'info', { session_id: sessionId, from, to, trigger: 'compaction' }, SWITCHED);
    }
    catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        log(policy, 'warn', { session_id: sessionId, trigger: 'compaction', reason }, SWITCH_FAILED);
    }
}
function log(policy, level, fields, message) {
    try {
        policy.logger?.[level](fields, message);
    }
    catch {
        // Diagnostics must not affect the committed compaction.
    }
}
//# sourceMappingURL=tool-call-mode.js.map