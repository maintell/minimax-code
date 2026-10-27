import { agentShellInstructions } from './agent-shell-context.js';
import { isLegacyMemoryRecallEnabled, isMemoryV2Enabled } from '@mavis/config';
import { isPromptSnapshotInvalidError, PromptSnapshotInvalidError, } from '@mavis/agent-runtime';
import { DEFAULT_RETRY_CONTINUATION_PROMPT, DEFAULT_OUTPUT_REVISION_INSTRUCTION, OUTPUT_REVISION_PROMPT_KEY, RETRY_CONTINUATION_PROMPT_KEY, } from './prompt-templates.js';
import { resolveAgentCapabilities } from '@mavis/config';
import { isLegacyMinimaxProvider, modelConfigForRef, modelRefForModel, savedSessionModel, } from '../../../../model-system/index.js';
import { INSTRUCTIONS_CONTEXT_PREAMBLE } from '../prompt-blocks.js';
import { createLocalStaticPromptReader, } from '../static-prompt-reader.js';
import { resolveTurnModelSelection, turnModelParameters, } from './session-model-selection.js';
import { addRuntimeRules } from './runtime-prompt-rules.js';
import { environmentContextBlock, } from './environment-prompt-composer.js';
import { collectMemoryBlocks, toMemoryPromptSources, } from './memory-prompt-composer.js';
/** Builds one AgentConfig solely from validated Agent/Session facts and narrow capabilities. */
export class LocalAgentConfigBuilder {
    options;
    resolveAgentShell;
    bindAgentShellResolver(resolve) {
        this.resolveAgentShell = resolve;
    }
    staticPrompts;
    nowMs;
    sessionModelRepair;
    taskSessionBindings;
    constructor(options) {
        this.options = options;
        this.staticPrompts =
            options.staticPrompts ?? createLocalStaticPromptReader({ logger: options.logger });
        this.nowMs = options.nowMs ?? (() => Date.now());
        this.sessionModelRepair = options.sessionModelRepair;
        this.taskSessionBindings = options.taskSessionBindings;
    }
    /**
     * Composition binds Session model repair once the SessionSystem exists — the
     * builder is constructed earlier and must not reach for a repository itself.
     */
    bindSessionModelRepair(repair) {
        this.sessionModelRepair = repair;
    }
    bindTaskSessionBindings(bindings) {
        this.taskSessionBindings = bindings;
    }
    async build(input) {
        return (await this.buildPrepared(input)).agentConfig;
    }
    async buildPrepared(input) {
        const agentShell = await this.resolveAgentShell?.(input.session.sessionId);
        const source = this.options.promptSnapshots;
        const promptRead = input.promptRead ?? (source ? { source, snapshot: await source.capture() } : undefined);
        try {
            return await this.buildPreparedForPromptScope(input, promptRead, agentShell);
        }
        catch (error) {
            if (!source || !promptRead || !isPromptSnapshotInvalidError(error))
                throw error;
            const builtinPromptRead = { source, snapshot: await source.captureBuiltin() };
            return this.buildPreparedForPromptScope(input, builtinPromptRead, agentShell);
        }
    }
    async buildPreparedForPromptScope(input, promptRead, agentShell) {
        const outputRevisionInstruction = await readOutputRevisionInstruction(promptRead);
        const retryContinuationPrompt = await readRetryContinuationPrompt(promptRead, input);
        await validateWorkflowPromptScope(promptRead);
        return {
            agentConfig: await this.buildForPromptScope(input, promptRead, agentShell),
            ...(agentShell ? { agentShell } : {}),
            outputRevisionInstruction,
            ...(retryContinuationPrompt ? { retryContinuationPrompt } : {}),
            ...(promptRead ? { promptRead } : {}),
        };
    }
    async buildForPromptScope(input, promptRead, shell) {
        const config = this.options.config();
        const runtimeFacts = resolveAgentRuntimeFacts(input.agent, config);
        const profileAndBinding = await this.renderProfileForTurn({
            ...input,
            ...(promptRead ? { promptRead } : {}),
        });
        const profile = profileAndBinding.profile;
        const turnInput = input;
        const frozenModel = await this.readSavedModel(turnInput, profileAndBinding.binding);
        const frozenSession = sessionWithFrozenModel(turnInput.session, frozenModel);
        // Resolved once per Turn, gated against the current call route, and then
        // reused: no later stage may re-select a model or reach the upstream with
        // one this route rejects.
        // Only a managed legacy alias may repair a frozen binding. Other frozen
        // selections retain their fail-closed behavior when the catalog changes.
        const model = await this.resolveTurnModel(config, turnInput, frozenModel, frozenSession);
        const layers = await loadPromptLayers({
            input: turnInput,
            config,
            runtimeFacts,
            options: this.options,
            staticPrompts: this.staticPrompts,
            nowMs: this.nowMs,
            ...(model.context_window === undefined ? {} : { modelContextWindow: model.context_window }),
            profile,
        });
        const displayName = turnInput.agent.displayName?.trim() || turnInput.agent.agentName;
        let isGitRepository;
        try {
            isGitRepository = await this.options.isGitRepository?.(turnInput.session.workspaceDir);
        }
        catch {
            isGitRepository = undefined;
        }
        let environment = this.options.environment?.();
        if (shell) {
            environment = {
                platform: 'win32',
                osVersion: environment?.osVersion ?? 'Windows',
                shell: `${shell.family} (${shell.executablePath})\n${agentShellInstructions(shell)}`,
            };
        }
        else if (this.resolveAgentShell && environment?.platform === 'win32') {
            environment = {
                ...environment,
                shell: 'pending background discovery. Continue conversation and use non-shell tools without waiting. Do not assume Bash or PowerShell syntax. The first bash call waits for discovery before permissions and returns shell instructions without executing a command. Rewrite the command for that resolved shell in a new tool-call batch before retrying. If discovery fails, non-shell tools remain available.',
            };
        }
        const systemPrompt = buildSystemPrompt({
            config,
            environment,
            isGitRepository,
            modelId: model.model_id,
            agent: turnInput.agent,
            workspaceDir: turnInput.session.workspaceDir,
            sessionType: turnInput.session.sessionType,
            layers,
            overrides: this.options.systemPromptOverrides,
            profile,
        });
        return createAgentConfig({
            input: turnInput,
            model,
            layers,
            displayName,
            systemPrompt: systemPrompt.text,
            contextUsagePromptRanges: systemPrompt.ranges,
            runtimeFacts,
            profile,
        });
    }
    async resolveTurnModel(config, turnInput, frozenModel, frozenSession) {
        const canRepair = turnInput.session.sessionKind !== 'task' ||
            !frozenModel ||
            isLegacyMinimaxProvider(config, frozenModel.providerId);
        let selection = await resolveTurnModelSelection({
            config,
            tuiProductPolicy: this.options.tuiProductPolicy,
            session: frozenSession,
            ...(turnInput.model ? { requested: turnInput.model } : {}),
            ...(!canRepair || !this.sessionModelRepair ? {} : { repair: this.sessionModelRepair }),
            ...(this.options.modelRepairLogger ? { logger: this.options.modelRepairLogger } : {}),
        });
        const acceptedModel = frozenModel?.providerId === selection.providerId && frozenModel.modelId === selection.modelId
            ? frozenModel
            : undefined;
        selection = withFrozenParameters(selection, turnInput.model, acceptedModel);
        return withFrozenSessionModelLimits(modelRefForSelection(config, selection, this.options.implicitCustomProviderThinking === true, usesLegacyFrozenSelection(turnInput.model, acceptedModel)), frozenSession, selection, frozenModel !== undefined && usesSavedModelLimits(turnInput, config, selection.providerId));
    }
    async readSavedModel(input, binding) {
        if (binding?.definition.definitionVersion === 2)
            return binding.definition.model;
        if (input.session.sessionKind === 'task' || input.model || !input.session.effectiveModel)
            return undefined;
        const historical = await this.taskSessionBindings?.readSessionAgentRouting?.(input.session.sessionId);
        const definition = historical?.definition?.definition;
        return savedSessionModel(input.session, definition?.definitionVersion === 2 ? definition.model : undefined);
    }
    async renderProfileForTurn(input) {
        const source = this.options.profile;
        if (!source)
            return {};
        const binding = await this.readOrBackfillTaskBinding(input.session);
        const profile = await source.render({
            ...input,
            ...(binding ? { agentBinding: binding } : {}),
        });
        return {
            profile,
            ...(binding ? { binding } : {}),
        };
    }
    async readOrBackfillTaskBinding(session) {
        if (session.sessionKind !== 'task')
            return undefined;
        return this.taskSessionBindings?.ensureSessionAgentDefinition(session.sessionId);
    }
}
function usesSavedModelLimits(input, config, providerId) {
    if (!input.model)
        return true;
    return (input.session.sessionKind === 'task' &&
        (providerId !== 'minimax' || config.minimaxModelSource === 'minimax_api_key'));
}
const PLAN_MODE_WORKFLOW_PROMPT_KEYS = ['workflow/plan-mode/agent-entry.md'];
async function validateWorkflowPromptScope(scope) {
    if (!scope)
        return;
    for (const key of PLAN_MODE_WORKFLOW_PROMPT_KEYS) {
        const result = await scope.source.read(scope.snapshot, key);
        if (result.kind === 'invalid') {
            throw new PromptSnapshotInvalidError(`Workflow prompt cannot be read: ${key}`);
        }
    }
}
async function readOutputRevisionInstruction(scope) {
    if (!scope)
        return DEFAULT_OUTPUT_REVISION_INSTRUCTION;
    const result = await scope.source.read(scope.snapshot, OUTPUT_REVISION_PROMPT_KEY);
    if (result.kind === 'found')
        return result.content;
    if (result.kind === 'missing')
        return DEFAULT_OUTPUT_REVISION_INSTRUCTION;
    throw new PromptSnapshotInvalidError(`Workflow prompt cannot be read: ${OUTPUT_REVISION_PROMPT_KEY}`);
}
async function readRetryContinuationPrompt(scope, input) {
    if (input.clientIntent !== 'retry-continuation')
        return undefined;
    if (!scope)
        return DEFAULT_RETRY_CONTINUATION_PROMPT;
    const result = await scope.source.read(scope.snapshot, RETRY_CONTINUATION_PROMPT_KEY);
    if (result.kind === 'found')
        return result.content;
    if (result.kind === 'missing')
        return DEFAULT_RETRY_CONTINUATION_PROMPT;
    throw new PromptSnapshotInvalidError(`Desktop task prompt cannot be read: ${RETRY_CONTINUATION_PROMPT_KEY}`);
}
async function loadPromptLayers(parameters) {
    const { input, config, runtimeFacts, options, staticPrompts, nowMs, modelContextWindow, profile, } = parameters;
    const executionScope = createExecutionScope(input.session, runtimeFacts, profile, options.miniappAvailable === true);
    const capabilityOptions = createPromptCapabilityOptions(input.agent, runtimeFacts, profile);
    const memoryBlocks = loadMemoryBlocks({
        session: input.session,
        config,
        options,
        runtimeFacts,
        nowMs,
        profile,
    });
    // The Agent owner already rendered core/surface prompts for this turn, so the
    // static asset layers only run for hosts without an injected profile source.
    const staticIdentity = profile
        ? Promise.resolve({ basePrompt: '', sessionPrompt: '' })
        : readStaticIdentity(input, runtimeFacts, staticPrompts, capabilityOptions);
    const loaded = await Promise.all([
        staticIdentity,
        staticPrompts.readProjectInstructions(input.session.workspaceDir),
        staticPrompts.readGlobalInstructions?.(config.dataDir) ?? Promise.resolve(''),
        memoryBlocks,
        options.skills.listRuntimeSkills(executionScope),
    ]);
    const [{ basePrompt, sessionPrompt }, projectInstructions, globalInstructions, memory, skills] = loaded;
    const filteredRuntimeSkills = skills.skills.filter((skill) => isRuntimeSkillSelected(profile?.configSelection, skill));
    const standaloneNames = new Set(filteredRuntimeSkills.map((skill) => normalizedSkillName(skill.name)));
    const hideCodeReviewSkill = suppressesCodeReviewSkill(input.session);
    const allowedExtensionSkills = profile?.configSelection?.extensionSkills;
    const desktopSkills = (input.desktopCapabilities?.skills ?? []).filter((skill) => {
        const name = normalizedSkillName(skill.name);
        return (!(hideCodeReviewSkill && name === CODE_REVIEW_SKILL_NAME) &&
            !standaloneNames.has(name) &&
            isExtensionSkillSelected(allowedExtensionSkills, skill.pluginName, skill.name));
    });
    const catalog = await options.skills.renderCatalog({
        ...executionScope,
        ...(modelContextWindow === undefined ? {} : { contextWindowTokens: modelContextWindow }),
        additionalSkills: desktopSkills.map((skill) => ({
            name: skill.name,
            description: skill.description,
            builtin: false,
        })),
        ...(input.isSessionFirstTurn ? { firstTurnSessionId: input.session.sessionId } : {}),
    });
    return {
        basePrompt,
        sessionPrompt,
        projectInstructions,
        globalInstructions,
        memoryBlocks: memory,
        skills: { ...skills, skills: filteredRuntimeSkills },
        catalog,
        desktopPluginSkills: desktopSkills.map((skill) => ({
            pluginName: skill.pluginName,
            name: skill.name,
        })),
    };
}
function createExecutionScope(session, runtimeFacts, profile, miniappAvailable) {
    return {
        agentName: profile?.resourceReadRef ?? runtimeFacts.resourceAgentName,
        ...profileResourceScope(profile),
        workspaceDir: session.workspaceDir,
        ...builtinSkillScope(session, runtimeFacts),
        ...profileSelectionScope(profile),
        ...runtimeFeatureScope(runtimeFacts, profile, miniappAvailable),
    };
}
function profileResourceScope(profile) {
    return {
        ...(profile?.excludeAgentResources ? { excludeAgentResources: true } : {}),
        ...(profile?.skipAgentResolution ? { skipAgentResolution: true } : {}),
        ...(profile?.expectedAgentInstanceId
            ? { expectedAgentInstanceId: profile.expectedAgentInstanceId }
            : {}),
    };
}
function builtinSkillScope(session, runtimeFacts) {
    const builtinSkillNames = builtinSkillNamesFor(session, runtimeFacts);
    return builtinSkillNames ? { builtinSkillNames } : {};
}
function builtinSkillNamesFor(session, runtimeFacts) {
    if (!suppressesCodeReviewSkill(session))
        return runtimeFacts.builtinSkillNames;
    return runtimeFacts.builtinSkillNames?.filter((name) => normalizedSkillName(name) !== CODE_REVIEW_SKILL_NAME);
}
function profileSelectionScope(profile) {
    return {
        ...(profile?.configSelection?.skills === undefined
            ? {}
            : { allowedSkillNames: profile.configSelection.skills }),
        ...(profile?.configSelection?.extensionSkills === undefined
            ? {}
            : { allowedExtensionSkillNames: profile.configSelection.extensionSkills }),
        ...(profile
            ? {
                agentPolicy: {
                    canonicalRole: profile.canonicalViewName,
                    builtinAgent: profile.provenance.source !== 'custom',
                    capabilities: toResolvedAgentCapabilities(profile.capabilityCeiling),
                },
            }
            : {}),
    };
}
function runtimeFeatureScope(runtimeFacts, profile, miniappAvailable) {
    return {
        ...(runtimeFacts.exposeComputerUseActive
            ? { computerUseActive: runtimeFacts.computerUseActive }
            : {}),
        ...(miniappAvailable && profile?.surface === 'interactive' ? { miniappAvailable: true } : {}),
    };
}
function createPromptCapabilityOptions(agent, runtimeFacts, profile) {
    if (profile) {
        return { builtinCapabilities: toResolvedAgentCapabilities(profile.capabilityCeiling) };
    }
    return agent.builtinCapabilities ? { builtinCapabilities: runtimeFacts.builtinCapabilities } : {};
}
/**
 * A structured Review turn already runs the review workflow, so re-listing the
 * general-purpose `code-review` Skill only invites it to recurse into itself.
 * v1 derived this from `session.purpose` in `buildTurnAgentConfig`; the Agent
 * owner cutover moved turn config here, so the same rule lives here now.
 */
const CODE_REVIEW_SKILL_NAME = 'code-review';
function suppressesCodeReviewSkill(session) {
    return session.purpose?.startsWith('code-review:') === true;
}
function toResolvedAgentCapabilities(ceiling) {
    return {
        persona: { enabled: ceiling.personaEnabled },
        tools: ceiling.tools ? [...ceiling.tools] : undefined,
        builtinTools: ceiling.builtinTools ? [...ceiling.builtinTools] : undefined,
        skills: ceiling.skills ? [...ceiling.skills] : undefined,
        features: { ...ceiling.features },
    };
}
async function readStaticIdentity(input, runtimeFacts, staticPrompts, capabilityOptions) {
    const [basePrompt, sessionPrompt] = await Promise.all([
        staticPrompts.readBasePrompt(input.agent.agentRole, {
            includeAllLayer: input.agent.systemPromptIncludesBase !== true,
            ...capabilityOptions,
        }),
        staticPrompts.readSessionPrompt({
            sessionType: input.session.sessionType ?? 'root',
            agentName: runtimeFacts.resourceAgentName,
            ...(input.agent.agentConfigDir ? { agentConfigDir: input.agent.agentConfigDir } : {}),
            ...capabilityOptions,
        }),
    ]);
    return { basePrompt, sessionPrompt };
}
function loadMemoryBlocks(input) {
    const { session, config, options, runtimeFacts, nowMs, profile } = input;
    const recallEnabled = session.memoryPolicy?.recallEnabled !== false;
    const writeEnabled = session.memoryPolicy?.writeEnabled !== false;
    if (!options.memory) {
        return Promise.resolve([]);
    }
    // A migrated owner also reads its retired alias directories; the canonical
    // source stays first so USER.md and the tail budget keep one provenance.
    const sources = toMemoryPromptSources(profile ? profile.memoryReadAgentNames : [runtimeFacts.resourceAgentName]);
    return collectMemoryBlocks(options.memory, sources, nowMs, {
        includeAgentMemory: isLegacyMemoryRecallEnabled(config.memory, runtimeFacts.resourceAgentName) &&
            recallEnabled &&
            sources.length > 0,
        prompt: {
            includeWriteGuidance: !isMemoryV2Enabled(config.memory) &&
                config.memory?.enabled !== false &&
                writeEnabled &&
                profile?.surface !== 'task-child',
        },
    });
}
function buildSystemPrompt(scope) {
    const { agent, sessionType, layers, overrides, profile } = scope;
    const interactiveSurface = profile?.surface === undefined
        ? (sessionType ?? 'root') === 'root'
        : profile.surface !== 'task-child';
    return composePromptParts([
        buildIdentityPrompt({
            agent,
            layers,
            profile,
            interactiveSurface,
            overrides: interactiveSurface ? overrides : undefined,
        }),
        { text: environmentContextBlock(scope) },
        ...(!interactiveSurface
            ? [
                { text: '# Session Context' },
                { text: profile?.surfacePrompt.trim() ?? '' },
                { text: layers.sessionPrompt.trim() },
            ]
            : []),
        ...layers.memoryBlocks.map((text) => ({ text, kind: 'MEMORY' })),
        { text: layers.catalog.trim(), kind: 'SKILLS' },
    ]);
}
function buildIdentityPrompt(scope) {
    const { agent, layers, profile, interactiveSurface, overrides } = scope;
    const customPrompt = overrides?.customPrompt?.trim();
    const appendPrompt = overrides?.appendSystemPrompt?.trim() ?? '';
    const persona = (profile?.persona ?? agent.persona)?.trim();
    const globalInstructions = layers.globalInstructions.trim();
    const projectInstructions = layers.projectInstructions.trim();
    // The preamble only renders when at least one instruction layer is present, so
    // an empty workspace never claims that context follows.
    const instructionsPreamble = globalInstructions || projectInstructions ? INSTRUCTIONS_CONTEXT_PREAMBLE : '';
    const corePrompt = (profile?.corePrompt ?? agent.systemPrompt).trim();
    const hasIdentity = [
        persona,
        corePrompt,
        profile?.surfacePrompt,
        layers.basePrompt,
        layers.sessionPrompt,
        globalInstructions,
        projectInstructions,
    ].some((part) => part?.trim());
    const rootSessionPrompt = [profile?.surfacePrompt, layers.sessionPrompt]
        .filter(Boolean)
        .join('\n\n');
    const identity = customPrompt
        ? [{ text: addRuntimeRules(customPrompt, interactiveSurface, rootSessionPrompt) }]
        : [
            { text: persona ?? '' },
            {
                text: addRuntimeRules(hasIdentity
                    ? corePrompt
                    : "You are a local coding assistant running in the user's workspace.", interactiveSurface, rootSessionPrompt),
            },
            { text: layers.basePrompt.trim() },
        ];
    return composePromptParts([
        ...identity,
        { text: appendPrompt },
        { text: instructionsPreamble },
        { text: globalInstructions, kind: 'OTHER' },
        { text: projectInstructions, kind: 'OTHER' },
    ]);
}
function composePromptParts(parts) {
    return parts
        .filter((part) => part.text)
        .reduce((composed, part, index, contentParts) => {
        const followsHeading = /^#{1,6} [^\n]+$/u.test(contentParts[index - 1]?.text ?? '');
        const boundary = followsHeading ? '\n' : '\n\n';
        const separator = composed.text ? boundary : '';
        const startOffset = composed.text.length + separator.length;
        const text = `${composed.text}${separator}${part.text}`;
        const ownRange = part.kind
            ? [{ kind: part.kind, startOffset, endOffset: text.length }]
            : [];
        const nestedRanges = (part.ranges ?? []).map((range) => ({
            kind: range.kind,
            startOffset: startOffset + range.startOffset,
            endOffset: startOffset + range.endOffset,
        }));
        return { text, ranges: [...composed.ranges, ...ownRange, ...nestedRanges] };
    }, { text: '', ranges: [] });
}
function profilePromptMetadata(profile) {
    if (!profile?.promptMetadata)
        return {};
    return {
        prompt_metadata: {
            ...profile.promptMetadata,
            agent_name: profile.canonicalViewName,
            surface: profile.surface,
            capability_ceiling: profile.capabilityCeiling,
        },
    };
}
function createAgentConfig(scope) {
    const { input, model, layers, displayName, systemPrompt, contextUsagePromptRanges, runtimeFacts, profile, } = scope;
    const agentConfig = {
        system_prompt: systemPrompt,
        ...profilePromptMetadata(profile),
        contextUsagePromptRanges,
        model,
        tools: [],
        skills: [
            ...toSkillRefs(layers.skills.skills),
            ...toPluginSkillRefs(input.desktopCapabilities?.skills ?? [], layers.desktopPluginSkills),
        ],
        title: input.agent.agentName,
        display_name: displayName,
        resourceAgentName: runtimeFacts.resourceAgentName,
        builtinCapabilities: runtimeFacts.builtinCapabilities,
        computerUseActive: runtimeFacts.computerUseActive,
        desktopPluginSkills: layers.desktopPluginSkills,
        ...(typeof input.agent.metadata?.id === 'string' ? { agent_id: input.agent.metadata.id } : {}),
        ...(profile
            ? {
                capability_ceiling: profile.capabilityCeiling,
                agent_profile: {
                    ...(profile.excludeAgentResources ? { exclude_agent_resources: true } : {}),
                    ...(profile.skipAgentResolution ? { skip_agent_resolution: true } : {}),
                    ...(profile.expectedAgentInstanceId
                        ? { expected_agent_instance_id: profile.expectedAgentInstanceId }
                        : {}),
                    exact_owner_name: profile.exactOwnerName,
                    canonical_view_name: profile.canonicalViewName,
                    agent_role: profile.agentRole,
                    creation_source: profile.creationSource,
                    surface: profile.surface,
                    ...(profile.taskExecutionMode
                        ? { task_execution_mode: profile.taskExecutionMode }
                        : {}),
                    provenance_source: profile.provenance.source,
                    ...(profile.provenance.appMode ? { app_mode: profile.provenance.appMode } : {}),
                    trusted_builtin: profile.creationSource === 'builtin',
                    memory_agent_scope_enabled: profile.memoryReadAgentNames.length > 0,
                    memory_read_agent_names: profile.memoryReadAgentNames,
                    ...(profile.configSelection ? { config_selection: profile.configSelection } : {}),
                },
            }
            : {}),
    };
    return agentConfig;
}
function resolveAgentRuntimeFacts(agent, config) {
    return {
        resourceAgentName: agent.resourceAgentName?.trim() || agent.agentName,
        builtinCapabilities: agent.builtinCapabilities ?? resolveAgentCapabilities(config.agents?.default),
        ...(agent.builtinSkillNames ? { builtinSkillNames: agent.builtinSkillNames } : {}),
        computerUseActive: agent.computerUseActive === true,
        exposeComputerUseActive: agent.computerUseActive !== undefined,
    };
}
export function modelRefFromConfig(config, override, options = {}) {
    const overrideProvider = override?.provider_id?.trim();
    const overrideModelId = override?.model_id?.trim();
    const base = overrideProvider && overrideModelId ? undefined : parseModelKey(config.defaultModel);
    const provider = overrideProvider || base?.provider;
    const modelId = overrideModelId || base?.modelId;
    if (!provider || !modelId)
        throw new Error('Model selection is incomplete.');
    const selection = override ?? {
        variant: config.defaultModelVariant,
        thinking: config.defaultModelThinking,
        contextLimit: config.defaultModelContextWindow,
    };
    return modelRefForSelection(config, {
        providerId: provider,
        modelId,
        ...turnModelParameters(selection),
    }, options.implicitCustomProviderThinking === true);
}
/** Builds the ModelRef for an already gated selection; performs no re-selection. */
function modelRefForSelection(config, selection, implicitCustomProviderThinking = false, legacyFrozenSelection = false) {
    const model = modelRefForModel(selection.providerId, selection.modelId, modelConfigForRef(config, selection.providerId, selection.modelId), modelRefOptions(config, selection, implicitCustomProviderThinking, legacyFrozenSelection));
    return {
        ...model,
        ...(selection.contextLimit !== undefined ? { context_window: selection.contextLimit } : {}),
        ...(selection.maxOutputTokens !== undefined ? { max_tokens: selection.maxOutputTokens } : {}),
    };
}
function modelRefOptions(config, selection, implicitCustomProviderThinking, legacyFrozenSelection) {
    return {
        managed: !legacyFrozenSelection &&
            selection.providerId === 'minimax' &&
            config.minimaxModelSource !== 'minimax_api_key',
        ...(selection.variant === undefined ? {} : { variant: selection.variant }),
        ...(selection.parameterSnapshot ? { parameterSnapshot: selection.parameterSnapshot } : {}),
        ...(selection.reasoning === undefined ? {} : { reasoning: selection.reasoning }),
        ...(selection.contextLimit === undefined ? {} : { contextLimit: selection.contextLimit }),
        ...(implicitCustomProviderThinking ? { implicitCustomProviderThinking: true } : {}),
        ...(selection.thinking ? { thinking: selection.thinking } : {}),
    };
}
function usesLegacyFrozenSelection(requested, frozen) {
    return !requested && frozen !== undefined && !frozen.parameterSnapshot;
}
function withFrozenParameters(selection, requested, frozen) {
    if (!requested && frozen?.parameterSnapshot)
        return { ...selection, parameterSnapshot: frozen.parameterSnapshot };
    return selection;
}
function withFrozenSessionModelLimits(model, session, selection, isTask) {
    if (!isTask || session.effectiveModel !== `${selection.providerId}/${selection.modelId}`) {
        return model;
    }
    const contextWindow = positiveSessionLimit(session.effectiveModelContextWindow);
    const maxTokens = positiveSessionLimit(session.effectiveModelMaxOutputTokens);
    if (contextWindow === undefined && maxTokens === undefined)
        return model;
    return {
        ...model,
        ...(contextWindow === undefined ? {} : { context_window: contextWindow }),
        ...(maxTokens === undefined ? {} : { max_tokens: maxTokens }),
    };
}
function sessionWithFrozenModel(session, model) {
    if (!model)
        return session;
    return {
        ...session,
        effectiveModel: `${model.providerId}/${model.modelId}`,
        ...(model.variant === undefined
            ? { effectiveModelVariant: null }
            : { effectiveModelVariant: model.variant }),
        ...(model.thinking === undefined
            ? { effectiveModelThinking: null }
            : {
                effectiveModelThinking: {
                    ...model.thinking,
                    ...(model.thinking.budgets ? { budgets: { ...model.thinking.budgets } } : {}),
                },
            }),
        ...(model.contextWindow === undefined
            ? { effectiveModelContextWindow: null }
            : { effectiveModelContextWindow: model.contextWindow }),
        ...(model.maxOutputTokens === undefined
            ? { effectiveModelMaxOutputTokens: null }
            : { effectiveModelMaxOutputTokens: model.maxOutputTokens }),
    };
}
function positiveSessionLimit(value) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}
function parseModelKey(value) {
    const raw = value?.trim();
    const slash = raw?.indexOf('/') ?? -1;
    if (!raw || slash <= 0 || slash === raw.length - 1) {
        throw new Error(raw
            ? `Invalid model key "${raw}". Expected provider/model.`
            : 'defaultModel is not configured');
    }
    return { provider: raw.slice(0, slash), modelId: raw.slice(slash + 1) };
}
const MINIMAX_OFFICIAL_SKILL_SOURCE = 1;
function toSkillRefs(skills) {
    return skills.map((skill) => ({
        name: skill.name,
        ...(skill.description ? { description: skill.description } : {}),
        global: skill.sourceType === MINIMAX_OFFICIAL_SKILL_SOURCE,
        mutable: skill.sourceType !== MINIMAX_OFFICIAL_SKILL_SOURCE,
    }));
}
function toPluginSkillRefs(skills, effective) {
    const included = new Set(effective.map((skill) => `${normalizedSkillName(skill.pluginName)}\0${normalizedSkillName(skill.name)}`));
    return skills.flatMap((skill) => included.has(`${normalizedSkillName(skill.pluginName)}\0${normalizedSkillName(skill.name)}`)
        ? [
            {
                name: skill.name,
                ...(skill.description ? { description: skill.description } : {}),
                global: false,
                mutable: false,
            },
        ]
        : []);
}
function normalizedSkillName(name) {
    return name.trim().normalize('NFKC').toLocaleLowerCase('en-US');
}
function isExtensionSkillSelected(selected, pluginName, skillName) {
    if (selected === undefined)
        return true;
    const name = normalizedSkillName(skillName);
    const qualified = `${normalizedSkillName(pluginName)}:${name}`;
    return selected.some((candidate) => {
        const normalized = normalizedSkillName(candidate);
        return normalized === name || normalized === qualified;
    });
}
function isRuntimeSkillSelected(selection, skill) {
    if (skill.selectionScope === 'capability-owned')
        return true;
    const selected = selection?.skills;
    if (selected &&
        !selected.some((name) => normalizedSkillName(name) === normalizedSkillName(skill.name))) {
        return false;
    }
    return (skill.sourceType === MINIMAX_OFFICIAL_SKILL_SOURCE ||
        isExtensionSkillSelected(selection?.extensionSkills, '', skill.name));
}
//# sourceMappingURL=local-agent-config-builder.js.map