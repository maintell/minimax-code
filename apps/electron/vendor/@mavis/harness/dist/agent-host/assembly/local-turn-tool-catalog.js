import { restoreManagedSkillReceiptsFromHistory, } from '@mavis/shared/local-runtime-managed-skills';
import { MAVIS_CAPABILITY_TOOL_NAMES } from '@mavis/agent-tools/cron';
// The host-neutral entry, not the package root: the root carries Node IO and
// product runtimes, which the architecture gate keeps out of Turn assembly.
import { BUILTIN_NAMESPACED_TOOL_NAMES } from '@mavis/agent-tools/namespaced-tools';
import { createMcpInvokeTool, readToolSearchTurnFacts, renderMcpToolSearchHintBlock, resolveMcpDisclosureOptions, toolSearchTurnWiring, } from '@mavis/agent-tools/mcp-disclosure';
import { filterCanonicalNativeToolCeiling, getSuppressedToolNamesForModelCapabilities, isCanonicalBuiltinTurn, } from '@mavis/agent-tools/tool-policy';
import { AGENT_BUILTIN_MCP_TOOL_IDS, AGENT_BUILTIN_TOOL_IDS } from '@mavis/config';
import { isManagedTool, managedSkillToolsDeps, withManagedSkillTools, } from './local-turn-tool-managed-skills.js';
import { mergeAgentHostTurnCapabilities } from './local-turn-plugin-capabilities.js';
import { DELEGATION_TOOL_NAMES, isAgentAuthorityToolAllowed, isTrustedCoordinator, keepsCoordinatorCliTool, shapeCoordinatorTools, } from './local-turn-tool-authority.js';
import { isPtcTurnEnabled, resolvedTurnCatalog } from './local-turn-tool-ptc/index.js';
/** The zero-parameter tool that forwards the conversation to the Session's advisor model. */
export const ADVISOR_TOOL_NAME = 'advisor';
/**
 * Applies only present-turn gates and Agent selectors to ready capability
 * inventories. It intentionally does not create disclosure tools, so a Task
 * capture can freeze the same allowed IDs without owning a second catalog.
 */
export function filterLocalTurnCapabilityInventory(input) {
    const excludedNames = getSuppressedToolNamesForModelCapabilities(input.modelCapabilities);
    const profile = input.agentProfile;
    const selector = createLocalAgentCapabilitySelector(profile?.configSelection, profile?.toolsAllowlistScope);
    const rules = input.sources.catalog;
    const selectorAlias = (tool) => input.hostCapabilityRegistry
        ? rules?.selectorAlias?.(tool, {
            surface: profile?.surface ?? 'interactive',
            ...(input.desktopCapabilities ? { desktopCapabilities: input.desktopCapabilities } : {}),
        })
        : undefined;
    const keep = (tool, source, options = {}) => isReadyTurnToolAllowed({
        tool,
        source,
        options,
        excludedNames,
        cuRuntimeAvailable: input.sources.cuRuntimeAvailable,
        requiresComputerUseRuntime: rules?.requiresComputerUseRuntime,
        delegationAuthority: rules?.delegationAuthority,
        selector,
        profile,
    });
    const nativeTools = filterCanonicalNativeToolCeiling(input.sources.nativeTools.filter((tool) => {
        const alias = selectorAlias(tool);
        return keep(tool, 'builtin', alias ? { selectorAlias: alias } : {});
    }), profile?.canonicalRole, profile?.trustedBuiltin === true);
    // Selected by name like every tool (`isAgentSelectorMcpToolName`), with no
    // role-specific MCP filter: explore / verifier get MCP tools on the same
    // terms as other Agents. Matrix tools (no `mcp__` prefix) are ordinary tools,
    // still limited by `tools` and the `builtinTools` / `features` ceiling.
    const mcpEntries = input.sources.mcpEntries.filter(({ tool, source, serverName }) => keep(tool, source, serverName ? { serverName } : {}));
    const threadGoalTools = resolveThreadGoalTools(profile, input.sources.threadGoalTools.filter((tool) => keep(tool, 'builtin')));
    const desktopCapabilities = input.desktopCapabilities
        ? filterDesktopCapabilities(input.desktopCapabilities, keep)
        : undefined;
    return {
        selector,
        nativeTools,
        mcpEntries,
        threadGoalTools,
        ...(desktopCapabilities ? { desktopCapabilities } : {}),
        ...selectorSummaryFor({
            profile,
            selector,
            raw: [...input.sources.mcpEntries, ...desktopToolServers(input.desktopCapabilities)],
            kept: [...mcpEntries.map(({ tool }) => tool), ...(desktopCapabilities?.runtimeTools ?? [])],
            rawPluginTools: input.desktopCapabilities?.runtimeTools ?? [],
        }),
    };
}
function selectorSummaryFor(input) {
    const allowlist = input.profile?.configSelection?.tools;
    if (allowlist === undefined)
        return {};
    const kept = new Set(input.kept);
    const mcpTools = input.raw.filter(({ tool }) => isAgentSelectorMcpToolName(tool.def.name));
    const counts = {
        mcpKept: 0,
        mcpBlockedByServerSelector: 0,
        mcpBlockedByDisallowed: 0,
        mcpBlockedByToolsAllowlist: 0,
    };
    for (const entry of mcpTools) {
        const outcome = kept.has(entry.tool) ? 'mcpKept' : mcpBlockReason(input.selector, entry);
        if (outcome)
            counts[outcome] += 1;
    }
    const pluginApps = input.rawPluginTools.filter((tool) => !isAgentSelectorMcpToolName(tool.def.name));
    return {
        selectorSummary: {
            toolsAllowlistSize: new Set(allowlist.map(normalizedSelectorName).filter(Boolean)).size,
            toolsAllowlistScope: input.profile?.toolsAllowlistScope ?? resolveToolsAllowlistScope(allowlist),
            ...(input.profile?.configSelection?.frozenSelectorVersion === undefined
                ? {}
                : { frozenSelectorVersion: input.profile.configSelection.frozenSelectorVersion }),
            mcpTotal: mcpTools.length,
            ...counts,
            pluginAppTotal: pluginApps.length,
            pluginAppKept: pluginApps.filter((tool) => kept.has(tool)).length,
        },
    };
}
/** The selector that removed an MCP tool; undefined when a model, ceiling or surface gate did. */
function mcpBlockReason(selector, { tool, serverName }) {
    // `featureOwned` skips only the `tools` allowlist: this is `disallowedTools` alone.
    if (!selector.allowsTool(tool.def.name, undefined, { featureOwned: true }))
        return 'mcpBlockedByDisallowed';
    if (!selector.allowsTool(tool.def.name))
        return 'mcpBlockedByToolsAllowlist';
    if (!selector.allowsMcpServer(serverName))
        return 'mcpBlockedByServerSelector';
    return undefined;
}
/** Plugin tools with the MCP server only an MCP binding can prove. */
function desktopToolServers(capabilities) {
    if (!capabilities)
        return [];
    const bindings = new Map(capabilities.runtimeToolBindings.map((binding) => [binding.tool, binding]));
    return capabilities.runtimeTools.map((tool) => {
        const binding = bindings.get(tool);
        return binding?.kind === 'mcp' ? { tool, serverName: binding.source } : { tool };
    });
}
/**
 * V2-owned final catalog policy used by the local AgentRuntime extension.
 * Product domains provide raw tools only; model gates, MCP disclosure and the
 * prompt hint are decided here from the frozen turn/model facts.
 */
/**
 * Re-derives the conversation's receipts from the Turn's own history, so a
 * restarted process opens the gate for the Skills the model still holds. A
 * Turn assembled without history carries nothing to restore.
 *
 * A Turn with no gated tool reads no receipt at all, so it writes none either:
 * a Host whose catalog holds no on-demand namespaced tool — the cloud harness
 * server — shares one process-wide store across every session, and restoring
 * unconditionally grew it for a gate that never runs.
 */
function restoreTurnSkillReceipts(input, nativeTools) {
    if (input.history === undefined)
        return;
    if (!nativeTools.some(isManagedTool))
        return;
    restoreManagedSkillReceiptsFromHistory(input.skillReceipts, {
        sessionId: input.sessionId,
        messages: input.history,
        ...(input.logger ? { logger: input.logger } : {}),
    });
}
export function buildLocalTurnToolCatalog(input) {
    const options = resolveMcpDisclosureOptions(input.config, input.env);
    // Decided before disclosure: it picks the call wording and the deferral threshold
    // (PTC Turns keep `thresholdPct`; non-PTC Turns use `deferBudgetTokens`).
    const ptc = isPtcTurnEnabled(input.ptcEnabled === true);
    const excludedNames = getSuppressedToolNamesForModelCapabilities(input.modelCapabilities);
    const inventory = filterLocalTurnCapabilityInventory(input);
    logAgentToolSelectorSummary(input, inventory.selectorSummary);
    const shaped = shapeCoordinatorTools(input.agentProfile, inventory, {
        hostMavisSplit: typeof input.sources.catalog?.ptcMavisTools === 'function',
    });
    const { mcpEntries } = shaped;
    // Before the gate reads the store, which a restart emptied while the
    // conversation still holds the Skill bodies that justify these receipts.
    restoreTurnSkillReceipts(input, shaped.nativeTools);
    // Gated before disclosure, so run_code's trusted set and the mcp_invoke
    // registry both hold the wrapped objects and no path reaches the raw impl.
    const nativeTools = withManagedSkillTools(withoutUnboundAdvisor(shaped.nativeTools, input.advisorBound === true), managedSkillToolsDeps({ ...input, coordinator: isTrustedCoordinator(input.agentProfile) }, ptc));
    const { threadGoalTools } = inventory;
    const model = input.llmModel;
    const tools = [
        ...nativeTools,
        ...mcpEntries.map(({ tool }) => tool),
        ...createInlineHostGateway(input),
        ...threadGoalTools,
    ];
    if (excludedNames.size > 0) {
        input.emitDiagnostic?.('mcp.tools_suppressed_by_model_capability', {
            sessionId: input.sessionId,
            suppressedToolNames: [...excludedNames],
            supportImage: input.modelCapabilities?.support_image === true,
            supportVideo: input.modelCapabilities?.support_video === true,
        });
    }
    const desktopCapabilities = inventory.desktopCapabilities;
    const toolSearch = toolSearchTurnWiring(input, options, ptc);
    const merged = mergeAgentHostTurnCapabilities({
        tools,
        mcpEntries,
        model,
        options,
        effectivePluginSkills: input.effectivePluginSkills ?? [],
        surface: input.agentProfile?.surface ?? 'interactive',
        ...(input.hostCapabilityRegistry
            ? { hostCapabilityRegistry: input.hostCapabilityRegistry }
            : {}),
        ...(input.userText !== undefined ? { userText: input.userText } : {}),
        ...(desktopCapabilities ? { capabilities: desktopCapabilities } : {}),
        ...(ptc ? { ptc: true } : {}),
        metricsClient: input.metricsClient,
        ...toolSearch.mergeInput,
    });
    toolSearch.settle(merged, model);
    // When a Plugin declares an App, Attribution wraps bash (App calls go through
    // it); the wrapper runs the same native implementation, so it is the native
    // tool run_code lists and must keep its builtin evidence and data type.
    const trustedNativeTools = merged.attributed
        ? nativeTools.map((tool) => merged.attributed?.get(tool) ?? tool)
        : nativeTools;
    const rules = input.sources.catalog;
    const catalog = resolvedTurnCatalog(merged.tools, ptc, {
        trustedNativeTools,
        input,
        coordinator: isTrustedCoordinator(input.agentProfile),
        rules,
        gates: {
            isSaveScriptAllowedByTurn: (candidate) => isReadyTurnToolAllowed({
                tool: candidate,
                source: 'builtin',
                options: {},
                excludedNames,
                cuRuntimeAvailable: input.sources.cuRuntimeAvailable,
                requiresComputerUseRuntime: rules?.requiresComputerUseRuntime,
                delegationAuthority: rules?.delegationAuthority,
                selector: inventory.selector,
                profile: input.agentProfile,
            }),
        },
    });
    return {
        tools: catalog.tools,
        gatedNativeTools: nativeTools,
        userPromptPrefix: renderUserPromptPrefix([
            merged.reminder,
            catalog.reminder,
            ...hostPromptBlocks(input.promptBlocks, catalog),
            // Tool changes within the prefix window: announced here, appended to history.
            input.commitWindow === false
                ? undefined
                : readToolSearchTurnFacts(merged.tools)?.windowUpdate,
        ]
            .filter(Boolean)
            .join('\n\n'), merged.plan, options, { ptc, builtinToolNames: deferredBuiltinToolNames(merged.plan) }),
    };
}
function hostPromptBlocks(promptBlocks, catalog) {
    return promptBlocks?.({ tools: catalog.tools, childTools: catalog.childTools }) ?? [];
}
/** Native tools that load on demand and survived this Turn's capability filters. */
function deferredBuiltinToolNames(plan) {
    if (!plan.deferred)
        return [];
    return [...plan.deferredRegistry.values()]
        .filter((tool) => tool.def.loading === 'on_demand' && tool.source === undefined)
        .map((tool) => tool.def.name);
}
/**
 * Joins the plugin reminder with the MCP tool-search hint when it applies. On
 * a PTC Turn the hint names the run_code call form, because there the hidden
 * tools are run_code children and mcp_invoke does not route them. The hint
 * names this Turn's on-demand built-ins so the model knows they exist.
 *
 * `tool_search` stays registered for a stable tool list, but with an empty
 * index every search misses, so the hint would only invite those wasted calls;
 * the catalog, inserted into every request, announces deferred tools instead of the per-turn hint.
 */
function renderUserPromptPrefix(reminder, plan, options, hintOptions) {
    const hint = options.systemHint && plan.deferred && plan.deferredRegistry.size > 0 && !options.catalog;
    return [reminder, hint ? renderMcpToolSearchHintBlock(hintOptions) : '']
        .filter(Boolean)
        .join('\n\n');
}
/**
 * One line per catalog build for an Agent with a `tools` allowlist, so a
 * Session can show whether its MCP tools (`isAgentSelectorMcpToolName`)
 * reached the model and which selector removed the rest. Counts only: no tool
 * names or arguments.
 */
function logAgentToolSelectorSummary(input, summary) {
    if (!summary)
        return;
    const profile = input.agentProfile;
    try {
        input.logger?.info?.({
            event: 'agent_tool_selector_summary',
            session_id: input.sessionId,
            ...(input.turnId ? { turn_id: input.turnId } : {}),
            ...(input.agentName ? { agent_name: input.agentName } : {}),
            ...(profile?.canonicalRole ? { canonical_role: profile.canonicalRole } : {}),
            trusted_builtin: profile?.trustedBuiltin === true,
            surface: profile?.surface ?? 'interactive',
            tools_allowlist_size: summary.toolsAllowlistSize,
            tools_allowlist_scope: summary.toolsAllowlistScope,
            ...(summary.frozenSelectorVersion === undefined
                ? {}
                : { frozen_selector_version: summary.frozenSelectorVersion }),
            mcp_total: summary.mcpTotal,
            mcp_kept: summary.mcpKept,
            mcp_blocked_by_server_selector: summary.mcpBlockedByServerSelector,
            mcp_blocked_by_disallowed: summary.mcpBlockedByDisallowed,
            mcp_blocked_by_tools_allowlist: summary.mcpBlockedByToolsAllowlist,
            plugin_app_total: summary.pluginAppTotal,
            plugin_app_kept: summary.pluginAppKept,
        }, '[local-runtime-v2] agent tool selector summary');
    }
    catch {
        // Diagnostics must not affect the Turn.
    }
}
function createInlineHostGateway(input) {
    return reservesInlineGateway(input) ? [createMcpInvokeTool(new Map())] : [];
}
/** Preserve Desktop's gateway; CLI and its children add it only for real refs/deferred tools. */
function reservesInlineGateway(input) {
    if (input.hostCapabilityRegistry === undefined)
        return false;
    // A coordinator lists one tool catalog on Desktop and TUI (Bunny P0 section 6): the
    // CLI keeps its gateway, and an unroutable call answers with mcp_invoke's own error.
    if (isTrustedCoordinator(input.agentProfile))
        return true;
    return input.hostCapabilityRegistry.reserveInlineGateway !== false;
}
function isReadyTurnToolAllowed(input) {
    if (!isAgentAuthorityToolAllowed(input.profile, input.tool.def.name, input.source, input.delegationAuthority))
        return false;
    if (input.excludedNames.has(input.tool.def.name))
        return false;
    if (!isComputerToolAvailable(input))
        return false;
    if (!input.selector.allowsTool(input.tool.def.name, input.options.selectorAlias, {
        featureOwned: isAllowlistExempt(input.profile, input.tool.def.name, input.source),
        pluginTool: input.options.pluginTool === true,
    }))
        return false;
    if (!isMcpServerAllowed(input.selector, input.tool.def.name, input.options.serverName))
        return false;
    if (!input.profile)
        return true;
    return isProfileToolAllowed(input.profile, input.tool, input.source);
}
/**
 * Builtin `web_search` (native or Matrix) is owned by `features.webSearch` on a
 * trusted builtin role, whose `agent.md` `tools` can only name native tools.
 * Custom and Plugin Agents may name `web_search` in `tools`, so their
 * allowlist still decides it.
 */
function isFeatureOwnedBuiltinTool(profile, name, source) {
    return (profile?.trustedBuiltin === true &&
        name === 'web_search' &&
        (source === 'builtin' || source === 'builtin-matrix'));
}
/**
 * The advisor is the user's choice for the conversation: on any surface but a task child, an
 * Agent's `tools` allowlist and its capability tools do not drop it (`disallowedTools` still
 * does). A task child gets it only when its own definition names it.
 */
function isUserSelectedBuiltinTool(profile, name, source) {
    return name === ADVISOR_TOOL_NAME && source === 'builtin' && profile?.surface !== 'task-child';
}
/** Tools an Agent's `tools` allowlist cannot name away; only `disallowedTools` applies to them. */
function isAllowlistExempt(profile, name, source) {
    return (isFeatureOwnedBuiltinTool(profile, name, source) ||
        isUserSelectedBuiltinTool(profile, name, source));
}
function isComputerToolAvailable(input) {
    return input.cuRuntimeAvailable || input.requiresComputerUseRuntime?.(input.tool) !== true;
}
/** `mcpServers` applies to MCP tools only; without a server it fails closed. */
function isMcpServerAllowed(selector, name, serverName) {
    return !isAgentSelectorMcpToolName(name) || selector.allowsMcpServer(serverName);
}
function isProfileToolAllowed(profile, tool, source) {
    if (profile.surface === 'task-child' && TASK_CHILD_BLOCKED_TOOL_NAMES.has(tool.def.name)) {
        return false;
    }
    if (profile.surface === 'task-child' &&
        TASK_CHILD_EXPLICIT_TOOL_NAMES.has(tool.def.name) &&
        !selectsToolExplicitly(profile.configSelection, tool.def.name)) {
        return false;
    }
    if (isBuiltinSubagentTaskChild(profile) && MAVIS_CAPABILITY_TOOL_NAMES.includes(tool.def.name))
        return false;
    if (keepsCoordinatorCliTool(profile, tool.def.name))
        return true;
    if (isUserSelectedBuiltinTool(profile, tool.def.name, source))
        return true;
    return isProfileCapabilityEnabled(profile.capabilityCeiling, tool.def.name, source);
}
/**
 * The one rule for an Agent's `tools`, `disallowedTools` and `mcpServers`,
 * the same for builtin, Custom and Plugin Agents and for every role (README
 * "Desktop Local Agent 定义"). A tool is an MCP tool when its name starts with
 * `mcp__`, whatever its source or Agent role.
 * - `disallowedTools` removes any tool it names.
 * - An MCP tool (user MCP, Plugin MCP, a builtin server with `mcp__` names)
 *   must belong to a server named by `mcpServers` when the Agent has one.
 * - A Plugin App tool (a Plugin tool without an `mcp__` name) is not limited
 *   by `tools`: Plugin tools are outside the native allowlist.
 * - Any other tool (native, Matrix such as `web_search`, thread goal) must be
 *   named by `tools` when the Agent has one.
 * - A `tools` list that names an `mcp__*` tool limits every tool, MCP and
 *   Plugin tools included (`resolveToolsAllowlistScope`).
 * Capability ceilings, the native role ceiling and surface gates apply on top.
 */
export function isAgentSelectorMcpToolName(name) {
    return normalizedSelectorName(name).startsWith('mcp__');
}
/**
 * A `tools` list that names no MCP tool is a native list and limits neither
 * MCP tools (`isAgentSelectorMcpToolName`) nor Plugin tools; this is how builtin worker /
 * explore / verifier `agent.md` lists read. A list that names an `mcp__*`
 * tool keeps limiting every tool: its author picked MCP tools one by one
 * (compatible Plugin Agents, Task snapshots that froze concrete MCP names),
 * and dropping that limit would widen what they chose.
 */
export function resolveToolsAllowlistScope(tools) {
    return tools?.some(isAgentSelectorMcpToolName) ? 'all' : 'native';
}
export function createLocalAgentCapabilitySelector(selection, toolsAllowlistScope) {
    const allowedTools = normalizeSelector(selection?.tools);
    const allowlistIsNative = (toolsAllowlistScope ?? resolveToolsAllowlistScope(selection?.tools)) === 'native';
    const skipsAllowlist = (name, options) => options?.featureOwned === true ||
        (allowlistIsNative && (options?.pluginTool === true || isAgentSelectorMcpToolName(name)));
    const blockedTools = normalizeSelector(selection?.disallowedTools) ?? new Set();
    const allowedMcpServers = normalizeSelector(selection?.mcpServers);
    // A namespaced tool runs only after its Skill was read, and `skill` is the one
    // tool that reads one. An Agent whose `tools` allowlist admits a namespaced
    // tool but not `skill` holds tools that answer `SKILL_REQUIRED` for ever, so
    // the allowlist admits `skill` together with them — the same `mavis` alias a
    // namespaced tool itself is admitted by. `disallowedTools` still removes it,
    // and an allowlist that grants no namespaced tool is untouched.
    const grantsNamespacedTool = allowedTools !== undefined &&
        BUILTIN_NAMESPACED_TOOL_NAMES.some((toolName) => [toolName, ...(MAVIS_CAPABILITY_TOOL_NAMES.includes(toolName) ? ['mavis'] : [])].some((candidate) => allowedTools.has(normalizedSelectorName(candidate))));
    return {
        allowsTool(name, hostAlias, options) {
            const names = [
                name,
                ...(name !== 'mavis' && MAVIS_CAPABILITY_TOOL_NAMES.includes(name) ? ['mavis'] : []),
                ...(hostAlias ? [hostAlias] : []),
            ].map(normalizedSelectorName);
            return (!names.some((candidate) => blockedTools.has(candidate)) &&
                (skipsAllowlist(name, options) ||
                    (name === 'skill' && grantsNamespacedTool) ||
                    !allowedTools ||
                    names.some((candidate) => allowedTools.has(candidate))));
        },
        allowsMcpServer(serverName) {
            if (!allowedMcpServers)
                return true;
            return serverName ? allowedMcpServers.has(normalizedSelectorName(serverName)) : false;
        },
    };
}
function normalizeSelector(values) {
    return values === undefined
        ? undefined
        : new Set(values.map(normalizedSelectorName).filter(Boolean));
}
function normalizedSelectorName(value) {
    return value.trim().normalize('NFKC').toLocaleLowerCase('en-US');
}
function filterDesktopCapabilities(capabilities, keep) {
    if (!capabilities)
        return undefined;
    // Plugin tools are outside a native `tools` list (`isAgentSelectorMcpToolName`):
    // App tools follow `disallowedTools` only, and `mcp__*` tools follow
    // `mcpServers` like every MCP tool, whose server only an MCP binding can prove.
    const bindings = capabilities.runtimeToolBindings.filter((binding) => keep(binding.tool, 'configured', {
        pluginTool: true,
        ...(binding.kind === 'mcp' ? { serverName: binding.source } : {}),
    }));
    const allowedBindingTools = new Set(bindings.map((binding) => binding.tool));
    const allBindingTools = new Set(capabilities.runtimeToolBindings.map((binding) => binding.tool));
    return {
        ...capabilities,
        runtimeToolBindings: bindings,
        runtimeTools: capabilities.runtimeTools.filter((tool) => {
            if (allBindingTools.has(tool))
                return allowedBindingTools.has(tool);
            // Older/third-party capability providers can expose a direct RuntimeTool
            // without an owner binding. Keep that existing inventory under normal
            // gates. Without server provenance, an `mcp__*` tool cannot be proven to
            // belong to an allowed server, so a declared `mcpServers` fails it closed
            // (`isMcpServerAllowed`).
            return keep(tool, 'configured', { pluginTool: true });
        }),
    };
}
/**
 * SessionSend is a sub-command of the composite `mavis` Tool, so it cannot be
 * removed from the catalog on its own. A builtin SubAgent running as a task
 * child therefore loses the whole `mavis` Tool. The Agent profile resolver
 * already forces `features.mavis` off for this surface; repeating the rule on
 * the final catalog keeps it fail closed if raw sources or assembly order ever
 * change. Custom Agents and direct/root builtin Sessions are untouched.
 */
function isBuiltinSubagentTaskChild(profile) {
    return (profile.surface === 'task-child' &&
        isCanonicalBuiltinTurn(profile.canonicalRole, profile.trustedBuiltin));
}
/** Thread goal tools are withheld from task children and canonical builtin turns. */
function resolveThreadGoalTools(profile, threadGoalTools) {
    if (profile?.surface === 'task-child')
        return [];
    if (isCanonicalBuiltinTurn(profile?.canonicalRole, profile?.trustedBuiltin))
        return [];
    return threadGoalTools;
}
const TASK_CHILD_BLOCKED_TOOL_NAMES = new Set([...DELEGATION_TOOL_NAMES, 'todowrite', 'ask_user']);
/**
 * A task child gets these only when its own Agent definition names them in `tools`; an Agent
 * without a `tools` list does not. The other capability gates still apply on top.
 */
const TASK_CHILD_EXPLICIT_TOOL_NAMES = new Set([ADVISOR_TOOL_NAME]);
const BUILTIN_NATIVE_TOOL_NAMES = new Set(AGENT_BUILTIN_TOOL_IDS);
const BUILTIN_MCP_TOOL_NAMES = new Set(AGENT_BUILTIN_MCP_TOOL_IDS);
function selectsToolExplicitly(selection, name) {
    const target = normalizedSelectorName(name);
    return selection?.tools?.some((entry) => normalizedSelectorName(entry) === target) === true;
}
/**
 * The advisor tool is in the raw inventory of every Turn so Task capture can freeze it, but a
 * Turn offers it only when its preparation bound an advisor model.
 */
function withoutUnboundAdvisor(tools, advisorBound) {
    if (advisorBound)
        return tools;
    return tools.filter((tool) => tool.def.name !== ADVISOR_TOOL_NAME);
}
/**
 * Whether a builtin native tool with this name passes the same Agent and surface gates
 * `filterLocalTurnCapabilityInventory` applies to the Turn's inventory. Preparation uses it to
 * decide, before assembly, whether this Turn will offer the tool.
 */
export function isLocalTurnBuiltinToolAllowed(name, agentProfile) {
    const probe = {
        // Only the name and source are gated; the probe never reaches a model or runs.
        def: { name, description: '', schema: {} },
        impl: {
            execute: () => Promise.reject(new Error('Capability probe tools are never executed.')),
        },
        source: 'builtin',
    };
    return (filterLocalTurnCapabilityInventory({
        sources: {
            nativeTools: [probe],
            mcpEntries: [],
            threadGoalTools: [],
            cuRuntimeAvailable: false,
        },
        ...(agentProfile ? { agentProfile } : {}),
    }).nativeTools.length > 0);
}
function isProfileCapabilityEnabled(ceiling, toolName, source) {
    if (!isFeatureEnabled(ceiling, toolName))
        return false;
    if (source === 'builtin' && ceiling.tools && BUILTIN_NATIVE_TOOL_NAMES.has(toolName)) {
        return ceiling.tools.includes(toolName);
    }
    if (source === 'builtin-matrix' && ceiling.builtinTools && BUILTIN_MCP_TOOL_NAMES.has(toolName)) {
        return ceiling.builtinTools.includes(toolName);
    }
    return true;
}
function isFeatureEnabled(ceiling, toolName) {
    if (MAVIS_CAPABILITY_TOOL_NAMES.includes(toolName))
        return ceiling.features.mavis;
    if (DELEGATION_TOOL_NAMES.has(toolName))
        return ceiling.features.delegation;
    if (toolName === 'web_search')
        return ceiling.features.webSearch;
    return true;
}
//# sourceMappingURL=local-turn-tool-catalog.js.map