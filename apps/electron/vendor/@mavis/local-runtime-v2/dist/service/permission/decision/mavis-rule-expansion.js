import { ASSIGNMENT_TOOL_COMMANDS, MAVIS_BACKED_TOOL_COMMANDS, MAVIS_BACKED_TOOL_NAMES, } from '@mavis/agent-tools/namespaced-tools';
/**
 * Tools a whole-tool `mavis` rule keeps governing after the composite tool was
 * split up.
 *
 * The sixteen commands that became tools of their own, plus Bunny's four
 * `assignment_*` tools: before the split every one of them was rewritten into a
 * `mavis` call before the ordinary policy saw it, so a whole-tool `mavis` rule
 * decided it. Measured on `c71be78104b` through the real facade, all six of the
 * assignment and session commands returned the rule's own behaviour.
 *
 * `session_create` is deliberately absent: it was added as its own tool while
 * the old `mavis session create` command was already refused, and the same
 * measurement returns `allow` for it under all three behaviours.
 *
 * Bunny's `dispatchAllowance` still overrides `assignment_create` /
 * `assignment_send` above this layer for a coordinator-owned Session, exactly as
 * before; widening here only restores what the engine itself decides.
 */
const MAVIS_WHOLE_TOOL_RULE_ALIASES = [
    ...MAVIS_BACKED_TOOL_NAMES,
    ...Object.keys(ASSIGNMENT_TOOL_COMMANDS),
];
/**
 * The mavis command each widened tool stood for before the split. A content rule
 * was matched against that string, so it is what decides which tool the rule
 * still reaches.
 */
const MAVIS_COMMAND_BY_TOOL_NAME = new Map([
    ...MAVIS_BACKED_TOOL_COMMANDS,
    ...Object.entries(ASSIGNMENT_TOOL_COMMANDS),
]);
const MAVIS_TOOL_NAME = 'mavis';
/**
 * Widens the rules the engine reads so a `mavis` rule still decides the tools
 * that command became.
 *
 * Two shapes widen:
 *
 * - A whole-tool rule (no content, matcher `tool` or absent) becomes one rule per
 *   widened tool. `mavis(<command>:<project>)` project rules carry a command
 *   matcher and keep their own reading path in the hosted project approval.
 * - A content-bearing **ask** rule becomes a whole-tool ask rule for each widened
 *   tool whose command string contains that content, which is the match the
 *   engine performs (`content-ask-rule.ts` compares `input.command` against the
 *   rule content with `includes`). Content-bearing deny and allow rules are left
 *   alone: they never reached a decision for these tools before the split either.
 *
 * The user's rule files are never rewritten — the copies exist for this decision
 * only.
 */
export function expandMavisWholeToolRules(rules) {
    const expanded = [];
    for (const rule of rules) {
        expanded.push(rule);
        if (isWidenedMavisRule(rule)) {
            for (const toolName of MAVIS_WHOLE_TOOL_RULE_ALIASES) {
                expanded.push({ ...rule, ruleValue: { ...rule.ruleValue, toolName } });
            }
            continue;
        }
        const content = widenedContentAskContent(rule);
        if (content === undefined)
            continue;
        for (const [toolName, command] of MAVIS_COMMAND_BY_TOOL_NAME) {
            if (!command.includes(content))
                continue;
            // A whole-tool ask rule: the content and matcher are dropped, because the
            // tool can only ever be called as this one command.
            expanded.push({ ...rule, ruleValue: { toolName } });
        }
    }
    return expanded;
}
function isWidenedMavisRule(rule) {
    const { toolName, ruleContent, matcher } = rule.ruleValue;
    if (toolName !== MAVIS_TOOL_NAME)
        return false;
    if (ruleContent !== undefined)
        return false;
    return matcher === undefined || matcher.kind === 'tool';
}
/**
 * The content of a `mavis` ask rule that widens by command string, if any.
 *
 * The matcher is not consulted: the engine's content-ask path selects a rule by
 * tool name, `ask` and a defined `ruleContent`, then compares `input.command`
 * against that content. The codec also stores a `command` matcher beside the
 * content, and the engine ignores it there.
 */
function widenedContentAskContent(rule) {
    const { toolName, ruleContent } = rule.ruleValue;
    if (toolName !== MAVIS_TOOL_NAME)
        return undefined;
    if (rule.ruleBehavior !== 'ask')
        return undefined;
    if (ruleContent === undefined || ruleContent === '')
        return undefined;
    return ruleContent;
}
//# sourceMappingURL=mavis-rule-expansion.js.map