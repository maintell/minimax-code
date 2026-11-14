const DECIDED = 'ptc session mode decided';
const SWITCHED = 'ptc session mode switched';
const SWITCH_FAILED = 'ptc session mode switch failed';
const REFRESH_SKIPPED = 'ptc session mode refresh skipped';
const COMMITTED_COMPACTION_METHODS = ['llm_checkpoint', 'llm_segment_checkpoint'];
export function isCommittedCompactionMethod(value) {
    return COMMITTED_COMPACTION_METHODS.some((method) => method === value);
}
/**
 * The mode of a Session being created. A creator that copies a history passes the mode it
 * inherited and nothing is decided here; otherwise the policy decides, and `recorded` reports
 * that decision once the row exists.
 */
export function decideToolCallMode(policy, inherited) {
    const decision = inherited ? undefined : policy?.current();
    const mode = inherited ?? decision?.mode;
    return {
        fields: mode ? { toolCallMode: mode } : {},
        recorded: (session) => {
            if (policy && decision) {
                const fields = {
                    session_id: session.sessionId,
                    mode: decision.mode,
                    ptc_source: decision.source,
                };
                log(policy, 'info', fields, DECIDED);
                count(policy, decision, 'create');
            }
            return session;
        },
    };
}
/**
 * A summary (`llm_checkpoint`) compaction replaces the earlier tool calls, so only after it
 * does every Session (conversation, Task child, Peek, channel, cron) adopt the current switch.
 * A Bunny segment rebuild (`llm_segment_checkpoint`) keeps recent records; switching there would
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
        const decision = policy.current();
        const { mode: to, source } = decision;
        if (from === to)
            return;
        if (method !== 'llm_checkpoint') {
            const fields = { session_id: sessionId, method: method ?? 'unknown', from, to };
            log(policy, 'info', fields, REFRESH_SKIPPED);
            return;
        }
        await sessions.update(sessionId, { toolCallMode: to });
        log(policy, 'info', { session_id: sessionId, from, to, ptc_source: source, trigger: 'compaction' }, SWITCHED);
        count(policy, decision, 'compaction');
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
function count(policy, { mode, source }, trigger) {
    try {
        policy.metrics?.counter('ptc_session_mode_total', 1, { mode, source, trigger });
    }
    catch {
        // Diagnostics must not affect Session creation or the committed compaction.
    }
}
//# sourceMappingURL=tool-call-mode.js.map