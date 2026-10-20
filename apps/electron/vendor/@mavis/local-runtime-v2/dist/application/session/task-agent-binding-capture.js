import { isMemoryV2Enabled, getRuntimePresetKey, resolveModelAvailability } from '@mavis/config';
import { hasConversationTaskModelSelection, } from '@mavis/conversation-contract';
import { COMPUTER_USE_TOOL_NAMES } from '../../service/computer-use/index.js';
import { bindPluginAgentMcpSelectors, pluginAgentSource, renderPluginAgentProfile, } from './plugin-agent-capture.js';
import { resolveEffectiveAgentModelSelection, modelConfigForRef, modelRefForModel, savedSessionModel, parseSourceQualifiedModelKey, } from '../../service/model-system/index.js';
import { toLegacyTaskSessionBinding } from '../../service/session-system/index.js';
import { filterLocalTurnCapabilityInventory, resolveAgentPromptSurface, } from '../../service/turn-system/index.js';
/** Captures an immutable V2 Agent definition before the Session row is inserted. */
export function createTaskAgentBindingCaptureCoordinator(options) {
    return {
        capture: async (input) => {
            const captured = await captureDefinition(options, input, false);
            return {
                agentDefinition: captured.agentDefinition,
                taskAgentBinding: captured.legacyTaskBinding,
                effectiveModel: captured.effectiveModel,
                ...(captured.effectiveModelVariant !== undefined
                    ? { effectiveModelVariant: captured.effectiveModelVariant }
                    : {}),
                ...(captured.effectiveModelThinking
                    ? { effectiveModelThinking: captured.effectiveModelThinking }
                    : {}),
                ...(captured.effectiveModelContextWindow === undefined
                    ? {}
                    : { effectiveModelContextWindow: captured.effectiveModelContextWindow }),
                ...(captured.effectiveModelMaxOutputTokens === undefined
                    ? {}
                    : { effectiveModelMaxOutputTokens: captured.effectiveModelMaxOutputTokens }),
            };
        },
        captureSessionDefinition: async (input) => {
            const captured = await captureDefinition(options, input, true);
            return { agentDefinition: captured.agentDefinition };
        },
        captureFrozenDefinition: async (input) => captureLegacyTaskBinding(options, input),
    };
}
async function captureDefinition(options, input, historical) {
    const session = input.session ?? input.parent;
    if (!session)
        throw new Error('Session Agent definition capture requires a Session.');
    const config = options.config();
    const profile = await renderCaptureProfile({ options, config, session, input, historical });
    const frozenSurface = input.legacyDefinition ?? {
        systemPrompt: profile.agentSystemPrompt ?? '',
        ...(profile.promptSnapshot ? { promptSnapshot: profile.promptSnapshot } : {}),
        capabilities: await freezeCapturedCapabilities(options, session, profile, input.pluginAgent),
    };
    const selection = resolveCapturedModel({
        config,
        profile,
        session,
        input,
        historical,
        ...(options.diagnostics ? { diagnostics: options.diagnostics } : {}),
    });
    logTaskModelDiagnostics(options.diagnostics, selection.diagnostics);
    const effectiveModel = `${selection.providerId}/${selection.modelId}`;
    const variant = resolvedModelVariant({ selection, session, parent: input.parent });
    const thinking = resolvedThinkingSelection({ selection, session, parent: input.parent });
    return buildCapturedDefinition({
        profile,
        frozenSurface,
        session,
        selection,
        effectiveModel,
        variant,
        thinking,
        ...(await captureOwnerFields(options, profile, input.pluginAgent)),
    });
}
async function freezeCapturedCapabilities(options, session, profile, pluginAgent) {
    const ready = await options.inventory.capture({ session, profile });
    const bindings = ready.desktopCapabilities?.runtimeToolBindings ?? [];
    const inventoryToolNames = [
        ...ready.sources.nativeTools,
        ...ready.sources.mcpEntries.map(({ tool }) => tool),
        ...ready.sources.threadGoalTools,
        ...(ready.desktopCapabilities?.runtimeTools ?? []),
    ].map((tool) => tool.def.name);
    return freezeSelectorCapabilities(bindPluginAgentMcpSelectors(profile, pluginAgent, bindings, inventoryToolNames), ready);
}
async function renderCaptureProfile(input) {
    const { options, config, session } = input;
    const pluginAgent = input.input.pluginAgent;
    if (!pluginAgent) {
        return renderSessionProfile({
            options,
            config,
            agentName: input.input.agentName,
            session,
            appMode: input.input.appMode,
            legacyTaskSurface: input.input.session === undefined,
        });
    }
    if (input.historical || input.input.session?.sessionKind !== 'task' || !input.input.parent) {
        throw new Error('Plugin Agent definitions are captured only for new Task Sessions.');
    }
    return renderPluginAgentProfile({
        agentService: options.agentService,
        agent: pluginAgent,
        request: profileRequest(options, config, session, input.input.appMode),
    });
}
/** Plugin Agents have no Agent row, so they carry their source instead of an instance id. */
async function captureOwnerFields(options, profile, pluginAgent) {
    if (pluginAgent)
        return { pluginSource: pluginAgentSource(pluginAgent) };
    const ownerInstanceId = await captureOwnerInstanceId(options.agentService, profile);
    return ownerInstanceId ? { ownerInstanceId } : {};
}
function resolveCapturedModel(input) {
    const historical = input.historical ? historicalModelSelection(input.session) : undefined;
    const requested = input.input.requestedModel;
    if (requested?.providerId === 'minimax' &&
        requested.modelId &&
        input.config.minimaxModelSource !== 'minimax_api_key') {
        // Validate public effort before the Agent's legacy on/off conversion can consume it.
        modelRefForModel(requested.providerId, requested.modelId, modelConfigForRef(input.config, requested.providerId, requested.modelId), {
            managed: true,
            variant: requested.variant,
            reasoning: requested.reasoning,
            contextLimit: requested.contextLimit,
            thinking: requested.thinking,
        });
    }
    const resolved = historical ??
        resolveEffectiveAgentModelSelection({
            config: input.config,
            replaceRetired: !input.historical,
            sources: modelSources({
                profile: input.profile,
                session: input.session,
                parent: input.input.parent,
                taskModelSelection: input.input.taskModelSelection,
                parentModel: input.input.parentModel,
                requestedModel: input.config.minimaxModelSource !== 'minimax_api_key'
                    ? input.input.requestedModel
                    : undefined,
                legacyTaskCapture: input.input.session === undefined,
                ignoreSessionModel: input.historical,
            }),
        });
    if (!resolved)
        throw new Error('No runtime or Agent model is configured.');
    // `historical` marks a *describing* capture, not a running one: it completes
    // or upgrades the frozen definition of an already-existing Session, always
    // via `captureSessionDefinition` -> `ensureSessionAgentDefinition`. That runs
    // whenever a Task Session's definition is absent or still V1 legacy, which is
    // reached from several places — the startup backfill sweep
    // (`backfillSessionAgentDefinitionForStartup`), on-demand backfill during
    // execution preparation (`execution-source.ts`,
    // `local-agent-config-builder.readOrBackfillTaskBinding`) and fork copying
    // (`fork/data-capability.ts`). So this branch is NOT startup-only.
    //
    // It stays exempt because describing a historical Session must succeed even
    // when the model it recorded has since been retired: the alternative is that
    // one removed model makes an old Session permanently unopenable, and the
    // startup sweep unable to finish. A frozen definition is never replaced.
    //
    // The branch below is the live path (`capture`): a retired official model
    // was replaced by `replaceRetired`; it only records what was captured.
    if (!historical)
        recordCapturedModel(input, resolved);
    return resolved;
}
/**
 * A retired official model was already replaced during capture. Anything still
 * not listed (e.g. a removed custom model) is frozen as captured and left for
 * the upstream to reject; capture only records it.
 */
function recordCapturedModel(input, resolved) {
    const available = resolveModelAvailability({
        config: input.config,
        providerId: resolved.providerId,
        modelId: resolved.modelId,
        preset: getRuntimePresetKey(),
        source: 'config_default',
    }).available;
    const replacedFrom = resolved.replacedFrom;
    if (available && !replacedFrom)
        return;
    input.diagnostics?.info?.({
        event: available
            ? 'task_agent_captured_model_replaced'
            : 'task_agent_captured_model_unavailable',
        agent_name: input.profile.exactOwnerName,
        provider_id: resolved.providerId,
        model_id: resolved.modelId,
        ...(replacedFrom
            ? { replaced_from: `${replacedFrom.providerId}/${replacedFrom.modelId}` }
            : {}),
    }, available
        ? 'Agent execution captured a replacement for a retired model'
        : 'Agent execution captured a model the catalog does not list; the upstream decides');
}
function buildCapturedDefinition(input) {
    const agentDefinition = buildAgentDefinition(input);
    return {
        agentDefinition,
        legacyTaskBinding: toLegacyTaskSessionBinding(agentDefinition),
        effectiveModel: input.effectiveModel,
        ...(input.variant === undefined ? {} : { effectiveModelVariant: input.variant }),
        ...(input.thinking ? { effectiveModelThinking: input.thinking } : {}),
        ...(input.selection.contextWindow === undefined
            ? {}
            : { effectiveModelContextWindow: input.selection.contextWindow }),
        ...(input.selection.maxOutputTokens === undefined
            ? {}
            : { effectiveModelMaxOutputTokens: input.selection.maxOutputTokens }),
    };
}
function buildAgentDefinition(input) {
    return {
        definition: {
            definitionVersion: 2,
            exactOwnerName: input.profile.exactOwnerName,
            ...(input.ownerInstanceId ? { ownerInstanceId: input.ownerInstanceId } : {}),
            ...(input.pluginSource ? { pluginSource: input.pluginSource } : {}),
            systemPrompt: input.frozenSurface.systemPrompt,
            ...(input.frozenSurface.promptSnapshot
                ? { promptSnapshot: input.frozenSurface.promptSnapshot }
                : {}),
            capabilities: input.frozenSurface.capabilities,
            model: {
                providerId: input.selection.providerId,
                modelId: input.selection.modelId,
                ...(input.selection.parameterSnapshot
                    ? { parameterSnapshot: input.selection.parameterSnapshot }
                    : {}),
                ...(input.variant === undefined ? {} : { variant: input.variant }),
                ...(input.thinking ? { thinking: input.thinking } : {}),
                ...(input.selection.contextWindow === undefined
                    ? {}
                    : { contextWindow: input.selection.contextWindow }),
                ...(input.selection.maxOutputTokens === undefined
                    ? {}
                    : { maxOutputTokens: input.selection.maxOutputTokens }),
            },
            project: {
                workspaceDir: input.session.workspaceDir,
                isDefaultWorkspace: input.session.isDefaultWorkspace === true,
            },
        },
    };
}
async function renderSessionProfile(input) {
    return input.options.agentService.renderProfile({
        exactOwnerName: input.agentName,
        surface: input.legacyTaskSurface
            ? 'task-child'
            : resolveAgentPromptSurface(input.session, input.options.runtimeOwnerKind),
        ...profileRequest(input.options, input.config, input.session, input.appMode),
    });
}
function profileRequest(options, config, session, appMode) {
    const configuredCapabilities = config.agents?.default;
    const capabilities = options.capabilityProfile === 'cli'
        ? {
            ...configuredCapabilities,
            features: { ...configuredCapabilities?.features, mavis: false },
        }
        : configuredCapabilities;
    return {
        promptProfile: options.runtimeOwnerKind === 'tui' ? 'tui' : 'desktop',
        appMode: appMode ?? session.appMode ?? 'coding',
        capabilities,
        memoryEnabled: !isCommandLineRuntimeOwner(options.runtimeOwnerKind) &&
            !isMemoryV2Enabled(config.memory) &&
            config.memory?.enabled,
        cronEnabled: !isCommandLineRuntimeOwner(options.runtimeOwnerKind),
        dataDirToken: config.dataDir,
    };
}
/** V1 compatibility: historical Task prompt/capability recovery never reselects a model. */
async function captureLegacyTaskBinding(options, input) {
    const session = input.parent ?? input.session;
    if (!session)
        throw new Error('Historical Task Agent capture requires a parent Session.');
    const profile = await renderSessionProfile({
        options,
        config: options.config(),
        agentName: input.agentName,
        session,
        appMode: input.appMode,
        legacyTaskSurface: true,
    });
    const inventory = await options.inventory.capture({ session, profile });
    return {
        taskAgentBinding: {
            definition: {
                definitionVersion: 1,
                systemPrompt: profile.agentSystemPrompt ?? '',
                ...(profile.promptSnapshot ? { promptSnapshot: profile.promptSnapshot } : {}),
                capabilities: freezeSelectorCapabilities(profile, inventory),
            },
        },
    };
}
function logTaskModelDiagnostics(diagnostics, entries) {
    for (const entry of entries) {
        diagnostics?.info?.({
            code: entry.code,
            source: entry.source,
            requested: entry.requested,
            effective: entry.effective,
            physical_limit: entry.physicalLimit,
        }, 'task_agent_model_selection_clamped');
    }
}
function modelSources(input) {
    if (input.requestedModel?.providerId === 'minimax' && input.requestedModel.modelId) {
        const model = input.requestedModel;
        return [
            {
                source: 'session-requested-model',
                requireCatalog: true,
                selection: {
                    model: `${model.providerId}/${model.modelId}`,
                    variant: model.variant,
                    reasoning: model.reasoning,
                    effort: model.thinking?.effort,
                    contextWindow: model.contextLimit,
                },
            },
        ];
    }
    const target = taskTargetModelSelection(input.profile);
    const parent = parentModelSelection(input);
    const session = input.ignoreSessionModel ? undefined : sessionModelSelection(input.session);
    const targetSource = target
        ? {
            source: 'session-target-agent',
            selection: target,
            requireCatalog: true,
            allowCustomProviderPrefixFallback: true,
            defaultMissingEffortOff: true,
        }
        : undefined;
    const sources = [];
    if (input.legacyTaskCapture || input.session.sessionKind === 'task') {
        return taskModelSources(input, targetSource, parent);
    }
    if (session) {
        sources.push({ source: 'session-requested-model', selection: session, requireCatalog: false });
    }
    if (targetSource)
        sources.push(targetSource);
    if (parent) {
        sources.push({
            source: 'session-parent-model',
            selection: parent,
            requireCatalog: false,
            parameterSnapshot: parentModelSnapshot(input),
        });
    }
    return sources;
}
function taskModelSources(input, targetSource, parent) {
    const sources = [];
    if (hasConversationTaskModelSelection(input.taskModelSelection)) {
        sources.push({
            source: 'task-model-override',
            selection: input.taskModelSelection,
            requireCatalog: true,
            allowCustomProviderPrefixFallback: true,
            defaultMissingEffortOff: true,
        });
    }
    if (targetSource)
        sources.push({ ...targetSource, source: 'task-target-agent' });
    if (parent)
        sources.push({
            source: 'task-parent-session',
            selection: parent,
            requireCatalog: false,
            parameterSnapshot: parentModelSnapshot(input),
        });
    return sources;
}
function parentModelSnapshot(input) {
    return (input.parentModel?.parameterSnapshot ?? savedSessionModel(input.parent ?? {})?.parameterSnapshot);
}
function parentModelSelection(input) {
    if (!input.parent)
        return undefined;
    if (!input.legacyTaskCapture && input.parent.sessionId === input.session.sessionId) {
        return undefined;
    }
    if (input.parentModel?.parameterSnapshot) {
        const model = input.parentModel;
        return {
            model: `${model.providerId}/${model.modelId}`,
            variant: model.variant,
            effort: model.thinking?.effort,
            contextWindow: model.contextWindow,
            maxOutputTokens: model.maxOutputTokens,
        };
    }
    return sessionModelSelection(input.parent);
}
async function captureOwnerInstanceId(agentService, profile) {
    if (profile.creationSource === 'builtin')
        return undefined;
    const document = await agentService.getConfigDocument(profile.requestRef);
    if (document.ownerKind !== 'custom' || document.exactOwnerName !== profile.exactOwnerName) {
        throw new Error(`Agent definition owner changed while Session was being created: ${profile.exactOwnerName}`);
    }
    if (!document.ownerInstanceId?.trim()) {
        throw new Error(`Custom Agent instance is unavailable: ${profile.exactOwnerName}`);
    }
    return document.ownerInstanceId;
}
function sessionModelSelection(session) {
    const model = session.effectiveModel?.trim();
    if (!model)
        return undefined;
    return {
        model,
        ...(session.effectiveModelVariant == null ? {} : { variant: session.effectiveModelVariant }),
        ...(session.effectiveModelThinking?.effort
            ? { effort: session.effectiveModelThinking.effort }
            : {}),
        ...(session.effectiveModelContextWindow !== undefined &&
            session.effectiveModelContextWindow !== null
            ? { contextWindow: session.effectiveModelContextWindow }
            : {}),
        ...(session.effectiveModelMaxOutputTokens !== undefined &&
            session.effectiveModelMaxOutputTokens !== null
            ? { maxOutputTokens: session.effectiveModelMaxOutputTokens }
            : {}),
    };
}
function modelVariant(value) {
    return typeof value === 'string' ? value : undefined;
}
function resolvedModelVariant(input) {
    if (input.selection.reasoning !== undefined)
        return input.selection.reasoning ? 'thinking' : '';
    if (input.selection.source === 'session-historical-model' ||
        input.selection.source === 'session-requested-model') {
        return modelVariant(input.session.effectiveModelVariant);
    }
    if (input.selection.source === 'task-parent-session' ||
        input.selection.source === 'session-parent-model') {
        return modelVariant(input.parent?.effectiveModelVariant);
    }
    return undefined;
}
function historicalModelSelection(session) {
    if (session.effectiveModel === undefined || session.effectiveModel === null)
        return undefined;
    const parsed = parseSourceQualifiedModelKey(session.effectiveModel);
    if (!parsed)
        return undefined;
    return {
        providerId: parsed.providerId,
        modelId: parsed.modelId,
        source: 'session-historical-model',
        ...(session.effectiveModelContextWindow === undefined ||
            session.effectiveModelContextWindow === null
            ? {}
            : { contextWindow: session.effectiveModelContextWindow }),
        ...(session.effectiveModelMaxOutputTokens === undefined ||
            session.effectiveModelMaxOutputTokens === null
            ? {}
            : { maxOutputTokens: session.effectiveModelMaxOutputTokens }),
        diagnostics: [],
    };
}
function resolvedThinkingSelection(input) {
    if (input.selection.reasoning !== undefined) {
        return input.selection.reasoning && input.selection.effort
            ? { effort: input.selection.effort }
            : undefined;
    }
    const base = baseThinkingSelection(input);
    const thinking = {
        ...(base ?? {}),
        ...(input.selection.effort === undefined ? {} : { effort: input.selection.effort }),
        ...(base?.budgets ? { budgets: { ...base.budgets } } : {}),
    };
    return Object.keys(thinking).length > 0 ? thinking : undefined;
}
function baseThinkingSelection(input) {
    if (input.selection.source === 'session-historical-model' ||
        input.selection.source === 'session-requested-model') {
        return input.session.effectiveModelThinking;
    }
    if (input.selection.source === 'task-parent-session' ||
        input.selection.source === 'session-parent-model') {
        return input.parent?.effectiveModelThinking;
    }
    return undefined;
}
function taskTargetModelSelection(profile) {
    return profile.configSelection?.model ? profile.configSelection : undefined;
}
function freezeSelectorCapabilities(profile, ready) {
    const filtered = filterLocalTurnCapabilityInventory({
        sources: ready.sources,
        agentProfile: toTurnProfileFacts(profile),
        ...(ready.desktopCapabilities ? { desktopCapabilities: ready.desktopCapabilities } : {}),
    });
    // Capture the possible native Computer Use ceiling before the first @ admission.
    // Apply the original selectors here; final Turn gates still require activation.
    const facts = toTurnProfileFacts(profile);
    const deferredComputerTools = facts.trustedBuiltin && facts.canonicalRole === 'mavis' && facts.surface === 'interactive'
        ? COMPUTER_USE_TOOL_NAMES.filter((name) => filtered.selector.allowsTool(name))
        : [];
    const tools = uniqueNames([
        ...deferredComputerTools,
        ...filtered.nativeTools.map((tool) => tool.def.name),
        ...filtered.mcpEntries.map(({ tool }) => tool.def.name),
        ...filtered.threadGoalTools.map((tool) => tool.def.name),
        ...(filtered.desktopCapabilities?.runtimeTools.map((tool) => tool.def.name) ?? []),
    ]);
    const mcpServers = uniqueNames([
        ...filtered.mcpEntries.flatMap((entry) => (entry.serverName ? [entry.serverName] : [])),
        ...(filtered.desktopCapabilities?.runtimeToolBindings.flatMap((binding) => binding.kind === 'mcp' ? [binding.source] : []) ?? []),
    ]);
    // The Skill reader checks both allowlists for Desktop Plugin Skills, so a
    // frozen Plugin Skill must be named in `skills` as well as `extensionSkills`.
    const desktopSkills = (filtered.desktopCapabilities?.skills ?? [])
        .filter((skill) => filtered.selector.allowsExtensionSkill(skill.pluginName, skill.name))
        .map((skill) => ({ ...skill, runtimeName: `${skill.pluginName}:${skill.name}` }));
    const skills = uniqueNames([
        ...ready.skills
            .filter((skill) => filtered.selector.allowsSkill(skill.name))
            .map((skill) => skill.name),
        ...desktopSkills
            .filter((skill) => filtered.selector.allowsSkill(skill.name) ||
            filtered.selector.allowsSkill(skill.runtimeName))
            .map((skill) => skill.runtimeName),
    ]);
    const extensionSkills = uniqueNames([
        ...ready.skills
            .filter((skill) => !isBuiltinRuntimeSkill(skill))
            .filter((skill) => filtered.selector.allowsSkill(skill.name))
            .filter((skill) => filtered.selector.allowsExtensionSkill('', skill.name))
            .map((skill) => skill.name),
        ...desktopSkills.map((skill) => skill.runtimeName),
    ]);
    const disallowedTools = profile.configSelection?.disallowedTools ?? [];
    return {
        // Undefined canonical selectors resolve to the current ready inventory at
        // Task creation, plus the explicitly allowed deferred Computer Use names above.
        // Persisting every bucket turns the snapshot into a true
        // upper bound: later installs can only be removed by current runtime gates.
        tools,
        disallowedTools: [...disallowedTools],
        mcpServers,
        skills,
        extensionSkills,
    };
}
function isBuiltinRuntimeSkill(skill) {
    return skill.sourceType === 1;
}
function toTurnProfileFacts(profile) {
    return {
        capabilityCeiling: profile.capabilityCeiling,
        ...(profile.creationSource === 'builtin' ? { canonicalRole: profile.canonicalViewName } : {}),
        trustedBuiltin: profile.creationSource === 'builtin' && profile.provenance.source !== 'custom',
        surface: profile.surface,
        ...(profile.configSelection ? { configSelection: profile.configSelection } : {}),
    };
}
function uniqueNames(values) {
    const normalized = new Map();
    for (const value of values) {
        const trimmed = value.trim();
        if (!trimmed)
            continue;
        const key = trimmed.normalize('NFKC').toLocaleLowerCase('en-US');
        if (!normalized.has(key))
            normalized.set(key, trimmed);
    }
    return [...normalized.values()];
}
function isCommandLineRuntimeOwner(runtimeOwnerKind) {
    return runtimeOwnerKind === 'cli' || runtimeOwnerKind === 'tui';
}
//# sourceMappingURL=task-agent-binding-capture.js.map