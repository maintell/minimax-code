import { createHash } from 'node:crypto';
import path from 'node:path';
import { LocalPluginHookPermissionMutationError, PLUGIN_HOOK_PERMISSION_STORE_VERSION as STORE_VERSION, } from './plugin-hook-permission-contracts.js';
const MAX_UPDATES_PER_REQUEST = 256;
const MAX_RULES_PER_BEHAVIOR = 4_096;
const MAX_DIRECTORIES_PER_SCOPE = 1_024;
export function validateRuntimeModes(input) {
    for (const update of input.updates) {
        if (update.type !== 'setMode')
            continue;
        if (update.mode === 'plan') {
            throw new LocalPluginHookPermissionMutationError('Plugin Hook setMode(plan) is not supported because MiniMax Plan mode has a separate Turn lifecycle.', 'UNSUPPORTED_MODE');
        }
    }
}
export function validateMutationInput(input) {
    if (!input.sessionId.trim() ||
        !input.cwd.trim() ||
        !Array.isArray(input.updates) ||
        input.updates.length > MAX_UPDATES_PER_REQUEST ||
        input.updates.some((update) => !isValidPermissionUpdate(update))) {
        throw new LocalPluginHookPermissionMutationError('Plugin Hook permission update has invalid identity or exceeds the operation limit.', 'INVALID_UPDATE');
    }
}
function isValidPermissionUpdate(value) {
    if (!isRecord(value) || !isPermissionDestination(value.destination))
        return false;
    if (value.type === 'addRules' || value.type === 'replaceRules' || value.type === 'removeRules') {
        return isValidRuleUpdate(value);
    }
    if (value.type === 'setMode') {
        return isValidUpdateMode(value.mode);
    }
    if (value.type === 'addDirectories' || value.type === 'removeDirectories') {
        return isValidDirectories(value.directories);
    }
    return false;
}
function isPermissionDestination(value) {
    return (value === 'session' ||
        value === 'localSettings' ||
        value === 'projectSettings' ||
        value === 'userSettings');
}
export function applyUpdate(state, update, workspace) {
    const next = cloneScope(state);
    if (update.type === 'addRules' ||
        update.type === 'replaceRules' ||
        update.type === 'removeRules') {
        const current = [...next.rules[update.behavior]];
        const rules = update.rules.map(cloneRule);
        const replacement = updateRuleList(current, rules, update.type);
        if (replacement.length > MAX_RULES_PER_BEHAVIOR) {
            throw new LocalPluginHookPermissionMutationError('Plugin Hook permission rule limit exceeded.', 'INVALID_UPDATE');
        }
        next.rules[update.behavior] = replacement;
    }
    else if (update.type === 'setMode') {
        next.mode = update.mode;
    }
    else if (update.type === 'addDirectories' || update.type === 'removeDirectories') {
        const directories = update.directories.map((directory) => normalizeDirectory(directory, workspace));
        next.directories =
            update.type === 'addDirectories'
                ? [...new Set([...next.directories, ...directories])]
                : next.directories.filter((directory) => !directories.includes(directory));
        if (next.directories.length > MAX_DIRECTORIES_PER_SCOPE) {
            throw new LocalPluginHookPermissionMutationError('Plugin Hook permission directory limit exceeded.', 'INVALID_UPDATE');
        }
    }
    else {
        throw new LocalPluginHookPermissionMutationError('Plugin Hook permission update type is invalid.', 'INVALID_UPDATE');
    }
    return freezeScope(next);
}
export function parsePersisted(value) {
    if (!isRecord(value))
        return invalidStore();
    const version = value.version === undefined ? STORE_VERSION : value.version;
    if (version !== STORE_VERSION)
        return invalidStore();
    return {
        version: STORE_VERSION,
        user: parseScope(value.user ?? {}),
        projects: parseWorkspaceScopes(value.projects ?? {}),
        locals: parseWorkspaceScopes(value.locals ?? {}),
    };
}
function parseWorkspaceScopes(value) {
    if (!isRecord(value))
        return invalidStore();
    const result = {};
    for (const [key, entry] of Object.entries(value)) {
        if (!/^[a-f0-9]{64}$/u.test(key) || !isRecord(entry) || typeof entry.workspace !== 'string') {
            return invalidStore();
        }
        const workspace = normalizeWorkspace(entry.workspace);
        if (workspaceKey(workspace) !== key)
            return invalidStore();
        result[key] = { workspace, state: parseScope(entry.state) };
    }
    return result;
}
function parseScope(value) {
    if (!isRecord(value))
        return invalidStore();
    const rules = isRecord(value.rules) ? value.rules : {};
    const result = {
        rules: {
            allow: parseRules(rules.allow ?? []),
            deny: parseRules(rules.deny ?? []),
            ask: parseRules(rules.ask ?? []),
        },
        directories: parseDirectories(value.directories ?? []),
        ...(value.mode !== undefined ? { mode: parseMode(value.mode) } : {}),
    };
    return freezeScope(result);
}
function parseRules(value) {
    if (!Array.isArray(value) || value.length > MAX_RULES_PER_BEHAVIOR)
        return invalidStore();
    return value.map((entry) => {
        if (!isRecord(entry) ||
            typeof entry.toolName !== 'string' ||
            !entry.toolName.trim() ||
            entry.toolName.length > 1_024 ||
            (entry.ruleContent !== undefined &&
                (typeof entry.ruleContent !== 'string' || entry.ruleContent.length > 64 * 1024))) {
            return invalidStore();
        }
        return {
            toolName: entry.toolName,
            ...(entry.ruleContent !== undefined ? { ruleContent: entry.ruleContent } : {}),
        };
    });
}
function parseDirectories(value) {
    if (!Array.isArray(value) ||
        value.length > MAX_DIRECTORIES_PER_SCOPE ||
        value.some((entry) => typeof entry !== 'string' || !path.isAbsolute(entry))) {
        return invalidStore();
    }
    return [...new Set(value)];
}
function parseMode(value) {
    if (value === 'default' || value === 'auto' || value === 'acceptEdits' || value === 'dontAsk') {
        return value;
    }
    return invalidStore();
}
export function toPermissionRules(state, source) {
    return ['allow', 'deny', 'ask'].flatMap((behavior) => state.rules[behavior].map((rule) => ({
        source,
        ruleBehavior: behavior,
        ruleValue: cloneRule(rule),
    })));
}
export function matchingWorkspaceState(entry, workspace) {
    if (!entry)
        return undefined;
    if (entry.workspace !== workspace)
        return invalidStore();
    return entry.state;
}
export function emptyPersisted() {
    return { version: STORE_VERSION, user: emptyScope(), projects: {}, locals: {} };
}
export function emptyScope() {
    return { rules: { allow: [], deny: [], ask: [] }, directories: [] };
}
export function clonePersisted(value) {
    return {
        version: STORE_VERSION,
        user: cloneScope(value.user),
        projects: Object.fromEntries(Object.entries(value.projects).map(([key, entry]) => [
            key,
            { workspace: entry.workspace, state: cloneScope(entry.state) },
        ])),
        locals: Object.fromEntries(Object.entries(value.locals).map(([key, entry]) => [
            key,
            { workspace: entry.workspace, state: cloneScope(entry.state) },
        ])),
    };
}
export function cloneScope(value) {
    return {
        rules: {
            allow: value.rules.allow.map(cloneRule),
            deny: value.rules.deny.map(cloneRule),
            ask: value.rules.ask.map(cloneRule),
        },
        directories: [...value.directories],
        ...(value.mode ? { mode: value.mode } : {}),
    };
}
export function freezeScope(value) {
    return {
        rules: {
            allow: Object.freeze(value.rules.allow.map(cloneRule)),
            deny: Object.freeze(value.rules.deny.map(cloneRule)),
            ask: Object.freeze(value.rules.ask.map(cloneRule)),
        },
        directories: Object.freeze([...value.directories]),
        ...(value.mode ? { mode: value.mode } : {}),
    };
}
function cloneRule(value) {
    return {
        toolName: value.toolName,
        ...(value.ruleContent !== undefined ? { ruleContent: value.ruleContent } : {}),
    };
}
function uniqueRules(values) {
    const result = [];
    for (const value of values)
        if (!result.some((candidate) => sameRule(candidate, value)))
            result.push(value);
    return result;
}
function sameRule(left, right) {
    return left.toolName === right.toolName && left.ruleContent === right.ruleContent;
}
export function normalizeWorkspace(value) {
    return path.resolve(value);
}
function normalizeDirectory(value, workspace) {
    if (!value.trim() || value.includes('\u0000')) {
        throw new LocalPluginHookPermissionMutationError('Plugin Hook permission directory is invalid.', 'INVALID_UPDATE');
    }
    return path.resolve(workspace, value);
}
export function workspaceKey(value) {
    return createHash('sha256').update(value).digest('hex');
}
function invalidStore() {
    throw new LocalPluginHookPermissionMutationError('Plugin Hook permission store contains an unsupported or malformed value.', 'STORE_CORRUPT');
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isValidRule(rule) {
    return (isRecord(rule) &&
        typeof rule.toolName === 'string' &&
        Boolean(rule.toolName.trim()) &&
        rule.toolName.length <= 1_024 &&
        (rule.ruleContent === undefined ||
            (typeof rule.ruleContent === 'string' && rule.ruleContent.length <= 64 * 1024)));
}
function updateRuleList(current, rules, type) {
    if (type === 'replaceRules')
        return uniqueRules(rules);
    if (type === 'addRules')
        return uniqueRules([...current, ...rules]);
    return current.filter((candidate) => !rules.some((rule) => sameRule(candidate, rule)));
}
function isValidRuleUpdate(value) {
    return ((value.behavior === 'allow' || value.behavior === 'deny' || value.behavior === 'ask') &&
        Array.isArray(value.rules) &&
        value.rules.length <= MAX_RULES_PER_BEHAVIOR &&
        value.rules.every(isValidRule));
}
function isValidUpdateMode(mode) {
    return (mode === 'default' ||
        mode === 'auto' ||
        mode === 'acceptEdits' ||
        mode === 'dontAsk' ||
        mode === 'bypassPermissions' ||
        mode === 'plan');
}
function isValidDirectories(directories) {
    return (Array.isArray(directories) &&
        directories.length <= MAX_DIRECTORIES_PER_SCOPE &&
        directories.every((directory) => typeof directory === 'string' &&
            Boolean(directory.trim()) &&
            !directory.includes('\u0000') &&
            directory.length <= 16_384));
}
//# sourceMappingURL=plugin-hook-permission-state.js.map