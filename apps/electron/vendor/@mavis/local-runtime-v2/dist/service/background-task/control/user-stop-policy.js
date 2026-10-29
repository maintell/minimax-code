import { CONVERSATION_STOP_CONFIG_DEFAULTS } from '@mavis/config';
import { logger } from '@mavis/shared/local-runtime-logging/logger';
/**
 * Reads the switches for one stop. Never throws: a reader that throws degrades
 * to the defaults exactly like an unreadable file, so a stop can never fail on
 * its configuration.
 */
export function readUserStopPolicy(read, sessionId) {
    let policy;
    let readerThrew = false;
    try {
        policy = read();
    }
    catch {
        // The shared reader never throws; an injected one might. Same outcome as a
        // failed read, and the error text is dropped for the same reason: it may
        // quote the config file, which can hold credentials.
        readerThrew = true;
        policy = {
            ...CONVERSATION_STOP_CONFIG_DEFAULTS,
            policySource: { stopSubAgent: 'read_failed', stopAsyncBash: 'read_failed' },
            failure: { reason: 'read_error' },
        };
    }
    if (policy.failure) {
        log('stop_cascade_config_read_failed', {
            sessionId,
            reason: readerThrew ? 'reader_threw' : policy.failure.reason,
            ...(policy.failure.errorCode ? { errorCode: policy.failure.errorCode } : {}),
            ...(policy.failure.line ? { line: policy.failure.line } : {}),
            ...(policy.configPath ? { configPath: policy.configPath } : {}),
            fallback: 'defaults',
        }, 'warn');
    }
    return policy;
}
/** Logs the policy only after the Session is known to be a root Session. */
export function logUserStopPolicy(sessionId, policy) {
    log('user_stop_cascade_policy', {
        sessionId,
        stopSubAgent: policy.stopSubAgent,
        stopAsyncBash: policy.stopAsyncBash,
        // Not `source`: the logger's mixin owns that key for the caller location.
        policySource: policy.policySource,
        ...(policy.ignoredKeys ? { ignoredKeys: policy.ignoredKeys } : {}),
    });
}
/** Both switches off: the stop cascades nothing, as before the cascade existed. */
export function isCascadeDisabledByPolicy(policy) {
    return !policy.stopSubAgent && !policy.stopAsyncBash;
}
/**
 * Root sweep only: drops the kinds this stop may not touch. `undefined` means no
 * filter (direct callers, and the future `owner_close`). Runs before the targets
 * are registered for suppression, so a skipped task is never registered and its
 * completion notice is delivered as usual once the stop window closes.
 */
export function applyRootStopPolicy(sessionId, tasks, policy) {
    if (!policy)
        return [...tasks];
    const kept = [];
    const skipped = { subagent: 0, bash: 0 };
    for (const task of tasks) {
        if (task.kind === 'subagent' && !policy.stopSubAgent)
            skipped.subagent += 1;
        else if (task.kind === 'bash' && !policy.stopAsyncBash)
            skipped.bash += 1;
        // `workflow` / `custom`: nothing creates them today. Neither switch covers
        // them, so they keep following the cascade whenever it runs.
        else
            kept.push(task);
    }
    if (!policy.stopSubAgent || !policy.stopAsyncBash) {
        // One summary per stop, counts only: per-task lines would drown the stop, and
        // every skipped task still reports back through its own completion notice.
        // Read subagents are not even listed while subagents are off, so they have
        // no count here, only the skipped sweep.
        log('cascade_skipped_by_policy', {
            sessionId,
            stopSubAgent: policy.stopSubAgent,
            stopAsyncBash: policy.stopAsyncBash,
            skipped,
            readSubagentSweep: policy.stopSubAgent ? 'ran' : 'skipped',
        });
    }
    return kept;
}
function log(event, fields, level = 'info') {
    try {
        logger[level]({ event: `background_task_${event}`, ...fields }, `User stop cascade: ${event}`);
    }
    catch {
        // Diagnostics must not interfere with an in-progress stop.
    }
}
//# sourceMappingURL=user-stop-policy.js.map