import { randomUUID } from 'node:crypto';
import { DEFAULT_BUDGET_LIMIT_TEMPLATE, DEFAULT_GOAL_COMPLETION_SUMMARY_TEMPLATE, DEFAULT_GOAL_CONTINUATION_TEMPLATE, DEFAULT_GOAL_RECOVERY_TEMPLATE, DEFAULT_GOAL_RECOVERY_TERMINAL_AUDIT_TEMPLATE, DEFAULT_GOAL_TERMINAL_AUDIT_TEMPLATE, DEFAULT_OBJECTIVE_UPDATED_TEMPLATE, renderBudgetLimitPrompt, renderCompletionSummaryPrompt, renderContinuationPrompt, renderKickoffPrompt, renderNudgePrompt, renderObjectiveUpdatedPrompt, renderRecoveryPrompt, renderRecoveryTerminalAuditPrompt, renderTerminalAuditPrompt, } from '@mavis/goal';
import { readPromptBundleScopeWithBuiltinFallback } from '../runtime/prompt-read.js';
const GOAL_PROMPT_KEYS = {
    budgetLimit: 'workflow/goal/budget-limit.md',
    completionSummary: 'workflow/goal/completion-summary.md',
    continuation: 'workflow/goal/continuation.md',
    objectiveUpdated: 'workflow/goal/objective-updated.md',
    recovery: 'workflow/goal/recovery.md',
    recoveryTerminalAudit: 'workflow/goal/recovery-terminal-audit.md',
    terminalAudit: 'workflow/goal/terminal-audit.md',
};
export async function prepareGoalPrompt(goal, kind, options) {
    if (!options.promptSnapshots) {
        return {
            content: withUndeliveredKickoffContext(goal, kind, renderBuiltinGoalPrompt(goal, kind)),
        };
    }
    const resolved = await readPromptBundleScopeWithBuiltinFallback(options.promptSnapshots, [
        { key: GOAL_PROMPT_KEYS.budgetLimit, builtin: DEFAULT_BUDGET_LIMIT_TEMPLATE },
        { key: GOAL_PROMPT_KEYS.completionSummary, builtin: DEFAULT_GOAL_COMPLETION_SUMMARY_TEMPLATE },
        { key: GOAL_PROMPT_KEYS.continuation, builtin: DEFAULT_GOAL_CONTINUATION_TEMPLATE },
        { key: GOAL_PROMPT_KEYS.objectiveUpdated, builtin: DEFAULT_OBJECTIVE_UPDATED_TEMPLATE },
        { key: GOAL_PROMPT_KEYS.recovery, builtin: DEFAULT_GOAL_RECOVERY_TEMPLATE },
        {
            key: GOAL_PROMPT_KEYS.recoveryTerminalAudit,
            builtin: DEFAULT_GOAL_RECOVERY_TERMINAL_AUDIT_TEMPLATE,
        },
        { key: GOAL_PROMPT_KEYS.terminalAudit, builtin: DEFAULT_GOAL_TERMINAL_AUDIT_TEMPLATE },
    ]);
    const content = withUndeliveredKickoffContext(goal, kind, renderGoalPrompt(goal, kind, resolved.templates), resolved.templates.get(GOAL_PROMPT_KEYS.continuation));
    if (!resolved.promptRead || !options.internalTurnPromptReads)
        return { content };
    const requestedTurnId = `turn_goal_${randomUUID()}`;
    if (!options.internalTurnPromptReads.reserve(requestedTurnId)) {
        throw new Error('Thread Goal prompt snapshot handoff is unavailable.');
    }
    options.internalTurnPromptReads.remember(requestedTurnId, resolved.promptRead);
    return {
        content,
        internalPromptRead: { requestedTurnId, promptRead: resolved.promptRead },
    };
}
function withUndeliveredKickoffContext(goal, kind, content, continuationTemplate) {
    if (goal.kickoffState !== 'consumed' ||
        goal.turnsUsed !== 0 ||
        kind === 'kickoff' ||
        kind === 'budget-limit' ||
        kind === 'completion-summary')
        return content;
    // A paused, never-started kickoff has no contract in conversation history.
    // Restore its full instructions alongside (not instead of) the recovery fence.
    return `${renderKickoffPrompt(goal, continuationTemplate)}\n\n${content}`;
}
function renderGoalPrompt(goal, kind, templates) {
    const continuation = templates.get(GOAL_PROMPT_KEYS.continuation) ?? DEFAULT_GOAL_CONTINUATION_TEMPLATE;
    if (kind === 'completion-summary')
        return renderCompletionSummaryPrompt(templates.get(GOAL_PROMPT_KEYS.completionSummary) ?? DEFAULT_GOAL_COMPLETION_SUMMARY_TEMPLATE);
    if (kind === 'kickoff')
        return renderKickoffPrompt(goal, continuation);
    if (kind === 'continuation')
        return renderContinuationPrompt(goal, continuation);
    if (kind === 'nudge')
        return renderNudgePrompt(goal, continuation);
    if (kind === 'recovery') {
        return renderRecoveryPrompt(goal, continuation, templates.get(GOAL_PROMPT_KEYS.recovery) ?? DEFAULT_GOAL_RECOVERY_TEMPLATE);
    }
    if (kind === 'terminal-audit') {
        return renderTerminalAuditPrompt(goal, continuation, templates.get(GOAL_PROMPT_KEYS.terminalAudit) ?? DEFAULT_GOAL_TERMINAL_AUDIT_TEMPLATE);
    }
    if (kind === 'recovery-terminal-audit') {
        return renderRecoveryTerminalAuditPrompt(goal, continuation, templates.get(GOAL_PROMPT_KEYS.recoveryTerminalAudit) ??
            DEFAULT_GOAL_RECOVERY_TERMINAL_AUDIT_TEMPLATE);
    }
    if (kind === 'objective-updated') {
        return renderObjectiveUpdatedPrompt(goal, templates.get(GOAL_PROMPT_KEYS.objectiveUpdated) ?? DEFAULT_OBJECTIVE_UPDATED_TEMPLATE);
    }
    return renderBudgetLimitPrompt(goal, templates.get(GOAL_PROMPT_KEYS.budgetLimit) ?? DEFAULT_BUDGET_LIMIT_TEMPLATE);
}
function renderBuiltinGoalPrompt(goal, kind) {
    if (kind === 'completion-summary')
        return renderCompletionSummaryPrompt();
    if (kind === 'kickoff')
        return renderKickoffPrompt(goal);
    if (kind === 'continuation')
        return renderContinuationPrompt(goal);
    if (kind === 'nudge')
        return renderNudgePrompt(goal);
    if (kind === 'recovery')
        return renderRecoveryPrompt(goal);
    if (kind === 'terminal-audit')
        return renderTerminalAuditPrompt(goal);
    if (kind === 'recovery-terminal-audit')
        return renderRecoveryTerminalAuditPrompt(goal);
    if (kind === 'objective-updated')
        return renderObjectiveUpdatedPrompt(goal);
    return renderBudgetLimitPrompt();
}
//# sourceMappingURL=prompt.js.map