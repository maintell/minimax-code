import { desktopToolFailure, isDesktopToolErrorCode, isPtcTopLevelNamespacedToolName, namespaceForSkill, namespaceMetricLabel, namespacesUnlockingToolName, sharedReadsForNamespace, skillForNamespace, } from '@mavis/agent-tools/namespaced-tools';
import { incrementMetric, managedToolErrorCodeLabel, managedToolLabel, observeMetric, } from '@mavis/shared/local-runtime-logging/metric-registry';
import { ManagedSkillReceipts, } from '@mavis/shared/local-runtime-managed-skills';
/**
 * The Skill gate and the Skill-result append for namespaced builtin tools.
 *
 * One pass over the turn's native tools wraps two of them:
 *
 * - every namespaced on-demand tool gains a gate. Reading or writing, it runs
 *   only after a Skill that unlocks it was read in this conversation; without
 *   a receipt it returns `SKILL_REQUIRED` and never reaches the capability.
 *   A tool listed in another namespace's `sharedReads` is unlocked by that
 *   Skill too.
 * - the `skill` tool records the receipt on a successful read and, when that
 *   Skill owns a namespace, appends the namespace's tool definitions (plus its
 *   `sharedReads`) to the result, so the model does not have to search for what
 *   it just unlocked. A turn without a managed tool keeps the collection as is:
 *   there would be nothing to append.
 *
 * Both wrappers are installed on the native collection, before disclosure, so
 * `run_code`'s trusted-tool check and the `mcp_invoke` registry both hold the
 * wrapped objects and no path can reach the unwrapped implementation.
 */
/**
 * The managed-Skill receipt store a Host hands the harness as
 * `policy.toolCatalog.skillReceipts`.
 *
 * Every reader of the receipts — the gate below, the first-Turn preload and the
 * committed-compaction clear — must see one instance, so a Host creates it once
 * and keeps it. A Host that already owns a store passes its own: the desktop
 * Runtime shares one with its rewind and session-deleted clears. This factory
 * is for a Host with no other owner of that state, such as the stateless cloud
 * harness server, and it lives beside the gate's own contract so the harness
 * entry can vend it and a Host never reaches the shared receipt module itself.
 */
export function createSkillReceiptStore() {
    return new ManagedSkillReceipts();
}
/** Gate and append dependencies for one Turn's namespaced builtin tools. */
export function managedSkillToolsDeps(input, ptc) {
    const error = input.logger?.error;
    return {
        receipts: input.skillReceipts,
        ptc: ptc === true,
        coordinator: input.coordinator === true,
        ...(input.metricsClient ? { metrics: input.metricsClient } : {}),
        ...(error ? { logger: { error: (fields, message) => error(fields, message) } } : {}),
    };
}
/** Labels stay inside the registry: an unregistered tool name counts as `other`. */
const OTHER_LABEL = 'other';
export function withManagedSkillTools(tools, deps) {
    const managed = tools.filter(isManagedTool);
    if (managed.length === 0)
        return tools;
    return tools.map((tool) => {
        if (isManagedTool(tool))
            return gateTool(tool, deps);
        if (tool.def.name === 'skill')
            return appendUnlockedTools(tool, tools, deps);
        return tool;
    });
}
/** Only an on-demand namespaced tool is gated; every other tool is untouched. */
export function isManagedTool(tool) {
    return tool.def.namespace !== undefined && tool.def.loading === 'on_demand';
}
function gateTool(tool, deps) {
    const name = tool.def.name;
    const namespace = tool.def.namespace ?? OTHER_LABEL;
    const namespaceLabel = namespaceMetricLabel(tool.def.namespace);
    const label = managedToolLabel(name);
    const mode = deps.ptc === true ? 'ptc' : 'non_ptc';
    const unlocking = unlockingSkills(tool.def.namespace, name);
    return {
        ...tool,
        impl: {
            async execute(ctx, input, signal, onUpdate) {
                const sessionId = ctx.sessionId;
                const unlockedBy = unlocking.all.find((skill) => deps.receipts.hasLoaded(sessionId, skill));
                if (unlockedBy === undefined) {
                    incrementMetric(deps.metrics, 'managed_skill_gate_total', 1, {
                        namespace: namespaceLabel,
                        outcome: 'blocked',
                    });
                    incrementMetric(deps.metrics, 'managed_tool_call_total', 1, {
                        namespace: namespaceLabel,
                        tool: label,
                        status: 'skill_required',
                        mode,
                    });
                    incrementMetric(deps.metrics, 'managed_tool_error_total', 1, {
                        namespace: namespaceLabel,
                        tool: label,
                        error_code: 'skill_required',
                    });
                    deps.logger?.error({ namespace, tool: label, tool_name: name, error_code: 'SKILL_REQUIRED' }, '[local-runtime-v2] managed tool blocked: Skill not loaded');
                    const hint = unlocking.own ?? unlocking.all[0] ?? namespace;
                    return desktopToolFailure(name, 'SKILL_REQUIRED', `Load the \`${hint}\` Skill with the \`skill\` tool first, then call this tool again.`);
                }
                // `receipt` is the tool's own Skill; `shared_read` is another namespace's
                // Skill listing it in `sharedReads`, which is how often the model reads a
                // group's rules without loading that group's own Skill.
                incrementMetric(deps.metrics, 'managed_skill_gate_total', 1, {
                    namespace: namespaceLabel,
                    outcome: unlockedBy === unlocking.own ? 'receipt' : 'shared_read',
                });
                const startedAt = (deps.nowMs ?? Date.now)();
                const result = await tool.impl.execute(ctx, input, signal, onUpdate);
                const status = result.isError === true ? 'failed' : 'ok';
                observeMetric(deps.metrics, 'managed_tool_call_duration_ms', (deps.nowMs ?? Date.now)() - startedAt, { namespace: namespaceLabel, status });
                incrementMetric(deps.metrics, 'managed_tool_call_total', 1, {
                    namespace: namespaceLabel,
                    tool: label,
                    status,
                    mode,
                });
                reportFailure(deps, { name, label, namespace, namespaceLabel }, result);
                return result;
            },
        },
    };
}
function appendUnlockedTools(skillTool, tools, deps) {
    return {
        ...skillTool,
        impl: {
            async execute(ctx, input, signal, onUpdate) {
                const result = await skillTool.impl.execute(ctx, input, signal, onUpdate);
                const skill = loadedSkillName(input, result);
                if (skill === undefined)
                    return result;
                deps.receipts.markLoaded(ctx.sessionId, skill);
                const namespace = namespaceForSkill(skill);
                if (namespace === undefined)
                    return result;
                const unlocked = renderUnlockedNamespaceTools(skill, namespace, tools, {
                    ptc: deps.ptc === true,
                    coordinator: deps.coordinator === true,
                });
                if (unlocked === undefined) {
                    // A namespace whose tools load by default (the memory tools, a
                    // coordinator's Cron tools) has nothing to append, but the tools do
                    // exist — saying "no tool is available" would contradict the tool list
                    // the model is already holding.
                    const alreadyLoaded = defaultLoadedNamespaceTools(namespace, tools);
                    if (alreadyLoaded.length > 0) {
                        incrementMetric(deps.metrics, 'managed_skill_append_total', 1, {
                            namespace: namespaceMetricLabel(namespace),
                            outcome: 'already_loaded',
                        });
                        return withAppendedText(result, alreadyLoadedNote(namespace, alreadyLoaded));
                    }
                    incrementMetric(deps.metrics, 'managed_skill_append_total', 1, {
                        namespace: namespaceMetricLabel(namespace),
                        outcome: 'no_tools',
                    });
                    return withAppendedText(result, noToolsNote(skill, namespace));
                }
                incrementMetric(deps.metrics, 'managed_skill_append_total', 1, {
                    namespace: namespaceMetricLabel(namespace),
                    outcome: 'appended',
                });
                return withAppendedText(result, unlocked);
            },
        },
    };
}
/**
 * The `## Tools unlocked by this Skill` block for one namespace against a
 * Turn's own tools, or undefined when the namespace has no tool this turn.
 *
 * The `skill` tool appends this after a Skill read; the first-Turn preload
 * appends the same block inside its `<preloaded-skill>`, so a preloaded Skill
 * and a loaded one tell the model the same thing about how to call the tools.
 */
export function renderUnlockedNamespaceTools(skill, namespace, tools, options) {
    const byName = new Map(tools.map((tool) => [tool.def.name, tool]));
    const unlocked = unlockedTools(namespace, tools.filter(isManagedTool), byName);
    return unlocked.length === 0
        ? undefined
        : renderUnlockedTools(skill, unlocked, options.ptc, options.coordinator);
}
/** The namespace's own tools this turn, plus its `sharedReads` that exist. */
function unlockedTools(namespace, managed, byName) {
    const own = managed.filter((tool) => tool.def.namespace === namespace);
    const shared = sharedReadsForNamespace(namespace)
        .map((name) => byName.get(name))
        .filter((tool) => tool !== undefined);
    const seen = new Set();
    return [...own, ...shared].filter((tool) => {
        if (seen.has(tool.def.name))
            return false;
        seen.add(tool.def.name);
        return true;
    });
}
function withAppendedText(result, text) {
    return {
        ...result,
        text: `${result.text}\n\n${text}`,
        content: [...result.content, { type: 'text', text }],
    };
}
/**
 * The namespace's own tools this turn loads by default. The Skill gate covers
 * on-demand tools only, so these never appear in the appended block — but they
 * are in the model's tool list already.
 */
function defaultLoadedNamespaceTools(namespace, tools) {
    return tools.filter((tool) => tool.def.namespace === namespace && !isManagedTool(tool));
}
/** The note for a namespace whose tools were already loaded before the Skill. */
function alreadyLoadedNote(namespace, tools) {
    const names = tools.map((tool) => `\`${tool.def.name}\``).join(', ');
    return [
        '## Tools unlocked by this Skill',
        `None to append. The \`${namespace}\` tools are already in this turn's tool list (${names}), ` +
            'so call them the way you call any other tool here. This Skill added their rules, not their availability.',
    ].join('\n');
}
/**
 * The model-visible note for a Skill whose namespace has no tool this turn. A
 * silent Skill result reads as "loaded, nothing to do" and invites the model to
 * retry or invent a tool name, so the mismatch is stated where it happens.
 */
function noToolsNote(skill, namespace) {
    return [
        '## Tools unlocked by this Skill',
        `None. No \`${namespace}\` tool is available in this turn, so loading \`${skill}\` unlocked nothing. ` +
            'Tell the user this is unavailable here instead of retrying the Skill or guessing a tool name.',
    ].join('\n');
}
/**
 * A coordinator's catalog is an allowlist, so a Skill body written for every
 * Agent describes operations this conversation has no tool for. Stated where the
 * model reads the definitions, so it answers the user or dispatches instead of
 * spending a round on a call the executor refuses.
 */
const COORDINATOR_SCOPE_NOTE = 'This conversation can only use the tools listed below. The other operations this Skill describes cannot be done here; when the user needs one, ask them to do it in the app, or dispatch a task for it.';
function renderUnlockedTools(skill, tools, ptc, coordinator) {
    // A PTC Turn lists the promoted namespaced tools at the top level under their
    // own names. They stay in this block — the Skill still unlocks them — but the
    // call form has to be the top-level one, or the model reads a rule the Turn's
    // own tool list contradicts. A Turn without a promoted tool renders exactly
    // the text it rendered before.
    const topLevel = ptc
        ? tools.filter((tool) => isPtcTopLevelNamespacedToolName(tool.def.name))
        : [];
    const inRunCode = topLevel.length === 0
        ? tools
        : tools.filter((tool) => !isPtcTopLevelNamespacedToolName(tool.def.name));
    const call = ptc
        ? [
            ...(topLevel.length > 0
                ? [
                    `Call ${topLevel
                        .map((tool) => `\`${tool.def.name}\``)
                        .join(', ')} as a top-level tool call outside run_code, with an object matching \`input_schema\`.`,
                ]
                : []),
            ...(inRunCode.length > 0
                ? [
                    topLevel.length > 0
                        ? 'Call the rest inside run_code: `const r = await tools.<name>(args)`. Read results from `r.data`.'
                        : 'Call each one inside run_code: `const r = await tools.<name>(args)`. Read results from `r.data`.',
                    'Do not put a write that needs user confirmation in the same program as the read that chose its targets. End the program, ask the user with ask_user, then run the write in a new program.',
                    'After the user confirms, one program may run all confirmed writes and the read that checks them.',
                ]
                : []),
        ].join('\n')
        : 'Call one with `mcp_invoke`, setting `tool_name` to the exact name and `arguments` to an object matching `input_schema`.';
    const definitions = tools.map((tool) => ({
        name: tool.def.name,
        description: tool.def.description ?? '',
        input_schema: tool.def.schema,
    }));
    return [
        '## Tools unlocked by this Skill',
        `Host-generated for this turn, separate from the Skill file. Loading \`${skill}\` unlocked the tools below. ${call}`,
        ...(coordinator ? [COORDINATOR_SCOPE_NOTE] : []),
        JSON.stringify(definitions),
    ].join('\n');
}
/** The Skill name of a successful `skill` read, or undefined for anything else. */
function loadedSkillName(input, result) {
    const requested = requestedSkillName(input);
    const details = result.details;
    if (result.isError === true ||
        requested === undefined ||
        details?.kind !== 'skill' ||
        details.found !== true ||
        details.readable !== true ||
        details.skill !== requested) {
        return undefined;
    }
    return requested;
}
function requestedSkillName(input) {
    return input && typeof input === 'object' && 'name' in input && typeof input.name === 'string'
        ? input.name.trim()
        : undefined;
}
/**
 * Every Skill whose receipt unlocks a tool: the one bound to the tool's own
 * `namespace` field, plus every Skill that lists its name in `sharedReads`.
 * The field wins over the registry, so a namespaced tool is reachable even
 * before its name is registered in `BUILTIN_NAMESPACE_TOOL_NAMES`.
 */
function unlockingSkills(namespace, name) {
    const own = namespace === undefined ? undefined : skillForNamespace(namespace);
    const shared = namespacesUnlockingToolName(name)
        .filter((candidate) => candidate !== namespace)
        .map((candidate) => skillForNamespace(candidate))
        .filter((skill) => skill !== undefined);
    return { own, all: [...new Set([...(own === undefined ? [] : [own]), ...shared])] };
}
/**
 * A failed managed call logs one line whose `tool` matches the metric label, so a
 * log line and a metric series can be joined. The raw name travels beside it as
 * `tool_name`: an unregistered tool is `other` in the metric, and that alone
 * would not say which tool to look at.
 */
function reportFailure(deps, tool, result) {
    if (result.isError !== true)
        return;
    const code = result.details?.errorCode;
    const errorCode = typeof code === 'string' && isDesktopToolErrorCode(code) ? code : 'INTERNAL';
    incrementMetric(deps.metrics, 'managed_tool_error_total', 1, {
        namespace: tool.namespaceLabel,
        tool: tool.label,
        error_code: managedToolErrorCodeLabel(errorCode),
    });
    deps.logger?.error({
        namespace: tool.namespace,
        tool: tool.label,
        tool_name: tool.name,
        error_code: errorCode,
    }, '[local-runtime-v2] managed tool call failed');
}
//# sourceMappingURL=local-turn-tool-managed-skills.js.map