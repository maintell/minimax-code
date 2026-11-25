/**
 * The permission decision contract the Turn gate consumes, plus the pure
 * validators that fail a Host-supplied decision closed and the "Always allow"
 * rule-content derivation. Split out of `policy/local-turn-permission-gate.ts`
 * for the layout budget; the gate keeps hook ordering, plan consumption and
 * fail-closed mapping.
 *
 * This module imports nothing: every shape here is structural, so the gate and
 * the Host stay on opposite sides of the AgentHost dependency boundary.
 */
export function validatePermissionDecision(decision) {
    if (!isPermissionDecisionObject(decision)) {
        throw new TypeError('Permission decision source returned an invalid decision.');
    }
    return decision;
}
function isPermissionDecisionObject(decision) {
    if (!decision || typeof decision !== 'object')
        return false;
    const behavior = Reflect.get(decision, 'behavior');
    const reason = Reflect.get(decision, 'reason');
    const executionPlan = Reflect.get(decision, 'executionPlan');
    const legacyRewrite = Reflect.get(decision, 'rewrittenInput');
    const ruleContents = Reflect.get(decision, 'ruleContents');
    const ruleMatchers = Reflect.get(decision, 'ruleMatchers');
    const hookAutoApprovalEligible = Reflect.get(decision, 'hookAutoApprovalEligible');
    return (isPermissionBehavior(behavior) &&
        typeof reason === 'string' &&
        isOptionalRecord(executionPlan) &&
        legacyRewrite === undefined &&
        isOptionalRuleContents(ruleContents) &&
        isOptionalRuleMatchers(ruleMatchers, ruleContents) &&
        isOptionalBoolean(hookAutoApprovalEligible));
}
function isOptionalBoolean(value) {
    return value === undefined || typeof value === 'boolean';
}
function isPermissionBehavior(value) {
    return value === 'allow' || value === 'deny' || value === 'ask';
}
function isOptionalRecord(value) {
    return (value === undefined || (Boolean(value) && typeof value === 'object' && !Array.isArray(value)));
}
function isOptionalRuleContents(value) {
    return (value === undefined ||
        (Array.isArray(value) &&
            value.every((rule) => typeof rule === 'string' && Boolean(rule.trim()))));
}
function isOptionalRuleMatchers(value, ruleContents) {
    if (value === undefined)
        return true;
    if (!Array.isArray(value) ||
        !Array.isArray(ruleContents) ||
        value.length !== ruleContents.length) {
        return false;
    }
    return value.every(isRuleMatcher);
}
function isRuleMatcher(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return false;
    const kind = Reflect.get(value, 'kind');
    if (kind === 'tool')
        return true;
    const pattern = Reflect.get(value, 'pattern');
    if (kind === 'command')
        return isNonBlankString(pattern);
    if (kind !== 'path' || !isNonBlankString(pattern))
        return false;
    const actions = Reflect.get(value, 'actions');
    return isPermissionRuleActions(actions);
}
function isNonBlankString(value) {
    return typeof value === 'string' && Boolean(value.trim());
}
function isPermissionRuleActions(value) {
    if (!Array.isArray(value) || value.length === 0)
        return false;
    const validActions = new Set(['read', 'write', 'delete', 'execute', 'network']);
    return value.every((action) => typeof action === 'string' && validActions.has(action));
}
export function validateApprovalDecision(decision) {
    if (decision !== 'allowOnce' && decision !== 'allowAlways' && decision !== 'deny') {
        throw new TypeError('Permission approval owner returned an invalid decision.');
    }
    return decision;
}
export function deriveRuleContents(toolName, input) {
    const direct = deriveRuleTarget(input);
    return typeof direct === 'string' && direct.trim() ? [direct.trim()] : [toolName];
}
function deriveRuleTarget(input) {
    const primary = input.command ?? input.path ?? input.filePath ?? input.file_path;
    if (primary !== undefined && primary !== null)
        return primary;
    return typeof input.url === 'string' ? urlRuleTarget(input.url) : (input.url ?? input.pattern);
}
/**
 * The rule matcher compares URL inputs by `URL.host` (hostname plus a
 * non-default port), so an "Always allow" rule for an http(s) URL is stored as
 * that host. Anything else stays verbatim, as the matcher compares it.
 */
function urlRuleTarget(url) {
    const trimmed = url.trim();
    if (!/^https?:\/\//i.test(trimmed))
        return url;
    try {
        return new URL(trimmed).host || url;
    }
    catch {
        return url;
    }
}
//# sourceMappingURL=permission-decision-contract.js.map