import { MAVIS_CAPABILITY_TOOL_NAMES, createLocalBashToolDefinition, resolveLocalBashShell, filterCanonicalNativeToolCeiling, createMcpInvokeTool, createPtcMavisTools, getSuppressedToolNamesForModelCapabilities, isCanonicalBuiltinTurn, readToolSearchTurnFacts, renderMcpToolSearchHintBlock, resolveMcpDisclosureOptions, toolSearchTurnWiring, withLocalBrowserObserve, createSavePtcScriptTool, } from '@mavis/agent-tools';
import { AGENT_BUILTIN_MCP_TOOL_IDS, AGENT_BUILTIN_TOOL_IDS, isPtcTurnEnabled as isSharedPtcTurnEnabled, } from '@mavis/config';
import { getBrowserHostBinding } from './host-capability/browser.js';
import { mergeAgentHostTurnCapabilities } from './local-turn-plugin-capabilities.js';
import { DELEGATION_TOOL_NAMES, isAgentAuthorityToolAllowed, isTrustedCoordinator, keepsCoordinatorCliTool, shapeCoordinatorTools, } from './local-turn-tool-authority.js';
import { createPtcRunCodeTool } from '../runner/ptc/run-code-tool.js';
import { isPtcSaveScriptAllowed, ptcScriptSupport } from './local-turn-tool-ptc-scripts.js';
import { registerPtcNativeCatalog, registerPtcTurnReminder } from '../execution/ptc/catalog.js';
import { isPtcChildTool, isPtcDirectTool, logPtcOnDemandTools, splitPtcOnDemandTools, } from '../runner/policy/local-turn-tool-ptc-policy.js';
/** The zero-parameter tool that forwards the conversation to the Session's advisor model. */
export const ADVISOR_TOOL_NAME = 'advisor';
export function prepareBashTurnTools(admittedTools, background, nativeDelete = false, agentShell) {
    const hasNativeBash = admittedTools.some((tool) => tool.def.name === 'bash' && (tool.source === undefined || tool.source === 'builtin'));
    const unboundShell = process.platform === 'win32' ? 'pending' : undefined;
    const sessionShell = agentShell
        ? { 'git-bash': 'bash', 'windows-powershell': 'powershell', pwsh: 'pwsh' }[agentShell.family]
        : unboundShell;
    const bashCapabilities = {
        background,
        shell: hasNativeBash ? (sessionShell ?? resolveLocalBashShell()) : 'unavailable',
        nativeDelete,
    };
    return admittedTools.map((tool) => {
        if (tool.def.name !== 'bash' || (tool.source !== undefined && tool.source !== 'builtin'))
            return tool;
        const definition = createLocalBashToolDefinition(bashCapabilities);
        return {
            ...tool,
            def: { ...tool.def, schema: definition.schema, description: definition.description },
        };
    });
}
/**
 * Applies only present-turn gates and Agent selectors to ready capability
 * inventories. It intentionally does not create disclosure tools, so a Task
 * capture can freeze the same allowed IDs without owning a second catalog.
 */
export function filterLocalTurnCapabilityInventory(input) {
    const excludedNames = getSuppressedToolNamesForModelCapabilities(input.modelCapabilities);
    const profile = input.agentProfile;
    const selector = createLocalAgentCapabilitySelector(profile?.configSelection, profile?.toolsAllowlistScope);
    const hasBrowserHostAlias = Boolean(input.hostCapabilityRegistry &&
        (profile?.surface ?? 'interactive') === 'interactive' &&
        input.desktopCapabilities?.hostBindings?.some((binding) => binding.hostCapability.id === 'browser.use' &&
            binding.hostCapability.version === 1 &&
            binding.allowedSurfaces.includes('interactive')));
    const keep = (tool, source, options = {}) => isReadyTurnToolAllowed({
        tool,
        source,
        options,
        excludedNames,
        cuRuntimeAvailable: input.sources.cuRuntimeAvailable,
        selector,
        profile,
    });
    const nativeTools = filterCanonicalNativeToolCeiling(input.sources.nativeTools.filter((tool) => keep(tool, 'builtin', hasBrowserHostAlias && tool.def.name === 'browser' ? { selectorAlias: 'mcp_browser' } : {})), profile?.canonicalRole, profile?.trustedBuiltin === true);
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
export function buildLocalTurnToolCatalog(input) {
    const options = resolveMcpDisclosureOptions(input.config, input.env);
    // Decided before disclosure: it picks the call wording and the deferral threshold
    // (PTC Turns keep `thresholdPct`; non-PTC Turns use `deferBudgetTokens`).
    const ptc = isPtcTurnEnabled(input);
    const excludedNames = getSuppressedToolNamesForModelCapabilities(input.modelCapabilities);
    const inventory = filterLocalTurnCapabilityInventory(input);
    logAgentToolSelectorSummary(input, inventory.selectorSummary);
    const shaped = shapeCoordinatorTools(input.agentProfile, inventory);
    const { mcpEntries } = shaped;
    const nativeTools = withoutUnboundAdvisor(shaped.nativeTools, input.advisorBound === true);
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
        ...toolSearch.mergeInput,
    });
    toolSearch.settle(merged, model);
    // When a Plugin declares an App, Attribution wraps bash (App calls go through
    // it); the wrapper runs the same native implementation, so it is the native
    // tool run_code lists and must keep its builtin evidence and data type.
    const trustedNativeTools = merged.attributed
        ? nativeTools.map((tool) => merged.attributed?.get(tool) ?? tool)
        : nativeTools;
    const catalog = resolvedTurnCatalog(merged.tools, ptc, {
        trustedNativeTools,
        input,
        gates: {
            excludedNames,
            selector: inventory.selector,
            cuRuntimeAvailable: input.sources.cuRuntimeAvailable,
        },
    });
    return {
        tools: catalog.tools,
        userPromptPrefix: renderUserPromptPrefix([
            merged.reminder,
            catalog.reminder,
            renderComputerUseHint(catalog.tools, catalog.childTools),
            // Tool changes within the prefix window: announced here, appended to history.
            input.commitWindow === false
                ? undefined
                : readToolSearchTurnFacts(merged.tools)?.windowUpdate,
        ]
            .filter(Boolean)
            .join('\n\n'), merged.plan, options, { ptc, builtinToolNames: deferredBuiltinToolNames(merged.plan) }),
    };
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
function resolvedTurnCatalog(tools, ptc, options) {
    return ptc
        ? buildPtcCatalog(tools, options.trustedNativeTools, options.input, options.gates)
        : { tools, reminder: '', childTools: [] };
}
function isPtcTurnEnabled(input) {
    // Same function and the same Session mode as the system prompt's ptc.enabled
    // (agent-profile.ts), so the prompt never promises run_code-only tools on a
    // Turn whose catalog kept them native, or the reverse.
    return isSharedPtcTurnEnabled({ requested: input.ptcEnabled === true });
}
function buildPtcCatalog(tools, trustedNativeTools, input, gates) {
    const onDemand = splitPtcOnDemandTools(tools, reservesInlineGateway(input));
    logPtcOnDemandTools(input, onDemand);
    const observable = withPtcBrowserObserve(onDemand.tools.filter(isPtcChildTool), trustedNativeTools);
    const { childTools, directTools } = withPtcMavisTools(observable.childTools, onDemand.tools.filter(isPtcDirectTool), observable.trustedNativeTools, isTrustedCoordinator(input.agentProfile));
    // The save tool is a run_code child like any other, so it is listed with them
    // and gated like one: the `tools` allowlist, `disallowedTools`, the model's
    // suppressed names, the canonical role ceiling and the Agent authority rules
    // all decide it, because it never passes through the inventory above.
    const scripts = ptcScriptSupport(input);
    const saveTool = scripts ? createSavePtcScriptTool(scripts.save) : undefined;
    // The Agent and model gate is this module's own; ptc-scripts owns the save
    // tool's two-step decision and takes the gate as an argument, so neither
    // module has to import the other.
    const isSaveScriptAllowedByTurn = (candidate) => isReadyTurnToolAllowed({
        tool: candidate,
        source: 'builtin',
        options: {},
        excludedNames: gates.excludedNames,
        cuRuntimeAvailable: gates.cuRuntimeAvailable,
        selector: gates.selector,
        profile: input.agentProfile,
    });
    const listedChildTools = [
        ...childTools,
        ...(saveTool && isPtcSaveScriptAllowed(saveTool, input.agentProfile, isSaveScriptAllowedByTurn)
            ? [saveTool]
            : []),
    ];
    // Name the hidden tools so the model does not spend a turn calling one directly
    // (the pilot lost three turns that way). Catalog order matches the run_code SDK.
    const childToolNames = listedChildTools.map((tool) => tool.def.name);
    const reminder = [
        'PTC is enabled for this turn. Use run_code with await tools.<name>(args) for eligible ordinary tools and explicitly return a JSON result. Keep the visible control tools as direct calls. Do not call run_code from inside run_code.',
        ...(childToolNames.length > 0
            ? [
                `These tools are only callable inside run_code in this turn: ${childToolNames.join(', ')}.`,
            ]
            : []),
    ].join(' ');
    // The same string goes into the user prompt prefix and onto run_code, so the
    // executor can put it back verbatim after compaction drops that user message.
    // The long tail is callable but stays out of this list and the run_code SDK:
    // listing it would put back the definitions Tool Search keeps out.
    const runCode = registerPtcNativeCatalog(registerPtcTurnReminder(createPtcRunCodeTool(listedChildTools, {
        ...(input.writePtcReturnArtifact
            ? { writeReturnArtifact: input.writePtcReturnArtifact }
            : {}),
        ...(input.ptcSessionStore ? { sessionStore: input.ptcSessionStore } : {}),
        ...(scripts ? { scriptRoots: scripts.roots } : {}),
        // A program calling one of these gets "<name> 只能直接调用" instead of "not a function".
        directToolNames: [
            ...directTools.map((tool) => tool.def.name),
            ...(input.appendedDirectToolNames ?? []),
        ],
    }, observable.trustedNativeTools, onDemand.callable), reminder), tools);
    return { tools: [runCode, ...directTools], reminder, childTools: listedChildTools };
}
/**
 * The Desktop mavis tool on a PTC Turn: run_code lists one mavis_* tool per
 * orchestrable command (createPtcMavisTools) in place of one mavis child, so a
 * program reads each command's own arguments, and the top-level mavis keeps
 * only agent create, session send and their help. Without this the same
 * mavis was listed in both places with every command, and a call in the wrong
 * place was refused only after the model had made it. run_code still runs
 * each call as mavis({ command, args }), so permission rules and Plugin hooks
 * keep matching tool `mavis`. Only the trusted native mavis is split; a Turn
 * without it (TUI, PTC off) keeps its catalog byte for byte. A trusted
 * coordinator's split documents its space and project commands on the top
 * level and lists neither session send nor session interrupt.
 */
function withPtcMavisTools(childTools, directTools, trustedNativeTools, coordinator) {
    const trusted = new Set(trustedNativeTools);
    const mavis = directTools.find((tool) => tool.def.name === 'mavis' && trusted.has(tool));
    if (!mavis || !childTools.includes(mavis))
        return { childTools, directTools };
    const split = createPtcMavisTools(mavis, { coordinator });
    return {
        childTools: childTools.flatMap((tool) => (tool === mavis ? split.children : [tool])),
        directTools: directTools.map((tool) => (tool === mavis ? split.direct : tool)),
    };
}
/**
 * Inside run_code the Browser child (native `browser`, or the Plugin-bound
 * `mcp_browser`, whose definition is the same compact one renamed) is the
 * variant that declares `observe` (withLocalBrowserObserve). The run_code SDK,
 * child-call validation and a direct call of the hidden child all read this
 * catalog, so they see the same variant; a Turn without PTC lists the
 * original Browser and keeps its definition byte for byte. The variant takes
 * the original's place in the trusted native list, so its evidence source and
 * data shape stay builtin; the spread keeps the Host Binding of `mcp_browser`.
 */
function withPtcBrowserObserve(childTools, trustedNativeTools) {
    const trusted = new Set(trustedNativeTools);
    const variants = new Map();
    const children = childTools.map((tool) => {
        const browser = (tool.def.name === 'browser' && trusted.has(tool)) ||
            getBrowserHostBinding(tool) !== undefined;
        const def = browser ? withLocalBrowserObserve(tool.def) : undefined;
        if (!def)
            return tool;
        const variant = { ...tool, def };
        variants.set(tool, variant);
        return variant;
    });
    if (variants.size === 0)
        return { childTools, trustedNativeTools };
    return {
        childTools: children,
        trustedNativeTools: trustedNativeTools.map((tool) => variants.get(tool) ?? tool),
    };
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
    if (!isAgentAuthorityToolAllowed(input.profile, input.tool.def.name, input.source))
        return false;
    if (input.excludedNames.has(input.tool.def.name))
        return false;
    if (!isComputerToolAvailable(input.tool, input.cuRuntimeAvailable))
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
function isComputerToolAvailable(tool, cuRuntimeAvailable) {
    return cuRuntimeAvailable || !tool.def.name.startsWith('computer_');
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
    return {
        allowsTool(name, hostAlias, options) {
            const names = [
                name,
                ...(name !== 'mavis' && MAVIS_CAPABILITY_TOOL_NAMES.includes(name) ? ['mavis'] : []),
                ...(hostAlias ? [hostAlias] : []),
            ].map(normalizedSelectorName);
            return (!names.some((candidate) => blockedTools.has(candidate)) &&
                (skipsAllowlist(name, options) ||
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
/**
 * Repeated per active turn so task continuation does not depend on historical tool lists.
 * A PTC Turn lists computer_* only inside run_code, so the hint also follows
 * run_code's children there and names the run_code call form; a Turn that
 * lists computer_* at top level keeps the original wording byte for byte.
 */
function renderComputerUseHint(tools, ptcChildTools) {
    const isComputerUse = (tool) => tool.def.name.startsWith('computer_');
    const topLevel = tools.some(isComputerUse);
    if (!topLevel && !ptcChildTools.some(isComputerUse))
        return undefined;
    return [
        '<system-reminder>',
        topLevel
            ? 'Computer Use is enabled for this task. Use only the current computer_* tool schemas.'
            : 'Computer Use is enabled for this task. Call computer_* tools inside run_code with await tools.computer_<action>(args); use only the current computer_* tool schemas.',
        ...(tools.some((tool) => tool.def.name === 'skill')
            ? [
                'Before desktop operations, load the computer-use:computer-use plugin skill with the skill tool.',
            ]
            : []),
        'Inspect the actual application and window before acting; do not guess app identifiers or shortcuts.',
        'Verify the resulting UI before claiming success. Report actual tool failures without inventing tool aliases.',
        '</system-reminder>',
    ].join('\n');
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