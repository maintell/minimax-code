import { matchesMcpServerRuntimeName } from './mcp-runtime-name.js';
import { hasWholeToolRule, isBypassMode, isInteractiveTool, } from './context.js';
import { extractToolInputContent, matchesContentAskRule } from './content-ask-rule.js';
/**
 * Production policy reducer used when Core owns the final decision. Existing
 * tool checkers keep their local ToolCheckResult interface; this reducer owns
 * cross-rule, mode, interactive-tool, and checker-result precedence.
 */
export function reducePermissionDecision(input) {
    const { toolName, context, checkerResult } = input;
    const denyRule = hasWholeToolRule(context, toolName, 'deny') ?? findMcpServerRule(toolName, context, 'deny');
    if (denyRule)
        return { behavior: 'deny', reason: { type: 'rule', rule: denyRule } };
    // A tool/content checker deny is an explicit deny for this invocation. It
    // must win over broader whole-tool or MCP ask rules; otherwise adding a
    // blanket ask can weaken a command-specific hard block.
    if (checkerResult?.behavior === 'deny') {
        return { behavior: 'deny', reason: checkerResult.reason };
    }
    const askRule = hasWholeToolRule(context, toolName, 'ask');
    const sandboxBypassesAsk = toolName === 'bash' && context.sandboxEnabled && context.autoAllowBashIfSandboxed;
    if (askRule && !sandboxBypassesAsk) {
        return {
            behavior: 'ask',
            reason: { type: 'rule', rule: askRule },
            ruleContents: resolveRuleContents(toolName, input.input, checkerResult),
            ruleMatchers: resolveRuleMatchers(checkerResult),
            candidateScopes: resolveCandidateScopes(checkerResult),
            rewrittenInput: checkerResult?.rewrittenInput,
        };
    }
    const mcpAskRule = findMcpServerRule(toolName, context, 'ask');
    if (mcpAskRule) {
        return {
            behavior: 'ask',
            reason: { type: 'rule', rule: mcpAskRule },
            ruleContents: resolveRuleContents(toolName, input.input),
        };
    }
    if (input.checkerError !== undefined) {
        return {
            behavior: 'ask',
            reason: {
                type: 'safetyCheck',
                description: `Tool checker error: ${input.checkerError || 'Unknown tool permission checker failure'}`,
            },
            ruleContents: resolveRuleContents(toolName, input.input),
        };
    }
    if (isInteractiveTool(context, toolName)) {
        return {
            behavior: 'ask',
            reason: {
                type: 'safetyCheck',
                description: `Tool "${toolName}" requires user interaction`,
            },
            ruleContents: resolveRuleContents(toolName, input.input, checkerResult),
            ruleMatchers: resolveRuleMatchers(checkerResult),
            candidateScopes: resolveCandidateScopes(checkerResult),
        };
    }
    if (checkerResult?.behavior === 'ask' && checkerResult.bypassImmune) {
        return {
            behavior: 'ask',
            reason: checkerResult.reason,
            ruleContents: resolveRuleContents(toolName, input.input, checkerResult),
            ruleMatchers: resolveRuleMatchers(checkerResult),
            candidateScopes: resolveCandidateScopes(checkerResult),
            bypassImmune: true,
            rewrittenInput: checkerResult.rewrittenInput,
            skipAutoClassifier: checkerResult.skipAutoClassifier,
        };
    }
    const contentAskRule = matchesContentAskRule(toolName, input.input, context);
    if (contentAskRule) {
        return {
            behavior: 'ask',
            reason: { type: 'rule', rule: contentAskRule },
            ruleContents: resolveRuleContents(toolName, input.input, checkerResult),
            ruleMatchers: resolveRuleMatchers(checkerResult),
            candidateScopes: resolveCandidateScopes(checkerResult),
            rewrittenInput: checkerResult?.rewrittenInput,
        };
    }
    if (checkerResult?.behavior === 'ask' && !isBypassMode(context)) {
        return {
            behavior: 'ask',
            reason: checkerResult.reason,
            ruleContents: resolveRuleContents(toolName, input.input, checkerResult),
            ruleMatchers: resolveRuleMatchers(checkerResult),
            candidateScopes: resolveCandidateScopes(checkerResult),
            rewrittenInput: checkerResult.rewrittenInput,
            skipAutoClassifier: checkerResult.skipAutoClassifier,
        };
    }
    if (isBypassMode(context)) {
        return {
            behavior: 'allow',
            reason: { type: 'mode', mode: 'bypassPermissions' },
            rewrittenInput: checkerResult?.rewrittenInput,
        };
    }
    const allowRule = hasWholeToolRule(context, toolName, 'allow') ?? findMcpServerRule(toolName, context, 'allow');
    if (allowRule) {
        return {
            behavior: 'allow',
            reason: { type: 'rule', rule: allowRule },
            rewrittenInput: checkerResult?.rewrittenInput,
        };
    }
    if (checkerResult?.behavior === 'allow') {
        return {
            behavior: 'allow',
            reason: checkerResult.reason,
            rewrittenInput: checkerResult.rewrittenInput,
        };
    }
    if (!input.checkerRegistered) {
        return {
            behavior: 'allow',
            reason: {
                type: 'safetyCheck',
                description: `No permission checker registered for tool "${toolName}", allowing by default`,
            },
        };
    }
    return {
        behavior: 'ask',
        reason: {
            type: 'safetyCheck',
            description: `No permission rule matched for tool "${toolName}"`,
        },
        ruleContents: resolveRuleContents(toolName, input.input, checkerResult),
        ruleMatchers: resolveRuleMatchers(checkerResult),
        candidateScopes: resolveCandidateScopes(checkerResult),
        rewrittenInput: checkerResult?.rewrittenInput,
    };
}
/**
 * Fold an external classifier recommendation back through Core policy.
 * Classifiers only refine an ASK; they never override a decision that Core
 * already finalized as ALLOW or DENY.
 */
export function reducePermissionClassifierDecision(decision, recommendation) {
    if (decision.behavior !== 'ask')
        return decision;
    if (recommendation.behavior === 'deny') {
        return { behavior: 'deny', reason: recommendation.reason };
    }
    if (recommendation.behavior === 'allow') {
        return {
            behavior: 'allow',
            reason: recommendation.reason,
            rewrittenInput: decision.rewrittenInput,
        };
    }
    return { ...decision, reason: recommendation.reason };
}
function findMcpServerRule(toolName, context, behavior) {
    if (!toolName.startsWith('mcp__'))
        return undefined;
    return context.rules.find((rule) => rule.ruleBehavior === behavior &&
        !rule.ruleValue.ruleContent &&
        matchesMcpServerRuntimeName(toolName, rule.ruleValue.toolName));
}
function resolveRuleContents(toolName, input, checkerResult) {
    if (checkerResult?.ruleContents?.length)
        return checkerResult.ruleContents;
    const content = extractToolInputContent(toolName, input);
    return content ? [content] : undefined;
}
function resolveCandidateScopes(checkerResult) {
    if (!checkerResult?.ruleContents?.length)
        return undefined;
    return checkerResult.candidateScopes?.length ? checkerResult.candidateScopes : undefined;
}
function resolveRuleMatchers(checkerResult) {
    if (!checkerResult?.ruleContents?.length)
        return undefined;
    return checkerResult.ruleMatchers?.length === checkerResult.ruleContents.length
        ? checkerResult.ruleMatchers
        : undefined;
}
export function reducePermissionEvaluation(input) {
    const evidence = input.evidence;
    const hostDeny = evidence.find((item) => item.kind === 'host-deny');
    if (hostDeny?.kind === 'host-deny')
        return { outcome: 'deny', reason: hostDeny.reason };
    const explicitDeny = evidence.find((item) => item.kind === 'user-rule' && item.behavior === 'deny');
    if (explicitDeny?.kind === 'user-rule') {
        return { outcome: 'deny', reason: explicitDeny.ruleContent ?? 'explicit user deny' };
    }
    const legacyDeny = evidence.find((item) => item.kind === 'legacy-deny');
    if (legacyDeny?.kind === 'legacy-deny')
        return { outcome: 'deny', reason: legacyDeny.reason };
    const classifierDeny = evidence.find((item) => item.kind === 'classifier-result' && item.behavior === 'deny');
    if (classifierDeny?.kind === 'classifier-result') {
        return { outcome: 'deny', reason: classifierDeny.reason };
    }
    const classifierIneligible = evidence.find((item) => item.kind === 'classifier-ineligible');
    const immuneAsk = evidence.find((item) => item.kind === 'user-rule' && item.behavior === 'ask');
    const classifierAsk = evidence.find((item) => item.kind === 'classifier-result' && item.behavior === 'ask');
    const explicitAsk = immuneAsk ?? classifierAsk;
    const classifierAllow = evidence.some((item) => item.kind === 'classifier-result' && item.behavior === 'allow');
    if (input.mode.interaction === 'headless-fail-closed' &&
        (explicitAsk || classifierIneligible || (!classifierAllow && !hasAllow(evidence)))) {
        return {
            outcome: 'deny',
            reason: 'permission requires user confirmation but no approval channel is available',
        };
    }
    if (explicitAsk ||
        classifierIneligible ||
        (input.mode.interaction !== 'neverAsk' && !classifierAllow && !hasAllow(evidence))) {
        return {
            outcome: 'ask',
            request: buildApprovalRequest(input, explicitAsk?.kind === 'user-rule' ? explicitAsk.ruleContent : undefined),
            ...(input.executionPlan ? { executionPlan: input.executionPlan } : {}),
        };
    }
    const allow = evidence.find((item) => (item.kind === 'user-rule' && item.behavior === 'allow') ||
        item.kind === 'built-in-allow' ||
        (item.kind === 'classifier-result' && item.behavior === 'allow'));
    if (allow) {
        return {
            outcome: 'allow',
            reason: allow.kind === 'user-rule' ||
                allow.kind === 'built-in-allow' ||
                allow.kind === 'classifier-result'
                ? allow.kind === 'user-rule'
                    ? (allow.ruleContent ?? 'explicit user allow')
                    : allow.reason
                : 'permission allowed',
            ...(input.executionPlan ? { executionPlan: input.executionPlan } : {}),
        };
    }
    if (input.mode.interaction === 'neverAsk' && input.mode.enforcement === 'strict') {
        return { outcome: 'deny', reason: 'permission interaction is disabled' };
    }
    return {
        outcome: 'ask',
        request: buildApprovalRequest(input),
        ...(input.executionPlan ? { executionPlan: input.executionPlan } : {}),
    };
}
function hasAllow(evidence) {
    return evidence.some((item) => (item.kind === 'user-rule' && item.behavior === 'allow') ||
        item.kind === 'built-in-allow' ||
        (item.kind === 'classifier-result' && item.behavior === 'allow'));
}
function buildApprovalRequest(input, preferredRuleContent) {
    const ruleContents = input.evidence
        .filter((item) => item.kind === 'user-rule')
        .map((item) => item.ruleContent)
        .filter((content) => Boolean(content));
    if (preferredRuleContent && !ruleContents.includes(preferredRuleContent))
        ruleContents.unshift(preferredRuleContent);
    return {
        requestId: `${input.context.sessionId ?? 'session'}:${input.toolName}`,
        sessionId: input.context.sessionId ?? 'unknown',
        ...(input.context.agentName ? { agentName: input.context.agentName } : {}),
        toolName: input.toolName,
        toolInput: formatToolInput(input.input),
        reason: 'permission requires approval',
        ruleContents,
        allowAlwaysSupported: true,
    };
}
function formatToolInput(input) {
    if (typeof input.command === 'string')
        return input.command;
    if (typeof input.filePath === 'string')
        return input.filePath;
    if (typeof input.file_path === 'string')
        return input.file_path;
    if (typeof input.path === 'string')
        return input.path;
    return undefined;
}
/** Compatibility hook for callers that still hold a legacy mode value. */
export function permissionModeToProfile(mode) {
    if (mode === 'bypassPermissions') {
        return {
            interaction: 'neverAsk',
            classifier: 'forbidden',
            enforcement: 'strict',
            bypass: 'allowed',
        };
    }
    if (mode === 'off') {
        return {
            interaction: 'neverAsk',
            classifier: 'forbidden',
            enforcement: 'off',
            bypass: 'allowed',
        };
    }
    if (mode === 'auto') {
        return { interaction: 'ask', classifier: 'allowed', enforcement: 'strict', bypass: 'allowed' };
    }
    return {
        interaction: 'ask',
        classifier: 'forbidden',
        enforcement: 'strict',
        bypass: 'forbidden',
    };
}
//# sourceMappingURL=permission-core.js.map