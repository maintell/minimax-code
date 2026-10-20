/**
 * ToolPermissionContext management — immutable permission state.
 *
 * The context holds the in-memory representation of all permission rules,
 * the current mode, and environment settings. It is the single source of
 * truth for the {@link PermissionEngine} at query time.
 *
 * All mutations go through {@link applyPermissionUpdate}, which returns a
 * new frozen object (the original is never mutated).
 *
 * Reference: permission_design.md §3 (Persistence Layer) and §4.2 (Design Decisions).
 */
import { logger } from './host-utils.js';
// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------
/**
 * Create a new {@link ToolPermissionContext} from a configuration object.
 *
 * The returned object is deeply frozen. Any future mutations must go through
 * {@link applyPermissionUpdate}.
 */
export function createToolPermissionContext(config) {
    const ctx = Object.freeze({
        mode: config.mode ?? 'default',
        nativeDelete: config.nativeDelete ?? false,
        rules: Object.freeze([...(config.rules ?? [])]),
        sandboxEnabled: config.sandboxEnabled ?? false,
        autoAllowBashIfSandboxed: config.autoAllowBashIfSandboxed ?? false,
        platform: config.platform ?? process.platform,
        shellFamily: config.shellFamily ?? 'unknown',
        workingDirectory: config.workingDirectory,
        allowedWorkingPaths: Object.freeze([...(config.allowedWorkingPaths ?? [])]),
        sandboxAllowPaths: Object.freeze([...(config.sandboxAllowPaths ?? [])]),
        trustedExactWritePaths: Object.freeze([...(config.trustedExactWritePaths ?? [])]),
        dataDir: config.dataDir,
        homeDir: config.homeDir,
        isFile: config.isFile,
        agentName: config.agentName,
        sessionId: config.sessionId,
        allowManagedPermissionRulesOnly: config.allowManagedPermissionRulesOnly ?? false,
        interactiveTools: Object.freeze(new Set(config.interactiveTools ?? ['question'])),
    });
    return ctx;
}
// ---------------------------------------------------------------------------
// Immutable update
// ---------------------------------------------------------------------------
/**
 * Apply a {@link PermissionUpdate} to a context, returning a **new** frozen
 * context. The original `ctx` is never mutated.
 *
 * Supported update types:
 * - `addRules` — append new rules (deduplicated)
 * - `replaceRules` — replace all rules of a given behavior+source
 * - `removeRules` — remove matching rules
 */
export function applyPermissionUpdate(ctx, update) {
    switch (update.type) {
        case 'addRules':
            return addRules(ctx, update.source, update.rules, update.behavior);
        case 'replaceRules':
            return replaceRules(ctx, update.source, update.rules, update.behavior);
        case 'removeRules':
            return removeRules(ctx, update.source, update.rules, update.behavior);
    }
}
// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------
function cloneContextWith(ctx, patch) {
    return Object.freeze({
        mode: patch.mode ?? ctx.mode,
        nativeDelete: ctx.nativeDelete,
        rules: Object.freeze([...(patch.rules ?? ctx.rules)]),
        sandboxEnabled: ctx.sandboxEnabled,
        autoAllowBashIfSandboxed: ctx.autoAllowBashIfSandboxed,
        platform: ctx.platform,
        shellFamily: ctx.shellFamily,
        workingDirectory: ctx.workingDirectory,
        allowedWorkingPaths: ctx.allowedWorkingPaths,
        sandboxAllowPaths: ctx.sandboxAllowPaths,
        trustedExactWritePaths: ctx.trustedExactWritePaths,
        dataDir: ctx.dataDir,
        homeDir: ctx.homeDir,
        isFile: ctx.isFile,
        agentName: ctx.agentName,
        sessionId: ctx.sessionId,
        allowManagedPermissionRulesOnly: ctx.allowManagedPermissionRulesOnly,
        interactiveTools: ctx.interactiveTools,
    });
}
/** Check if two rule values are semantically equal. */
function ruleValueEquals(a, b) {
    if (a.toolName !== b.toolName || (a.ruleContent ?? '') !== (b.ruleContent ?? ''))
        return false;
    if (!a.matcher || !b.matcher)
        return a.matcher === b.matcher;
    if (a.matcher.kind !== b.matcher.kind)
        return false;
    if (a.matcher.kind === 'tool' || b.matcher.kind === 'tool')
        return true;
    if (a.matcher.pattern !== b.matcher.pattern)
        return false;
    if (a.matcher.kind === 'command' || b.matcher.kind === 'command')
        return true;
    const aActions = a.matcher.actions;
    const bActions = b.matcher.actions;
    if (!aActions || !bActions)
        return aActions === bActions;
    return (aActions.length === bActions.length && aActions.every((action) => bActions.includes(action)));
}
function addRules(ctx, source, values, behavior) {
    const existing = [...ctx.rules];
    for (const value of values) {
        // Deduplicate: skip if an identical rule already exists
        const duplicate = existing.some((r) => r.source === source && r.ruleBehavior === behavior && ruleValueEquals(r.ruleValue, value));
        if (!duplicate) {
            existing.push({ source, ruleBehavior: behavior, ruleValue: value });
        }
    }
    logger.info({ source, behavior, added: values.length, totalAfter: existing.length }, 'Added permission rules');
    return cloneContextWith(ctx, { rules: existing });
}
function replaceRules(ctx, source, values, behavior) {
    // Remove existing rules that match the given source + behavior
    const kept = ctx.rules.filter((r) => !(r.source === source && r.ruleBehavior === behavior));
    // Append the new rules
    const newRules = values.map((value) => ({
        source,
        ruleBehavior: behavior,
        ruleValue: value,
    }));
    logger.info({ source, behavior, removed: ctx.rules.length - kept.length, added: newRules.length }, 'Replaced permission rules');
    return cloneContextWith(ctx, { rules: [...kept, ...newRules] });
}
function removeRules(ctx, source, values, behavior) {
    const remaining = ctx.rules.filter((r) => {
        if (r.source !== source || r.ruleBehavior !== behavior)
            return true;
        return !values.some((v) => ruleValueEquals(r.ruleValue, v));
    });
    logger.info({ source, behavior, removed: ctx.rules.length - remaining.length }, 'Removed permission rules');
    return cloneContextWith(ctx, { rules: remaining });
}
// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------
/**
 * Check whether a tool has a whole-tool rule (no ruleContent) for a given behavior.
 *
 * Used in the engine's three-step flow to quickly determine if the entire tool
 * is in deny / ask / allow lists.
 */
export function hasWholeToolRule(ctx, toolName, behavior) {
    return ctx.rules.find((r) => r.ruleValue.toolName === toolName && r.ruleBehavior === behavior && !r.ruleValue.ruleContent);
}
/**
 * Get all content-specific rules for a tool + behavior.
 * These are rules WITH ruleContent (not whole-tool rules).
 */
export function getContentRulesForTool(ctx, toolName, behavior) {
    return ctx.rules.filter((r) => r.ruleValue.toolName === toolName &&
        r.ruleBehavior === behavior &&
        r.ruleValue.ruleContent !== undefined);
}
/**
 * Check if the context is in bypass mode.
 */
export function isBypassMode(ctx) {
    return ctx.mode === 'bypassPermissions';
}
/**
 * Check if a tool is registered as requiring user interaction.
 */
export function isInteractiveTool(ctx, toolName) {
    return ctx.interactiveTools.has(toolName);
}
//# sourceMappingURL=context.js.map