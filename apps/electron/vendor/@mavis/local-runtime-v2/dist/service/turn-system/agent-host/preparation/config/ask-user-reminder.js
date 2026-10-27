import { parseAskUserConfig, resolveAskUserPolicyContext, resolveEffectiveAskUserPolicy, } from '@mavis/config';
import { decideAskUserReminders } from '@mavis/system-reminder';
/**
 * Decides the `<ask-user-policy>` declaration and `<ask-user-guidance>` block
 * for this Turn from history instead of a Turn counter: the in-memory counter
 * survives compaction but resets on restart or eviction, which would both
 * suppress needed re-injection and duplicate existing blocks.
 */
export async function resolveAskUserReminder(execution, source, logger) {
    const fields = { session_id: execution.lease.sessionId, turn_id: execution.lease.turnId };
    const hasAskUserTool = execution.assembly?.tools.some((tool) => tool.def.name === 'ask_user');
    if (!source || !hasAskUserTool || execution.request.executionMode === 'continuation') {
        // Continuation resumes without a new user message, so a prefix would never
        // reach history; the next prompted Turn re-evaluates from history instead.
        let reason = 'continuation-turn';
        if (!source)
            reason = 'no-policy-source';
        else if (!hasAskUserTool)
            reason = 'no-ask-user-tool';
        logAskUserReminder(logger, 'debug', { ...fields, reason }, 'ask_user reminders skipped');
        return undefined;
    }
    const config = parseAskUserConfig({ askUser: safeReadAskUserConfig(source, logger, fields) });
    const planActive = execution.assemblyContext.plan?.active === true;
    const goalActive = planActive ? false : await safeIsGoalActive(source, execution, logger);
    const context = resolveAskUserPolicyContext({ planActive, goalActive });
    const managedProvider = execution.preparation.llm.managedProvider === true;
    const decision = decideAskUserReminders({
        effectivePolicy: reminderPolicy(context, resolveEffectiveAskUserPolicy(config, context)),
        hasAskUserTool: true,
        managedProvider,
        historyTexts: runtimeOwnedUserTexts(execution),
    });
    logAskUserReminder(logger, 'info', {
        ...fields,
        ask_user_context: context,
        effective_policy: decision.policy.effective,
        declared_policy: decision.policy.declared ?? null,
        policy_injected: decision.policy.injected,
        policy_reason: decision.policy.reason,
        managed_provider: managedProvider,
        guidance_injected: decision.guidance.injected,
        guidance_reason: decision.guidance.reason,
    }, decision.reminder ? 'ask_user reminders injected' : 'ask_user reminders not injected');
    return decision.reminder;
}
/**
 * In a Goal, skip waits up to 60 s and then selects the recommended options
 * (the ask_user call decides the same from the same facts), so it gets its own
 * declaration instead of the "never waits" skip text.
 */
function reminderPolicy(context, policy) {
    return context === 'goal' && policy === 'skip' ? 'goal-skip' : policy;
}
// A broken config read must not fail the Turn; it falls back to the default
// policies, the same ones the ask_user call falls back to.
function safeReadAskUserConfig(source, logger, fields) {
    try {
        return source.readConfig();
    }
    catch (error) {
        logAskUserReminder(logger, 'warn', { ...fields, reason: 'config-read-failed', error: errorMessage(error) }, 'ask_user reminder config read failed; using defaults');
        return undefined;
    }
}
// Goal lookup failure degrades to the default policy for this Turn only; the
// next Turn retries and injects a correction if the Goal policy differs.
async function safeIsGoalActive(source, execution, logger) {
    try {
        return await source.isGoalActive(execution.lease.sessionId);
    }
    catch (error) {
        logAskUserReminder(logger, 'warn', {
            session_id: execution.lease.sessionId,
            turn_id: execution.lease.turnId,
            reason: 'goal-read-failed',
            error: errorMessage(error),
        }, 'ask_user reminder goal lookup failed; treating Turn as outside Goal');
        return false;
    }
}
/**
 * Text of earlier user messages that the runtime (not the user) wrote. When a
 * message records where the genuine user query starts, only the prefix before it
 * is scanned, so a user pasting a reminder block verbatim cannot suppress a
 * declaration. Messages without that range are scanned whole; detection still
 * requires the complete runtime-rendered block.
 */
function runtimeOwnedUserTexts(execution) {
    return (execution.runnerHistory ?? execution.history).messages.flatMap((message) => {
        if (Reflect.get(message, 'role') !== 'user')
            return [];
        const text = userMessageText(message);
        if (!text)
            return [];
        const range = Reflect.get(message, 'canonicalTextRange');
        const start = range && typeof range === 'object' ? Reflect.get(range, 'startOffset') : undefined;
        return [
            typeof start === 'number' && Number.isSafeInteger(start) && start >= 0
                ? text.slice(0, start)
                : text,
        ];
    });
}
function userMessageText(message) {
    const content = Reflect.get(message, 'content');
    if (typeof content === 'string')
        return content;
    if (!Array.isArray(content))
        return '';
    return content
        .flatMap((block) => block && typeof block === 'object' && Reflect.get(block, 'type') === 'text'
        ? [String(Reflect.get(block, 'text') ?? '')]
        : [])
        .join('\n');
}
function logAskUserReminder(logger, level, fields, message) {
    try {
        logger?.[level]?.({ event: 'ask_user_reminder_decision', ...fields }, `[local-runtime-v2] ${message}`);
    }
    catch {
        // Diagnostics must never change Turn preparation behavior.
    }
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
//# sourceMappingURL=ask-user-reminder.js.map