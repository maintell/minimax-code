import { CRON_TOOL_NAMES, createLocalBashToolDefinition, resolveLocalBashShell, applyToolLoading, filterCanonicalBuiltinMcpEntries, filterCanonicalNativeToolCeiling, createMcpInvokeTool, createToolSearchTool, getSuppressedToolNamesForModelCapabilities, isCanonicalBuiltinTurn, modelInWhitelist, planMcpDisclosure, renderMcpToolSearchHintBlock, } from '@mavis/agent-tools';
import { AGENT_BUILTIN_MCP_TOOL_IDS, AGENT_BUILTIN_TOOL_IDS } from '@mavis/config';
import { mergeAgentHostTurnCapabilities } from './local-turn-plugin-capabilities.js';
export function prepareBashTurnTools(admittedTools, background, nativeDelete = false, agentShell) {
    const hasNativeBash = admittedTools.some((tool) => tool.def.name === 'bash' && (tool.source === undefined || tool.source === 'builtin'));
    const unboundShell = process.platform === 'win32' ? 'unavailable' : undefined;
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
    const selector = createLocalAgentCapabilitySelector(profile?.configSelection);
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
    const mcpEntries = filterCanonicalBuiltinMcpEntries(input.sources.mcpEntries.filter(({ tool, source, serverName }) => keep(tool, source, { mcp: true, ...(serverName ? { serverName } : {}) })), profile?.canonicalRole, profile?.trustedBuiltin);
    const threadGoalTools = resolveThreadGoalTools(profile, input.sources.threadGoalTools.filter((tool) => keep(tool, 'builtin')));
    return {
        selector,
        nativeTools,
        mcpEntries,
        threadGoalTools,
        ...(input.desktopCapabilities
            ? {
                desktopCapabilities: filterDesktopCapabilities(input.desktopCapabilities, keep, profile?.configSelection?.mcpServers !== undefined),
            }
            : {}),
    };
}
/**
 * V2-owned final catalog policy used by the local AgentRuntime extension.
 * Product domains provide raw tools only; model gates, MCP disclosure and the
 * prompt hint are decided here from the frozen turn/model facts.
 */
export function buildLocalTurnToolCatalog(input) {
    const options = resolveLocalMcpDisclosureOptions(input.config, input.env);
    const excludedNames = getSuppressedToolNamesForModelCapabilities(input.modelCapabilities);
    const inventory = filterLocalTurnCapabilityInventory(input);
    const { nativeTools, mcpEntries, threadGoalTools } = inventory;
    const model = input.llmModel;
    const plan = planMcpDisclosure({
        entries: mcpEntries,
        model,
        options,
    });
    const tools = plan.deferred
        ? [
            ...nativeTools,
            ...plan.inlineTools,
            createToolSearchTool(plan.index, {
                topKDefault: options.topKDefault,
                topKMax: options.topKMax,
            }),
            createMcpInvokeTool(plan.deferredRegistry),
            ...threadGoalTools,
        ]
        : [
            ...nativeTools,
            ...plan.inlineTools,
            ...(input.hostCapabilityRegistry ? [createMcpInvokeTool(new Map())] : []),
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
    const effectivePluginSkills = filterExtensionSkills(input.effectivePluginSkills ?? [], inventory.selector);
    const merged = mergeAgentHostTurnCapabilities({
        tools,
        plan,
        model,
        options,
        effectivePluginSkills,
        surface: input.agentProfile?.surface ?? 'interactive',
        ...(input.hostCapabilityRegistry
            ? { hostCapabilityRegistry: input.hostCapabilityRegistry }
            : {}),
        ...(input.userText !== undefined ? { userText: input.userText } : {}),
        ...(desktopCapabilities ? { capabilities: desktopCapabilities } : {}),
    });
    input.emitDiagnostic?.('mcp.tools_deferred', {
        sessionId: input.sessionId,
        deferred: merged.plan.deferred,
        whitelisted: modelInWhitelist(model.provider, model.id, options.modelWhitelist),
        model: `${model.provider}/${model.id}`,
        ...(merged.plan.deferred ? merged.plan.stats : {}),
    });
    return {
        tools: applyToolLoading(merged.tools),
        userPromptPrefix: renderUserPromptPrefix([merged.reminder, renderComputerUseHint(merged.tools)].filter(Boolean).join('\n\n'), merged.plan.deferred, options.systemHint),
    };
}
function isReadyTurnToolAllowed(input) {
    if (input.excludedNames.has(input.tool.def.name))
        return false;
    if (!isComputerToolAvailable(input.tool, input.cuRuntimeAvailable))
        return false;
    if (!input.selector.allowsTool(input.tool.def.name, input.options.selectorAlias))
        return false;
    if (!isMcpServerAllowed(input.selector, input.options))
        return false;
    if ((DELEGATION_TOOL_NAMES.has(input.tool.def.name) ||
        (input.source !== 'builtin' && TASK_CONTROL_TOOL_NAMES.has(input.tool.def.name))) &&
        !isAuthoritativeMainProfile(input.profile)) {
        return false;
    }
    if (!input.profile)
        return true;
    return isProfileToolAllowed(input.profile, input.tool, input.source);
}
function isComputerToolAvailable(tool, cuRuntimeAvailable) {
    return cuRuntimeAvailable || !tool.def.name.startsWith('computer_');
}
function isMcpServerAllowed(selector, options) {
    if (!options.mcp)
        return true;
    return selector.allowsMcpServer(options.serverName);
}
function isProfileToolAllowed(profile, tool, source) {
    if (profile.surface === 'task-child' && TASK_CHILD_BLOCKED_TOOL_NAMES.has(tool.def.name)) {
        return false;
    }
    if (isBuiltinSubagentTaskChild(profile) && ['mavis', ...CRON_TOOL_NAMES].includes(tool.def.name))
        return false;
    return isProfileCapabilityEnabled(profile.capabilityCeiling, tool.def.name, source);
}
/**
 * Task operations are an owner-only authority. These facts are frozen from the
 * trusted Agent profile while assembling the Turn, rather than from a mutable
 * display name or a product capability flag.
 */
function isAuthoritativeMainProfile(profile) {
    return ((profile?.surface === 'interactive' || profile?.surface === 'cli') &&
        profile.trustedBuiltin === true &&
        profile.canonicalRole === 'mavis');
}
export function createLocalAgentCapabilitySelector(selection) {
    const allowedTools = normalizeSelector(selection?.tools);
    const blockedTools = normalizeSelector(selection?.disallowedTools) ?? new Set();
    const allowedMcpServers = normalizeSelector(selection?.mcpServers);
    const allowedSkills = normalizeSelector(selection?.skills);
    const allowedExtensionSkills = normalizeSelector(selection?.extensionSkills);
    return {
        allowsTool(name, hostAlias) {
            const names = [
                name,
                ...(CRON_TOOL_NAMES.includes(name) ? ['mavis'] : []),
                ...(hostAlias ? [hostAlias] : []),
            ].map(normalizedSelectorName);
            return (!names.some((candidate) => blockedTools.has(candidate)) &&
                (!allowedTools || names.some((candidate) => allowedTools.has(candidate))));
        },
        allowsMcpServer(serverName) {
            if (!allowedMcpServers)
                return true;
            return serverName ? allowedMcpServers.has(normalizedSelectorName(serverName)) : false;
        },
        allowsSkill(name) {
            return !allowedSkills || allowedSkills.has(normalizedSelectorName(name));
        },
        allowsExtensionSkill(pluginName, name) {
            if (!allowedExtensionSkills)
                return true;
            const normalizedName = normalizedSelectorName(name);
            return (allowedExtensionSkills.has(normalizedName) ||
                allowedExtensionSkills.has(`${normalizedSelectorName(pluginName)}:${normalizedName}`));
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
function filterDesktopCapabilities(capabilities, keep, requireMcpServerProvenance) {
    if (!capabilities)
        return undefined;
    const bindings = capabilities.runtimeToolBindings.filter((binding) => keep(binding.tool, 'configured', {
        ...(binding.kind === 'mcp' ? { mcp: true, serverName: binding.source } : {}),
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
            // gates. A declared MCP server selector is different: without server
            // provenance we cannot prove that an `mcp__*` tool belongs to an allowed
            // server, so fail closed only for that narrow ambiguous case.
            if (requireMcpServerProvenance && isMcpRuntimeTool(tool))
                return false;
            return keep(tool, 'configured');
        }),
    };
}
function isMcpRuntimeTool(tool) {
    return normalizedSelectorName(tool.def.name).startsWith('mcp__');
}
function filterExtensionSkills(skills, selector) {
    return skills.filter((skill) => selector.allowsExtensionSkill(skill.pluginName, skill.name));
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
/** Repeated per active turn so task continuation does not depend on historical tool lists. */
function renderComputerUseHint(tools) {
    if (!tools.some((tool) => tool.def.name.startsWith('computer_')))
        return undefined;
    return [
        '<system-reminder>',
        'Computer Use is enabled for this task. Use only the current computer_* tool schemas.',
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
/** Joins the plugin reminder with the MCP tool-search hint when both apply. */
function renderUserPromptPrefix(reminder, deferred, systemHint) {
    return [reminder, deferred && systemHint ? renderMcpToolSearchHintBlock() : '']
        .filter(Boolean)
        .join('\n\n');
}
const TASK_CONTROL_TOOL_NAMES = new Set(['task_query', 'task_output', 'task_stop']);
const DELEGATION_TOOL_NAMES = new Set(['task', 'task_append']);
const TASK_CHILD_BLOCKED_TOOL_NAMES = new Set([...DELEGATION_TOOL_NAMES, 'todowrite', 'ask_user']);
const BUILTIN_NATIVE_TOOL_NAMES = new Set(AGENT_BUILTIN_TOOL_IDS);
const BUILTIN_MCP_TOOL_NAMES = new Set(AGENT_BUILTIN_MCP_TOOL_IDS);
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
    if (['mavis', ...CRON_TOOL_NAMES].includes(toolName))
        return ceiling.features.mavis;
    if (DELEGATION_TOOL_NAMES.has(toolName))
        return ceiling.features.delegation;
    if (toolName === 'web_search')
        return ceiling.features.webSearch;
    return true;
}
export function resolveLocalMcpDisclosureOptions(raw, env = process.env) {
    return {
        enabled: resolveOption(env.MAVIS_MCP_TOOL_SEARCH_ENABLED, raw?.enabled, true, parseBoolean),
        modelWhitelist: resolveModelWhitelist(env.MAVIS_MCP_TOOL_SEARCH_WHITELIST, raw),
        thresholdPct: resolveOption(env.MAVIS_MCP_TOOL_SEARCH_THRESHOLD_PCT, raw?.thresholdPct, 0.15, parseNumber),
        minDeferCount: resolveOption(env.MAVIS_MCP_TOOL_SEARCH_MIN_DEFER_COUNT, raw?.minDeferCount, 1, parseNumber),
        topKDefault: resolveOption(env.MAVIS_MCP_TOOL_SEARCH_TOP_K_DEFAULT, raw?.topKDefault, 5, parseNumber),
        topKMax: resolveOption(env.MAVIS_MCP_TOOL_SEARCH_TOP_K_MAX, raw?.topKMax, 20, parseNumber),
        systemHint: resolveOption(env.MAVIS_MCP_TOOL_SEARCH_SYSTEM_HINT, raw?.systemHint, true, parseBoolean),
        maxSchemaTextLen: resolveOption(env.MAVIS_MCP_TOOL_SEARCH_MAX_SCHEMA_TEXT_LEN, raw?.maxSchemaTextLen, 4_096, parseNumber),
    };
}
function resolveOption(envValue, configured, fallback, parse) {
    return parse(envValue) ?? configured ?? fallback;
}
function resolveModelWhitelist(envValue, raw) {
    const parsed = parseStringList(envValue);
    if (parsed)
        return parsed;
    return raw?.modelWhitelist ? [...raw.modelWhitelist] : [];
}
function parseBoolean(value) {
    const normalized = value?.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1')
        return true;
    if (normalized === 'false' || normalized === '0')
        return false;
    return undefined;
}
function parseNumber(value) {
    if (!value?.trim())
        return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
}
function parseStringList(value) {
    const entries = value
        ?.split(',')
        .map((entry) => entry.trim())
        .filter(Boolean);
    return entries && entries.length > 0 ? entries : undefined;
}
//# sourceMappingURL=local-turn-tool-catalog.js.map