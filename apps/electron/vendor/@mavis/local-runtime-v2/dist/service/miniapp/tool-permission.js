import { homedir } from 'node:os';
import { createToolPermissionContext, PermissionEngine, } from '@mavis/permission';
import { MiniAppToolError, } from './contracts.js';
const ARGUMENTS_PREVIEW_MAX_CHARS = 2_000;
/**
 * The Agent permission rules as they apply to `context.tool`: the same rule file and engine, but
 * only global rules and the global mode. `auto` has no classifier here, so its asks reach the
 * Host prompt; `off` and "always allow" never ask, and only a deny survives them.
 */
export function createMiniAppToolPermissions(rules) {
    const engine = new PermissionEngine();
    const snapshot = async () => {
        const mode = readPermissionMode(rules.readPermissionMode());
        if (mode === 'off')
            return { check: () => 'allow' };
        const dataDir = rules.readDataDir();
        const context = createToolPermissionContext({
            mode: mode === 'acceptEdits' ? 'default' : mode,
            rules: (await rules.listGlobalRules()),
            // No workspace: path arguments outside the Host data dir ask, as outside a workspace.
            workingDirectory: dataDir,
            dataDir,
            homeDir: homedir(),
        });
        const policyOwner = rules.readPolicyOwner();
        return {
            check(name, input) {
                const decision = engine.checkPermission(name, { ...input }, context, { policyOwner });
                if (decision.behavior === 'ask' && mode === 'bypassPermissions')
                    return 'allow';
                return decision.behavior;
            },
        };
    };
    return {
        check: async (name, input) => (await snapshot()).check(name, input),
        snapshot,
        allowAlways: (name) => rules.addGlobalAllowRule(name),
    };
}
/**
 * The rule a call to `target` meets now. Without a rules port every call counts as `ask`; a
 * rule store that cannot be read also asks, as on the Agent path.
 */
async function currentMiniAppToolRule(target, permissions, input = {}) {
    if (target.builtin)
        return 'allow';
    if (!permissions)
        return 'ask';
    try {
        return await permissions.check(target.name, input);
    }
    catch {
        return 'ask';
    }
}
/**
 * One call's permission step: the Agent rules (global only) decide, `ask` goes to the Host
 * prompt, "always allow" writes the shared global rule. Throws a not-dispatched `MiniAppToolError`
 * when the call may not run; without a prompt an `ask` cannot be answered and fails closed.
 */
export async function judgeMiniAppToolCall(ports, input) {
    const { target, judgement } = input;
    const rule = await currentMiniAppToolRule(target, ports.permissions, input.arguments);
    judgement.rule = target.builtin ? 'builtin' : rule;
    if (rule === 'allow')
        return;
    if (rule === 'deny')
        throw new MiniAppToolError('TOOL_NOT_PERMITTED');
    const answer = ports.approvals
        ? await ports.approvals.request({
            mode: 'call',
            pluginId: input.pluginId,
            tools: [{ ...promptItem(target), argumentsPreview: previewArguments(input.arguments) }],
            signal: input.signal,
        })
        : 'unavailable';
    const decision = answer === 'unavailable' ? answer : answer.decision;
    judgement.decision = decision;
    if (decision === 'unavailable')
        throw new MiniAppToolError('TOOL_APPROVAL_REQUIRED');
    if (decision === 'deny')
        throw new MiniAppToolError('TOOL_NOT_PERMITTED');
    if (decision === 'allowAlways') {
        judgement.ruleWriteFailed = !(await rememberAllow(ports.permissions, target.name));
    }
}
/**
 * `request()`: tools already allowed or denied stay out of the prompt; the user ticks which of
 * the rest to always allow. Returns the state of every target afterwards.
 */
export async function requestMiniAppToolPermissions(ports, input) {
    const before = await currentRules(input.targets, ports.permissions);
    const pending = input.targets.filter((target) => before[target.name] === 'ask');
    if (pending.length === 0)
        return { permissions: before, approvalRequired: false };
    const answer = ports.approvals
        ? await ports.approvals.request({
            mode: 'request',
            pluginId: input.pluginId,
            tools: pending.map(promptItem),
            signal: input.signal,
        })
        : 'unavailable';
    if (answer === 'unavailable')
        return { permissions: before, approvalRequired: true };
    if (answer.decision !== 'allowAlways')
        return { permissions: before, approvalRequired: false };
    const ticked = new Set(answer.names ?? []);
    for (const target of pending) {
        if (ticked.has(target.name))
            await rememberAllow(ports.permissions, target.name);
    }
    return {
        permissions: await currentRules(input.targets, ports.permissions),
        approvalRequired: false,
    };
}
/**
 * The rules `targets` meet now, judged against one read of the rule file: `list()` and
 * `request()` judge many tools at once, while each call keeps its own read. Same fallbacks as
 * `currentMiniAppToolRule`.
 */
export async function currentMiniAppToolRules(targets, permissions) {
    const snapshot = targets.some((target) => !target.builtin)
        ? await readRuleSnapshot(permissions)
        : undefined;
    return targets.map((target) => {
        if (target.builtin)
            return 'allow';
        if (!snapshot)
            return 'ask';
        try {
            return snapshot.check(target.name, {});
        }
        catch {
            return 'ask';
        }
    });
}
async function readRuleSnapshot(permissions) {
    try {
        return await permissions?.snapshot();
    }
    catch {
        return undefined;
    }
}
async function currentRules(targets, permissions) {
    const verdicts = await currentMiniAppToolRules(targets, permissions);
    return Object.fromEntries(targets.map((target, index) => [target.name, verdicts[index] ?? 'ask']));
}
/** A failed rule write only costs a future prompt; the user's answer still holds. */
async function rememberAllow(permissions, name) {
    try {
        await permissions?.allowAlways(name);
        return permissions !== undefined;
    }
    catch {
        return false;
    }
}
const PERMISSION_MODES = ['default', 'acceptEdits', 'bypassPermissions', 'auto', 'off'];
/** As the Agent path reads it: an unknown stored mode counts as `auto`. */
function readPermissionMode(value) {
    return PERMISSION_MODES.find((mode) => mode === value) ?? 'auto';
}
function promptItem(target) {
    return { name: target.name, kind: target.kind, owner: target.owner, tool: target.tool };
}
function previewArguments(value) {
    let json;
    try {
        json = JSON.stringify(value, null, 2) ?? '{}';
    }
    catch {
        json = '{}';
    }
    return json.length > ARGUMENTS_PREVIEW_MAX_CHARS
        ? `${json.slice(0, ARGUMENTS_PREVIEW_MAX_CHARS)}…`
        : json;
}
//# sourceMappingURL=tool-permission.js.map