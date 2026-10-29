import { randomUUID } from 'node:crypto';
import { DEFAULT_GOAL_CONTINUATION_TEMPLATE, DEFAULT_GOAL_RECOVERY_TEMPLATE, DEFAULT_GOAL_RECOVERY_TERMINAL_AUDIT_TEMPLATE, DEFAULT_GOAL_TERMINAL_AUDIT_TEMPLATE, DEFAULT_OBJECTIVE_UPDATED_TEMPLATE, renderContinuationPrompt, renderKickoffPrompt, renderNudgePrompt, renderObjectiveUpdatedPrompt, renderRecoveryPrompt, renderRecoveryTerminalAuditPrompt, renderTerminalAuditPrompt, } from '@mavis/goal';
import { readPromptBundleScopeWithBuiltinFallback } from './prompt-bundle.js';
import { goalTurnCount } from './reminder-policy.js';
const GOAL_PROMPT_KEYS = {
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
/**
 * A paused, never-started kickoff has no contract in conversation history.
 * Restore its full instructions alongside (not instead of) the resumed prompt.
 *
 * "Never started" is inferred from `kickoffState === 'consumed'` with zero
 * counted Goal turns. Known boundary: a kickoff turn that did start but was
 * aborted before its first request, or whose requests were all voided, also
 * leaves zero counted turns, so the resume injects the kickoff contract (and
 * the continuation re-attaches the first-turn attachments) a second time.
 * That costs tokens and duplicates context but loses nothing; fixing it needs
 * a durable "kickoff delivered" fact and is tracked as a follow-up.
 */
function withUndeliveredKickoffContext(goal, kind, content, continuationTemplate) {
    if (goal.kickoffState !== 'consumed' || goalTurnCount(goal) !== 0 || kind === 'kickoff') {
        return content;
    }
    return `${renderKickoffPrompt(goal, continuationTemplate)}\n\n${content}`;
}
function renderGoalPrompt(goal, kind, templates) {
    const continuation = templates.get(GOAL_PROMPT_KEYS.continuation) ?? DEFAULT_GOAL_CONTINUATION_TEMPLATE;
    return GOAL_PROMPT_RENDERERS[kind](goal, continuation, templates);
}
const GOAL_PROMPT_RENDERERS = {
    kickoff: (goal, continuation) => renderKickoffPrompt(goal, continuation),
    continuation: (goal, continuation) => renderContinuationPrompt(goal, continuation),
    nudge: (goal, continuation) => renderNudgePrompt(goal, continuation),
    recovery: (goal, continuation, templates) => renderRecoveryPrompt(goal, continuation, templates.get(GOAL_PROMPT_KEYS.recovery) ?? DEFAULT_GOAL_RECOVERY_TEMPLATE),
    'terminal-audit': (goal, continuation, templates) => renderTerminalAuditPrompt(goal, continuation, templates.get(GOAL_PROMPT_KEYS.terminalAudit) ?? DEFAULT_GOAL_TERMINAL_AUDIT_TEMPLATE),
    'recovery-terminal-audit': (goal, continuation, templates) => renderRecoveryTerminalAuditPrompt(goal, continuation, templates.get(GOAL_PROMPT_KEYS.recoveryTerminalAudit) ??
        DEFAULT_GOAL_RECOVERY_TERMINAL_AUDIT_TEMPLATE),
    'objective-updated': (goal, _continuation, templates) => renderObjectiveUpdatedPrompt(goal, templates.get(GOAL_PROMPT_KEYS.objectiveUpdated) ?? DEFAULT_OBJECTIVE_UPDATED_TEMPLATE),
};
function renderBuiltinGoalPrompt(goal, kind) {
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
    return renderObjectiveUpdatedPrompt(goal);
}
//# sourceMappingURL=prompt.js.map