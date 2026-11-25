/**
 * ExtensionToolPermissionChecker — the `extension` tool (plugin extension authoring).
 *
 * An action asks when it runs code the Agent did not write through the ordinary file-write
 * permission:
 * - `preview` loads the package into the session, so it always asks.
 * - `test` runs the package's code in a test host. It asks only when `sourcePath` names a
 *   directory outside the session's dev directory for the plugin (`EXTENSION_DEV_ROOT_SEGMENTS`
 *   under the data dir, then `<sessionId>/<pluginId>/`, compared by real path); the dev directory
 *   holds what the Agent wrote under the Write permission, so testing it is silent.
 * - `init`, `inspect` and `withdraw` run no package code and are allowed.
 *
 * The rule content is the action name, so "allow in this conversation" writes a session rule
 * such as `extension(preview)` and "always allow" a global one.
 */
import fs from 'node:fs';
import path from 'node:path';
import { EXTENSION_DEV_ROOT_SEGMENTS, EXTENSION_DEV_SESSION_SEGMENT, } from './extension-dev-directory.js';
const EXTENSION_TOOL_NAME = 'extension';
/** The plugin name rule (`pluginId` of the tool); anything else names no dev directory. */
const PLUGIN_ID = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u;
const MAX_PLUGIN_ID_LENGTH = 80;
export class ExtensionToolPermissionChecker {
    checkPermissions(_toolName, 
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    input, context) {
        const action = typeof input.action === 'string' ? input.action : '';
        if (!asks(action, input, context)) {
            return {
                behavior: 'allow',
                reason: {
                    type: 'safetyCheck',
                    description: `extension ${action || 'call'} needs no approval`,
                },
            };
        }
        const denyRule = findActionRule(context, action, 'deny');
        if (denyRule)
            return { behavior: 'deny', reason: { type: 'rule', rule: denyRule } };
        const askRule = findActionRule(context, action, 'ask');
        if (askRule)
            return ask(action, { type: 'rule', rule: askRule });
        const allowRule = findActionRule(context, action, 'allow');
        if (allowRule)
            return { behavior: 'allow', reason: { type: 'rule', rule: allowRule } };
        return ask(action, {
            type: 'safetyCheck',
            description: action === 'preview'
                ? 'extension preview loads Agent-written code into this session'
                : "extension test runs code from outside this session's dev directory",
        });
    }
}
function asks(action, 
// eslint-disable-next-line @typescript-eslint/no-explicit-any
input, context) {
    if (action === 'preview')
        return true;
    if (action !== 'test' || input.sourcePath === undefined)
        return false;
    return !insideDevDirectory(input.sourcePath, input.pluginId, context);
}
/** `sourcePath` is the session's dev directory of the plugin or inside it, by real path. */
function insideDevDirectory(sourcePath, pluginId, context) {
    const { dataDir, sessionId } = context;
    if (typeof sourcePath !== 'string' || !path.isAbsolute(sourcePath))
        return false;
    if (typeof pluginId !== 'string' || pluginId.length > MAX_PLUGIN_ID_LENGTH)
        return false;
    if (!PLUGIN_ID.test(pluginId))
        return false;
    if (!sessionId || !EXTENSION_DEV_SESSION_SEGMENT.test(sessionId) || !dataDir)
        return false;
    const devDirectory = realPath(path.join(dataDir, ...EXTENSION_DEV_ROOT_SEGMENTS, sessionId, pluginId));
    const source = realPath(sourcePath);
    const relative = path.relative(devDirectory, source);
    if (relative === '')
        return true;
    return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
/** Resolves the existing part of the path, so a symlink cannot alias another directory in. */
function realPath(target) {
    try {
        return fs.realpathSync.native(target);
    }
    catch {
        const parent = path.dirname(target);
        return parent === target ? target : path.join(realPath(parent), path.basename(target));
    }
}
function ask(action, reason) {
    return { behavior: 'ask', reason, ruleContents: [action] };
}
/**
 * A rule for this action: its name or `*` (stored as rule content or as the command matcher the
 * rule store writes for it), or the whole tool.
 */
function findActionRule(context, action, behavior) {
    const names = (value) => value === '*' || value === action;
    return context.rules.find((rule) => {
        const { toolName, ruleContent, matcher } = rule.ruleValue;
        if (toolName !== EXTENSION_TOOL_NAME || rule.ruleBehavior !== behavior)
            return false;
        if (matcher?.kind === 'tool')
            return true;
        if (matcher?.kind === 'command')
            return names(matcher.pattern);
        if (matcher)
            return false;
        return !ruleContent || names(ruleContent);
    });
}
//# sourceMappingURL=extension-checker.js.map