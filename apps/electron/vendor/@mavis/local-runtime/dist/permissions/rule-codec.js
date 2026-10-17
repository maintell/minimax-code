import { LocalPermissionRuleError, } from './rule-model.js';
const VALID_BEHAVIORS = new Set(['allow', 'deny', 'ask']);
const VALID_SOURCES = new Set(['global', 'agent', 'session']);
const ALL_PERMISSION_ACTIONS = [
    'read',
    'write',
    'delete',
    'execute',
    'network',
];
const VALID_ACTIONS = new Set(ALL_PERMISSION_ACTIONS);
export function serializeLocalPermissionRule(rule) {
    return {
        source: rule.source,
        ruleBehavior: rule.ruleBehavior,
        ruleValue: rule.ruleValue,
        destination: rule.destination,
        toolName: rule.ruleValue.toolName,
        behavior: rule.ruleBehavior,
        ...(rule.ruleValue.ruleContent ? { ruleContent: rule.ruleValue.ruleContent } : {}),
        ...(rule.ruleValue.matcher ? { matcher: rule.ruleValue.matcher } : {}),
    };
}
export function readPermissionUpdate(raw) {
    const type = raw.type;
    if (type !== 'addRules' && type !== 'removeRules' && type !== 'replaceRules') {
        throw new LocalPermissionRuleError('Invalid permission update type');
    }
    const source = readRuleSource(raw.source);
    const destination = typeof raw.destination === 'string' ? raw.destination : undefined;
    if (!destination)
        throw new LocalPermissionRuleError('Missing permission update destination');
    const behavior = readRuleBehavior(raw.behavior);
    const rawRules = Array.isArray(raw.rules) ? raw.rules : undefined;
    if (!rawRules || rawRules.length === 0) {
        throw new LocalPermissionRuleError('Permission update requires at least one rule');
    }
    const rules = rawRules.map(readRuleValue);
    return { type, source, destination, rules, behavior };
}
export function readRuleSource(value) {
    if (typeof value === 'string' && VALID_SOURCES.has(value)) {
        return value;
    }
    throw new LocalPermissionRuleError(`Invalid permission rule source: ${String(value)}`);
}
function readRuleBehavior(value) {
    if (typeof value === 'string' && VALID_BEHAVIORS.has(value)) {
        return value;
    }
    throw new LocalPermissionRuleError(`Invalid permission rule behavior: ${String(value)}`);
}
function readRuleValue(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new LocalPermissionRuleError('Invalid permission rule');
    }
    const record = raw;
    const toolName = record.toolName ?? record.tool_name;
    const ruleContent = record.ruleContent ?? record.rule_content;
    if (typeof toolName !== 'string' || toolName.length === 0) {
        throw new LocalPermissionRuleError('Permission rule requires tool_name');
    }
    if (ruleContent !== undefined && typeof ruleContent !== 'string') {
        throw new LocalPermissionRuleError('Permission rule_content must be a string');
    }
    const matcher = record.matcher === undefined
        ? inferLegacyMatcher(typeof ruleContent === 'string' ? ruleContent : undefined)
        : readStoredMatcher(record.matcher);
    return {
        toolName,
        ...(matcher.kind === 'tool' ? {} : { ruleContent: matcher.pattern }),
        matcher,
    };
}
export function readRuleStringArray(value) {
    if (value === undefined)
        return undefined;
    return Array.isArray(value)
        ? value.filter((item) => typeof item === 'string')
        : [];
}
export function configV1ToRules(config, source, destination) {
    return [
        ...ruleStringsToRules(config.allow, source, destination, 'allow'),
        ...ruleStringsToRules(config.deny, source, destination, 'deny'),
        ...ruleStringsToRules(config.ask, source, destination, 'ask'),
    ];
}
export function configV2ToRules(config, source, destination) {
    return [
        ...storedRulesToRules(config.allow, source, destination, 'allow'),
        ...storedRulesToRules(config.deny, source, destination, 'deny'),
        ...storedRulesToRules(config.ask, source, destination, 'ask'),
    ];
}
function ruleStringsToRules(rules, source, destination, behavior) {
    return (rules ?? []).map((raw) => ({
        source,
        ruleBehavior: behavior,
        ruleValue: parseRuleString(raw),
        destination,
    }));
}
function parseRuleString(raw) {
    const openParen = raw.indexOf('(');
    if (openParen <= 0 || raw[openParen - 1] === '\\') {
        return { toolName: raw, matcher: { kind: 'tool' } };
    }
    const closeParen = raw.lastIndexOf(')');
    if (closeParen <= openParen)
        return { toolName: raw, matcher: { kind: 'tool' } };
    const toolName = raw.slice(0, openParen);
    const ruleContent = raw.slice(openParen + 1, closeParen);
    const matcher = inferLegacyMatcher(ruleContent || undefined);
    return {
        toolName,
        ...(matcher.kind === 'tool' ? {} : { ruleContent: matcher.pattern }),
        matcher,
    };
}
function serializeRuleValue(rule) {
    const matcher = rule.matcher ?? inferLegacyMatcher(rule.ruleContent);
    if (matcher.kind === 'tool')
        return rule.toolName;
    // v1 has no action field. An explicit v1 writer selection is a strict
    // storage rollback, so project structured path matchers back to their
    // legacy `tool(pattern)` representation and intentionally discard actions.
    // This restores the pre-v2 matcher semantics, where a path rule applied to
    // every action understood by that tool.
    return `${rule.toolName}(${matcher.pattern})`;
}
export function rulesToConfigV1(rules) {
    const config = { allow: [], deny: [], ask: [] };
    for (const rule of rules)
        config[rule.ruleBehavior].push(serializeRuleValue(rule.ruleValue));
    return config;
}
export function rulesToConfigV2(rules) {
    const config = { version: 2, allow: [], deny: [], ask: [] };
    for (const rule of rules)
        config[rule.ruleBehavior].push(ruleValueToStoredRule(rule.ruleValue));
    return config;
}
function storedRulesToRules(value, source, destination, behavior) {
    if (value === undefined)
        return [];
    if (!Array.isArray(value)) {
        throw new LocalPermissionRuleError(`PermissionConfigV2 ${behavior} rules must be an array.`);
    }
    return value.map((raw) => ({
        source,
        destination,
        ruleBehavior: behavior,
        ruleValue: readStoredRule(raw),
    }));
}
function readStoredRule(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new LocalPermissionRuleError('Invalid PermissionConfigV2 rule.');
    }
    const record = raw;
    if (typeof record.tool_name !== 'string' || !record.tool_name.trim()) {
        throw new LocalPermissionRuleError('PermissionConfigV2 rule requires tool_name.');
    }
    const matcher = readStoredMatcher(record.matcher);
    return {
        toolName: record.tool_name,
        ...(matcher.kind === 'tool' ? {} : { ruleContent: matcher.pattern }),
        matcher,
    };
}
function readStoredMatcher(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new LocalPermissionRuleError('PermissionConfigV2 rule requires matcher.');
    }
    const record = raw;
    if (record.kind === 'tool')
        return { kind: 'tool' };
    if (record.kind === 'command') {
        if (typeof record.pattern !== 'string' || !record.pattern.trim()) {
            throw new LocalPermissionRuleError('Command matcher requires a non-empty pattern.');
        }
        return { kind: 'command', pattern: record.pattern };
    }
    if (record.kind === 'path') {
        if (typeof record.pattern !== 'string' || !record.pattern.trim()) {
            throw new LocalPermissionRuleError('Path matcher requires a non-empty pattern.');
        }
        if (!Array.isArray(record.actions) || record.actions.length === 0) {
            throw new LocalPermissionRuleError('Path matcher requires explicit actions.');
        }
        const actions = [...new Set(record.actions.map(readPermissionAction))];
        return { kind: 'path', pattern: record.pattern, actions };
    }
    throw new LocalPermissionRuleError(`Invalid permission matcher kind: ${String(record.kind)}`);
}
function readPermissionAction(value) {
    if (typeof value === 'string' && VALID_ACTIONS.has(value)) {
        return value;
    }
    throw new LocalPermissionRuleError(`Invalid permission action: ${String(value)}`);
}
function inferLegacyMatcher(ruleContent) {
    if (!ruleContent)
        return { kind: 'tool' };
    return looksLikePathPattern(ruleContent)
        ? { kind: 'path', pattern: ruleContent }
        : { kind: 'command', pattern: ruleContent };
}
function looksLikePathPattern(value) {
    return (value.startsWith('/') ||
        value.startsWith('~/') ||
        value.startsWith('./') ||
        value.startsWith('../') ||
        /^[A-Za-z]:[\\/]/.test(value) ||
        value.startsWith('\\\\'));
}
function ruleValueToStoredRule(rule) {
    const matcher = rule.matcher ?? inferLegacyMatcher(rule.ruleContent);
    if (matcher.kind === 'tool') {
        return { tool_name: rule.toolName, matcher: { kind: 'tool' } };
    }
    if (matcher.kind === 'command') {
        return { tool_name: rule.toolName, matcher: { kind: 'command', pattern: matcher.pattern } };
    }
    return {
        tool_name: rule.toolName,
        matcher: {
            kind: 'path',
            pattern: matcher.pattern,
            actions: matcher.actions?.length ? [...matcher.actions] : [...ALL_PERMISSION_ACTIONS],
        },
    };
}
export function mutateRules(current, update) {
    if (update.type === 'replaceRules') {
        return [
            ...current.filter((rule) => rule.ruleBehavior !== update.behavior),
            ...update.rules.map((ruleValue) => buildRule(update, ruleValue)),
        ];
    }
    if (update.type === 'removeRules') {
        return current.filter((rule) => rule.ruleBehavior !== update.behavior ||
            !update.rules.some((ruleValue) => ruleValuesEqual(rule.ruleValue, ruleValue)));
    }
    const next = [...current];
    for (const ruleValue of update.rules) {
        if (next.some((rule) => rule.ruleBehavior === update.behavior && ruleValuesEqual(rule.ruleValue, ruleValue))) {
            continue;
        }
        next.push(buildRule(update, ruleValue));
    }
    return next;
}
function buildRule(update, ruleValue) {
    return {
        source: update.source,
        ruleBehavior: update.behavior,
        ruleValue,
        destination: update.destination,
    };
}
function ruleValuesEqual(a, b) {
    if (a.toolName !== b.toolName)
        return false;
    const aMatcher = a.matcher ?? inferLegacyMatcher(a.ruleContent);
    const bMatcher = b.matcher ?? inferLegacyMatcher(b.ruleContent);
    if (aMatcher.kind !== bMatcher.kind)
        return false;
    if (aMatcher.kind === 'tool' || bMatcher.kind === 'tool')
        return true;
    if (aMatcher.pattern !== bMatcher.pattern)
        return false;
    if (aMatcher.kind === 'command' || bMatcher.kind === 'command')
        return true;
    return sameActions(aMatcher.actions, bMatcher.actions);
}
function sameActions(a, b) {
    if (!a || !b)
        return a === b;
    return a.length === b.length && a.every((action) => b.includes(action));
}
//# sourceMappingURL=rule-codec.js.map