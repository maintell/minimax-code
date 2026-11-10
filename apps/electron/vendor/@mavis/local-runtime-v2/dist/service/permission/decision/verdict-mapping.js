/**
 * Pure mappings from engine, checker and classifier outcomes to the facade's
 * public decision shape. They hold no facade state.
 */
import { formatDecisionReason, reducePermissionClassifierDecision, } from '@mavis/permission';
import { selectMatchingRule } from '../rules/rule-match.js';
/**
 * Bypass-immune local denials stop before the engine. The Bash checker then
 * evaluates individual subcommands, so a stored rejection of the complete
 * script is also honored before splitting it into those commands.
 */
export function resolveBoundaryDenial(input) {
    const { params, localHardCheck, recoverableNativeDelete, rules, localeHint } = input;
    if (localHardCheck?.behavior === 'deny' &&
        localHardCheck.denyKind === 'bypass-immune' &&
        !recoverableNativeDelete) {
        return { behavior: 'deny', reason: localHardCheck.reason, denySource: 'safety-immune' };
    }
    const wholeScriptRule = params.toolName === 'bash'
        ? selectMatchingRule(rules, params.toolName, params.input)
        : undefined;
    if (wholeScriptRule?.ruleBehavior !== 'deny')
        return undefined;
    return {
        behavior: 'deny',
        reason: formatDecisionReason({ type: 'rule', rule: wholeScriptRule }, 'deny', localeHint),
        denySource: 'rule',
    };
}
/**
 * Hooks may answer only the same ordinary fallback prompt that Compatible Code
 * allows a Hook to auto-approve. An explicit ask rule, a product safety
 * boundary, or any compound command containing either remains owned by the
 * user-facing permission flow.
 */
export function resolveLocalPolicyAsk(input) {
    const { askPolicy, localHardCheck, decision, rules, params } = input;
    if (askPolicy !== 'never' &&
        localHardCheck?.behavior === 'deny' &&
        localHardCheck.denyKind === 'policy' &&
        decision.behavior === 'allow' &&
        decision.reason.type !== 'rule' &&
        !hasMatchingLocalAllowRule(rules, params.toolName, params.input)) {
        return { behavior: 'ask', reason: localHardCheck.reason };
    }
    return undefined;
}
export function isOrdinaryFallbackAsk(reason) {
    if (reason.type === 'workingDirectory')
        return true;
    if (reason.type === 'safetyCheck')
        return reason.category === 'noMatchingPermissionRule';
    if (reason.type !== 'subcommandResults')
        return false;
    let sawAsk = false;
    for (const subcommand of reason.reasons.values()) {
        if (subcommand.behavior === 'deny')
            return false;
        if (subcommand.behavior !== 'ask')
            continue;
        sawAsk = true;
        if (!isOrdinaryFallbackAsk(subcommand.reason))
            return false;
    }
    return sawAsk;
}
/**
 * Map an engine `deny` {@link DecisionReason} to its LLM-facing source tag.
 * A `rule` reason is a user-configured deny rule; everything else
 * (safetyCheck / dangerousRemoval / pathValidation / …) is a built-in safety
 * boundary. For a compound bash command the reason is a `subcommandResults`
 * map — we attribute it to the first `deny` subcommand's inner reason
 * (deny sorts first, matching {@link formatSubcommandDecisionReason}).
 */
export function classifyDenySource(reason) {
    if (reason.type === 'rule')
        return 'rule';
    if (reason.type === 'subcommandResults') {
        for (const sub of reason.reasons.values()) {
            if (sub.behavior === 'deny') {
                return sub.reason.type === 'rule' ? 'rule' : 'safety';
            }
        }
        return 'safety';
    }
    return 'safety';
}
export function mapClassifierRecommendation(decision, behavior, reason, policyOwner) {
    const recommendation = { type: 'safetyCheck', description: reason };
    let reduced;
    if (policyOwner === 'core') {
        reduced = reducePermissionClassifierDecision(decision, { behavior, reason: recommendation });
    }
    else if (behavior === 'allow') {
        reduced = {
            behavior: 'allow',
            reason: recommendation,
            rewrittenInput: decision.rewrittenInput,
        };
    }
    else {
        reduced = { ...decision, reason: recommendation };
    }
    if (reduced.behavior === 'deny') {
        return {
            behavior: 'deny',
            reason: formatDecisionReason(reduced.reason, 'deny'),
            denySource: classifyDenySource(reduced.reason),
        };
    }
    if (reduced.behavior === 'allow') {
        return {
            behavior: 'allow',
            reason,
            rewrittenInput: reduced.rewrittenInput,
        };
    }
    return {
        behavior: 'ask',
        reason,
        ruleContents: reduced.ruleContents,
        ruleMatchers: reduced.ruleMatchers,
        rewrittenInput: reduced.rewrittenInput,
    };
}
export function serializeToolInput(toolName, input) {
    if (toolName === 'bash' && typeof input.command === 'string') {
        return input.command;
    }
    if (typeof input.file_path === 'string')
        return input.file_path;
    if (typeof input.filePath === 'string')
        return input.filePath;
    if (typeof input.path === 'string')
        return input.path;
    if (typeof input.pattern === 'string')
        return input.pattern;
    try {
        return JSON.stringify(input);
    }
    catch {
        return '';
    }
}
export function formatTimeoutSuffixSeconds(timeoutMs) {
    const secs = Math.round(timeoutMs / 1000);
    return ` (>${secs}s)`;
}
/**
 * Check whether the loaded rules contain a matching allow rule for this tool
 * call AND that no higher-priority deny/ask rule overrides it.
 *
 * Used by the policy-deny override logic to respect user-persisted
 * "Always allow" decisions for tools like web_fetch whose content-specific
 * rules (e.g. `web_fetch(*)`) are not resolved by the PermissionEngine's
 * whole-tool rule check (step 2b in the engine).
 *
 * Priority mirrors `LocalPermissionRuleStore.selectMatchingRule`:
 *   deny > ask > allow
 * Only returns true when the winning matched rule is an allow.
 */
function hasMatchingLocalAllowRule(rules, toolName, input) {
    return selectMatchingRule(rules, toolName, input)?.ruleBehavior === 'allow';
}
//# sourceMappingURL=verdict-mapping.js.map