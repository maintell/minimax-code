import { publishBestEffort } from '../events.js';
import { ThinkingLevel } from '@mavis/protocol';
import { getRuntimePresetKey, resolveModelAvailability, resolveModelReplacement, } from '@mavis/config';
import { LocalModelProviderError, MANAGED_MINIMAX_PROVIDER_ID, formatModelKey, freezeManagedQueueModel, savedSessionModel, isLegacyMinimaxProvider, listLocalRuntimeModels, modelConfigForRef, modelRefForModel, parseSourceQualifiedModelKey, resolveLegacyMinimaxModel, } from '../../service/model-system/index.js';
import { AgentServiceError } from '../../service/agent/index.js';
/** Cross-capability model catalog and selection workflow owned by Runtime V2. */
export class ModelProviderApplication {
    deps;
    constructor(deps) {
        this.deps = deps;
    }
    async list(input = {}) {
        await this.refresh();
        const session = input.sessionId ? await this.deps.sessions.get(input.sessionId) : undefined;
        const config = this.deps.config();
        const state = await this.resolveListState(input.sessionId, session, config);
        const models = listLocalRuntimeModels(config, state.catalogSelection, {
            cache: this.deps.providers.loadCacheData(),
            ...(this.deps.implicitCustomProviderThinking ? { implicitCustomProviderThinking: true } : {}),
        });
        const catalog = models.filter((model) => !isLegacyMinimaxProvider(config, model.providerId));
        return state.bypassStoredProjection ? catalog : projectStoredParameters(catalog, state.stored);
    }
    async resolveListState(sessionId, session, config) {
        const channelSelection = await this.resolveChannelSelection(sessionId, session);
        if (session?.sessionKind === 'channel')
            return channelModelListState(channelSelection);
        const selected = this.resolveStaleSelection(config, modelSelectionFromSession(session));
        return {
            selected,
            catalogSelection: selected,
            stored: sessionId ? session : defaultModelStoredParameters(config),
            bypassStoredProjection: bypassStoredParameters(sessionId, session, selected),
        };
    }
    /**
     * Projects a stale stored selection onto the model a Turn would actually run,
     * without writing it: a legacy alias resolves to its official model and a
     * retired official model to its replacement (the Turn preparation rule). The
     * Session is rewritten by its next Turn.
     */
    resolveStaleSelection(config, selected) {
        const current = selected ?? parseSourceQualifiedModelKey(config.defaultModel);
        if (!current?.providerId || !current.modelId)
            return selected;
        const legacy = resolveLegacyMinimaxModel(config, {
            providerId: current.providerId,
            modelId: current.modelId,
        });
        const resolved = legacy ?? { providerId: current.providerId, modelId: current.modelId };
        const outcome = resolveModelReplacement({
            config,
            ...resolved,
            preset: getRuntimePresetKey(),
            fallbacks: [parseSourceQualifiedModelKey(config.defaultModel)],
        });
        if (outcome.kind === 'replaced')
            return { ...outcome.model, variant: null };
        return legacy ? { ...legacy, variant: null } : selected;
    }
    async refresh() {
        const before = this.deps.config().defaultModel;
        try {
            await this.deps.refreshOfficialModels?.();
        }
        catch {
            // Official refresh is fail-open; the catalog keeps its last-known-good config.
            return;
        }
        // The snapshot sync rewrites a retired saved default in the same locked
        // write; tell the UI once. Stateless: derived from the before/after config.
        const replacedFrom = this.retiredDefaultReplacedFrom(before);
        if (replacedFrom)
            this.publishDefaultModelChanged(replacedFrom);
    }
    retiredDefaultReplacedFrom(before) {
        const config = this.deps.config();
        const previous = parseSourceQualifiedModelKey(before);
        if (!previous || before === config.defaultModel)
            return undefined;
        const outcome = resolveModelReplacement({
            config,
            providerId: previous.providerId,
            modelId: previous.modelId,
            preset: getRuntimePresetKey(),
        });
        return outcome.kind === 'replaced'
            ? { providerId: previous.providerId, modelId: previous.modelId }
            : undefined;
    }
    async select(input) {
        const session = input.sessionId ? await this.requireModelSession(input.sessionId) : undefined;
        const { replacement, replacedFrom, selection: replaced } = this.replaceStaleSelection(input);
        let selection = replaced;
        const providerId = selection.providerId.trim();
        const modelId = selection.modelId.trim();
        if (!providerId || !modelId) {
            throw new LocalModelProviderError(400, 'provider_id and model_id are required', 'VALIDATION_ERROR');
        }
        this.assertModelAvailable(providerId, modelId);
        this.deps.providers.assertModelSelectable(providerId, modelId);
        const catalogEntry = listLocalRuntimeModels(this.deps.config(), undefined, {
            cache: this.deps.providers.loadCacheData(),
        }).find((entry) => entry.providerId === providerId && entry.modelId === modelId);
        selection = normalizeRequestedParameters(this.deps.config(), { ...selection, providerId, modelId }, catalogEntry);
        const modelKey = formatModelKey(providerId, modelId);
        if (selection.sessionId) {
            if (session?.sessionKind === 'channel') {
                const source = await this.selectForChannel({
                    sessionId: selection.sessionId,
                    session,
                    selection,
                });
                if (source === 'runtime-default') {
                    await this.selectDefaultModel(modelKey, selection);
                    this.publishDefaultModelChanged(replacedFrom);
                }
                return true;
            }
            await this.selectForSession({
                sessionId: selection.sessionId,
                modelKey,
                input: selection,
                catalogEntry,
                ...(replacement ? { staleModel: formatModelKey(input.providerId, input.modelId) } : {}),
                ...(replacedFrom ? { replacedFrom } : {}),
                ...(session ? { session } : {}),
            });
            return true;
        }
        await this.selectDefaultModel(modelKey, selection);
        this.publishDefaultModelChanged(replacedFrom);
        return true;
    }
    /**
     * A legacy alias or a retired official model (a stale picker can still offer
     * one) is replaced instead of failing the switch; only a retirement carries
     * `replacedFrom` so the UI can explain it.
     */
    replaceStaleSelection(input) {
        const replacement = resolveLegacyMinimaxModel(this.deps.config(), input);
        const retired = replacement ? undefined : this.retiredModelReplacement(input);
        const model = replacement ?? retired;
        if (!model)
            return { selection: input };
        return {
            ...(replacement ? { replacement } : {}),
            ...(retired
                ? { replacedFrom: { providerId: input.providerId.trim(), modelId: input.modelId.trim() } }
                : {}),
            selection: { ...model, sessionId: input.sessionId, thinking: null },
        };
    }
    retiredModelReplacement(input) {
        const config = this.deps.config();
        const providerId = input.providerId.trim();
        const modelId = input.modelId.trim();
        if (!providerId || !modelId)
            return undefined;
        const outcome = resolveModelReplacement({
            config,
            providerId,
            modelId,
            preset: getRuntimePresetKey(),
            fallbacks: [parseSourceQualifiedModelKey(config.defaultModel)],
        });
        return outcome.kind === 'replaced' ? outcome.model : undefined;
    }
    publishDefaultModelChanged(replacedFrom) {
        const saved = this.deps.config();
        const savedModel = parseSourceQualifiedModelKey(saved.defaultModel);
        if (this.deps.publish && savedModel) {
            publishBestEffort(this.deps.publish, {
                type: 'session.model_updated',
                payload: {
                    providerId: savedModel.providerId,
                    modelId: savedModel.modelId,
                    variant: saved.defaultModelVariant ?? null,
                    thinking: saved.defaultModelThinking ?? null,
                    contextLimit: saved.defaultModelContextWindow ?? null,
                    ...(replacedFrom ? { replacedFrom } : {}),
                },
            });
        }
    }
    async selectDefaultModel(modelKey, selection) {
        try {
            await this.deps.setDefaultModel(modelKey, selection.variant, ...(selection.replaceSelection ||
                selection.contextLimit !== undefined ||
                selection.thinking !== undefined
                ? [
                    {
                        ...(selection.contextLimit !== undefined
                            ? { contextLimit: selection.contextLimit }
                            : {}),
                        ...(selection.thinking ? { thinking: selection.thinking } : {}),
                    },
                ]
                : []));
        }
        catch (error) {
            throw new LocalModelProviderError(400, error instanceof Error ? error.message : String(error), 'CONFIG_WRITE_FAILED');
        }
    }
    async selectForSession(scope) {
        const { sessionId, modelKey, input, catalogEntry, staleModel, replacedFrom } = scope;
        const session = scope.session ?? (await this.deps.sessions.get(sessionId));
        if (!session) {
            throw new LocalModelProviderError(404, 'Session not found', 'SESSION_NOT_FOUND');
        }
        if (staleModel && session.effectiveModel && session.effectiveModel !== staleModel)
            return;
        await this.deps.sessions.update(sessionId, {
            effectiveModel: modelKey,
            effectiveModelVariant: input.variant ?? null,
            ...thinkingSelectionUpdate(session, modelKey, input),
            ...sessionLimitUpdate(this.deps.config(), session, {
                modelKey,
                input,
                catalog: catalogEntry,
            }),
            ...managedReplacementParameters(this.deps.config(), input, session),
        }, ...(replacedFrom ? [{ replacedFrom }] : []));
    }
    async requireModelSession(sessionId) {
        const session = await this.deps.sessions.get(sessionId);
        if (!session) {
            throw new LocalModelProviderError(404, 'Session not found', 'SESSION_NOT_FOUND');
        }
        return session;
    }
    async selectForChannel(input) {
        const agentName = input.session.agentName?.trim();
        if (!agentName) {
            throw new LocalModelProviderError(409, 'Channel Session is missing its bound Agent.', 'CHANNEL_AGENT_UNAVAILABLE');
        }
        const selectChannelModel = this.deps.selectChannelModel;
        if (!selectChannelModel) {
            throw new LocalModelProviderError(503, 'Channel model selection is unavailable while the runtime is starting.', 'CHANNEL_MODEL_SELECTION_UNAVAILABLE');
        }
        try {
            return await selectChannelModel({
                sessionId: input.sessionId,
                agentName,
                selection: input.selection,
            });
        }
        catch (error) {
            if (error instanceof LocalModelProviderError)
                throw error;
            if (error instanceof AgentServiceError) {
                throw new LocalModelProviderError(error.status, error.message, error.code);
            }
            throw new LocalModelProviderError(400, error instanceof Error ? error.message : String(error), 'CONFIG_WRITE_FAILED');
        }
    }
    async resolveChannelSelection(sessionId, session) {
        if (session?.sessionKind !== 'channel' || !sessionId || !session.agentName)
            return undefined;
        return await this.deps.resolveChannelSelection?.({ sessionId, agentName: session.agentName });
    }
    assertModelAvailable(providerId, modelId) {
        const availability = resolveModelAvailability({
            config: this.deps.config(),
            providerId,
            modelId,
            preset: getRuntimePresetKey(),
            source: 'explicit_request',
        });
        if (availability.available)
            return;
        throw new LocalModelProviderError(400, availability.message, availability.code);
    }
}
function isManagedSelection(config, providerId) {
    return (providerId === MANAGED_MINIMAX_PROVIDER_ID && config.minimaxModelSource !== 'minimax_api_key');
}
function normalizeRequestedParameters(config, selection, catalogEntry) {
    const modelConfig = modelConfigForRef(config, selection.providerId, selection.modelId);
    let normalized = selection;
    if (isManagedSelection(config, selection.providerId))
        normalized = normalizeManagedSelection(selection, modelConfig);
    else
        validateContextLimit(selection, catalogEntry, modelConfig);
    if (normalized.reasoning === undefined)
        return normalized;
    if (typeof normalized.reasoning !== 'boolean')
        throw new LocalModelProviderError(400, 'Invalid model reasoning', 'VALIDATION_ERROR');
    return { ...normalized, variant: normalized.reasoning ? 'thinking' : '' };
}
function normalizeManagedSelection(selection, config) {
    const resolved = modelRefForModel(selection.providerId, selection.modelId, config, {
        managed: true,
        variant: selection.variant,
        reasoning: selection.reasoning,
        contextLimit: selection.contextLimit,
        thinking: selection.thinking ?? undefined,
    });
    if (selection.reasoning === false ||
        selection.variant === '' ||
        selection.variant === 'none-thinking')
        return { ...selection, thinking: null };
    if (selection.thinking == null)
        return selection;
    const thinking = selection.thinking.effort != null && resolved.thinking_effort
        ? { effort: resolved.thinking_effort }
        : null;
    return { ...selection, thinking };
}
function managedReplacementParameters(config, input, session) {
    const saved = savedSessionModel(session, session.frozenModel);
    if (!isManagedSelection(config, input.providerId) ||
        (!input.replaceSelection &&
            session.effectiveModel === formatModelKey(input.providerId, input.modelId) &&
            saved !== undefined &&
            !saved.parameterSnapshot &&
            input.contextLimit === undefined &&
            input.thinking == null))
        return {};
    const inherited = inheritedManagedParameters(config, input, session);
    const { overrides, modelParameterSnapshot } = managedSessionOverrides(input, inherited);
    const resolved = modelRefForModel(input.providerId, input.modelId, modelConfigForRef(config, input.providerId, input.modelId), overrides);
    return managedSessionParameterUpdate(resolved, input, modelParameterSnapshot, !!inherited && !!saved?.parameterSnapshot);
}
function managedSessionParameterUpdate(resolved, input, modelParameterSnapshot, preserveUnchanged) {
    const variant = resolved.thinking_level === ThinkingLevel.OFF ? '' : 'thinking';
    const thinking = resolved.thinking_effort ? { effort: resolved.thinking_effort } : null;
    const context = resolved.context_window ?? null;
    if (preserveUnchanged)
        return {
            effectiveModelVariant: variant,
            ...(input.thinking === undefined ? {} : { effectiveModelThinking: thinking }),
            ...(input.contextLimit === undefined ? {} : { effectiveModelContextWindow: context }),
        };
    return {
        effectiveModelVariant: variant,
        effectiveModelThinking: thinking,
        effectiveModelContextWindow: context,
        modelParameterSnapshot,
    };
}
function managedSessionOverrides(input, inherited) {
    const modelParameterSnapshot = managedSessionParameterOrigins(input, inherited?.parameterSnapshot);
    return {
        modelParameterSnapshot,
        overrides: {
            managed: true,
            ...(inherited ? { parameterSnapshot: modelParameterSnapshot } : {}),
            variant: input.variant ?? inherited?.variant,
            reasoning: input.reasoning,
            contextLimit: input.contextLimit ?? inherited?.context_limit,
            thinking: input.thinking === undefined ? inherited?.thinking : (input.thinking ?? undefined),
        },
    };
}
function managedSessionParameterOrigins(input, inherited) {
    const effort = input.thinking?.effort === undefined ? 'default' : 'selection';
    return {
        context: input.contextLimit === undefined ? (inherited?.context ?? 'default') : 'selection',
        effort: input.thinking === undefined ? (inherited?.effort ?? 'default') : effort,
    };
}
function inheritedManagedParameters(config, input, session) {
    if (input.replaceSelection ||
        session.effectiveModel !== formatModelKey(input.providerId, input.modelId))
        return undefined;
    return freezeManagedQueueModel(config, session, undefined, session.frozenModel);
}
function sessionLimitUpdate(config, session, scope) {
    const { modelKey, input, catalog } = scope;
    const reset = session.effectiveModel !== modelKey || input.replaceSelection;
    const defaults = reset
        ? {
            effectiveModelContextWindow: input.replaceSelection && isManagedSelection(config, input.providerId)
                ? null
                : (catalog?.contextLimit ?? null),
            effectiveModelMaxOutputTokens: catalog?.maxOutputTokens ?? null,
        }
        : {};
    return {
        ...defaults,
        ...(input.contextLimit === undefined
            ? {}
            : { effectiveModelContextWindow: input.contextLimit }),
    };
}
function projectStoredParameters(catalog, stored) {
    const contextLimit = stored?.effectiveModelContextWindow;
    const thinking = stored?.effectiveModelThinking;
    const context = contextLimit && Number.isSafeInteger(contextLimit) && contextLimit > 0 ? { contextLimit } : {};
    return catalog.map((entry) => entry.selected ? { ...entry, ...context, ...(thinking ? { thinking } : {}) } : entry);
}
function thinkingSelectionUpdate(session, modelKey, input) {
    if (input.thinking !== undefined)
        return { effectiveModelThinking: input.thinking };
    if (session.effectiveModel === modelKey && !input.replaceSelection)
        return {};
    return { effectiveModelThinking: null };
}
function modelSelectionFromSession(session) {
    const parsed = parseSourceQualifiedModelKey(session?.effectiveModel);
    if (!parsed)
        return undefined;
    return {
        providerId: parsed.providerId,
        modelId: parsed.modelId,
        ...(session?.effectiveModelVariant !== undefined
            ? { variant: session.effectiveModelVariant }
            : {}),
    };
}
function modelSelectionFromChannel(selection) {
    return { providerId: selection.providerId, modelId: selection.modelId };
}
const EMPTY_CHANNEL_MODEL_SELECTION = Object.freeze({ providerId: '', modelId: '' });
function channelModelListState(channelSelection) {
    if (!channelSelection) {
        // `listLocalRuntimeModels(config, undefined)` selects the runtime default.
        // A stale/missing channel Agent selection must render no selected row.
        return {
            selected: undefined,
            catalogSelection: EMPTY_CHANNEL_MODEL_SELECTION,
            stored: undefined,
            bypassStoredProjection: false,
        };
    }
    const selected = modelSelectionFromChannel(channelSelection);
    return {
        selected,
        catalogSelection: selected,
        stored: storedChannelSelection(channelSelection),
        bypassStoredProjection: false,
    };
}
function defaultModelStoredParameters(config) {
    return {
        effectiveModelContextWindow: config.defaultModelContextWindow,
        effectiveModelThinking: config.defaultModelThinking,
    };
}
function bypassStoredParameters(sessionId, session, selected) {
    if (!sessionId || !selected || session?.sessionKind === 'channel')
        return false;
    return session?.effectiveModel !== `${selected.providerId}/${selected.modelId}`;
}
function storedChannelSelection(selection) {
    return {
        ...(selection.contextLimit === undefined
            ? {}
            : { effectiveModelContextWindow: selection.contextLimit }),
        ...(selection.effort === undefined
            ? {}
            : { effectiveModelThinking: { effort: selection.effort } }),
    };
}
function validateContextLimit(input, catalogEntry, modelConfig) {
    if (input.contextLimit === undefined)
        return;
    const limit = input.contextLimit;
    if (Number.isSafeInteger(limit) &&
        limit > 0 &&
        limit <= 2_147_483_647 &&
        (catalogEntry?.contextWindowOptions?.includes(limit) ||
            modelConfig?.contextWindowOptions?.includes(limit) ||
            (catalogEntry?.contextLimit !== undefined && limit <= catalogEntry.contextLimit)))
        return;
    throw new LocalModelProviderError(400, 'context_limit must be supported by the selected model', 'VALIDATION_ERROR');
}
//# sourceMappingURL=model-provider-application.js.map