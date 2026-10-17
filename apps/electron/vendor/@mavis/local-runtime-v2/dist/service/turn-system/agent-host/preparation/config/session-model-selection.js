// Single route-aware model selection for one Turn.
//
// The priority stays `explicit request > Session effectiveModel >
// config.defaultModel`, but it is resolved exactly once here and handed to the
// rest of preparation together with its source: the source decides what an
// unavailable model means. A historical managed Session pinned to a model its
// backend retired must be repaired locally and never reach the upstream.
// Retired managed minimax-legacy aliases resolve to an available official model.
// Other BYOK Session overrides stay intact and are delegated to the BYOK resolver, which
// owns transient config-switch races and dangling-provider fallback like v1.
// An explicit request or a broken default still fails locally instead of
// silently running on a different model.
//
// Persistence is injected: this module (and the config builder) must not import
// a repository or write SQL. Composition supplies `repairSessionModel` once the
// SessionSystem is ready, backed by the existing record-service mutation.
import { getRuntimePresetKey, resolveModelAvailability, } from '@mavis/config';
import { resolveLegacyMinimaxModel, } from '../../../../model-system/index.js';
/** Stable local failure; never produced after an upstream request was started. */
export class ModelRouteAvailabilityError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = 'ModelRouteAvailabilityError';
    }
}
export async function resolveTurnModelSelection(input) {
    let selection = selectRequestedModel(input);
    const replacement = selection.frozen
        ? undefined
        : resolveLegacyMinimaxModel(input.config, selection);
    if (replacement) {
        // Repair only the current Session selection. An explicit queued override
        // must not overwrite a newer model the user selected for the Session.
        if (selection.source === 'session_override' && input.repair) {
            await input.repair.repairSessionModel({
                sessionId: input.session.sessionId,
                expectedModel: {
                    effectiveModel: input.session.effectiveModel,
                    effectiveModelVariant: input.session.effectiveModelVariant,
                    effectiveModelThinking: input.session.effectiveModelThinking,
                    effectiveModelContextWindow: input.session.effectiveModelContextWindow,
                    effectiveModelMaxOutputTokens: input.session.effectiveModelMaxOutputTokens,
                },
                effectiveModel: `${replacement.providerId}/${replacement.modelId}`,
                effectiveModelVariant: null,
                effectiveModelThinking: null,
            });
        }
        selection = { ...replacement, source: selection.source };
    }
    const preset = getRuntimePresetKey();
    const availability = resolveModelAvailability({
        config: input.config,
        providerId: selection.providerId,
        modelId: selection.modelId,
        preset,
        source: selection.source,
    });
    if (availability.available || shouldDeferUnavailableByokSession(selection, availability.route)) {
        return selection;
    }
    if (selection.source !== 'session_override') {
        // Refusal branch. Logged before throwing because "the upstream was never
        // called" is otherwise only visible as an ABSENCE of a request log: the
        // route / preset / model triple here is what tells apart "the backend
        // retired this model" from "the user picked a model nobody configured".
        logModelGateOutcome(input.logger, {
            outcome: 'rejected',
            session_id: input.session.sessionId,
            source: selection.source,
            preset,
            route: availability.route,
            model: `${selection.providerId}/${selection.modelId}`,
            code: availability.code,
        });
        throw new ModelRouteAvailabilityError(availability.code, availability.message);
    }
    return repairSessionOverride({ input, preset, stale: selection });
}
/**
 * V1 lets its source-specific resolver own unavailable BYOK Session refs. Keep
 * that behavior so a config/model switch observed between writes cannot
 * permanently rewrite the Session to the managed default. Explicit requests
 * and managed Session refs remain protected by the route gate above.
 */
function shouldDeferUnavailableByokSession(selection, route) {
    return (selection.source === 'session_override' &&
        (route === 'minimax_api_key' || route === 'custom_provider'));
}
/**
 * One bounded event for every non-happy model gate decision. Model ids and
 * route names only — never an apiKey, token or user message.
 */
function logModelGateOutcome(logger, fields) {
    logger?.warn?.(fields, 'turn_model_gate');
}
/** Applies the selection priority once and records which tier actually won. */
function selectRequestedModel(input) {
    const override = input.requested ??
        modelOverrideFromSession(input.session) ?? {
        variant: input.config.defaultModelVariant,
        thinking: input.config.defaultModelThinking,
        contextLimit: input.config.defaultModelContextWindow,
    };
    const overrideProvider = override?.provider_id?.trim();
    const overrideModelId = override?.model_id?.trim();
    const base = overrideProvider && overrideModelId ? undefined : parseModelKey(input.config.defaultModel);
    const providerId = overrideProvider || base?.provider;
    const modelId = overrideModelId || base?.modelId;
    if (!providerId || !modelId)
        throw new Error('Model selection is incomplete.');
    return {
        providerId,
        modelId,
        source: selectionSource(input, overrideProvider, overrideModelId),
        ...turnModelParameters(override),
    };
}
export function turnModelParameters(override) {
    return {
        ...(override.parameterSnapshot ? { parameterSnapshot: override.parameterSnapshot } : {}),
        ...(override.variant !== undefined ? { variant: override.variant } : {}),
        ...(override.reasoning !== undefined ? { reasoning: override.reasoning } : {}),
        ...(override.contextLimit !== undefined ? { contextLimit: override.contextLimit } : {}),
        ...(override.maxOutputTokens !== undefined
            ? { maxOutputTokens: override.maxOutputTokens }
            : {}),
        ...(override.frozen === true ? { frozen: true } : {}),
        ...(override.modelSource ? { modelSource: override.modelSource } : {}),
        ...(override.thinking ? { thinking: override.thinking } : {}),
    };
}
/**
 * Moves one resolved model group between the durable Queue representation and
 * the AgentHost input. The fields are deliberately kept together with model
 * selection so Queue dispatch cannot drop an Agent-selected parameter.
 */
export function queueModelFromAgentHost(model) {
    if (!model)
        return undefined;
    return { ...queueModelIdentity(model), ...queueModelParameters(model) };
}
export function agentHostModelFromQueue(model) {
    if (!model)
        return undefined;
    return { ...agentHostModelIdentity(model), ...agentHostModelParameters(model) };
}
function queueModelIdentity(model) {
    return {
        ...(model.providerId ? { provider_id: model.providerId } : {}),
        ...(model.modelId ? { model_id: model.modelId } : {}),
    };
}
function queueModelParameters(model) {
    return {
        ...(model.parameterSnapshot ? { parameterSnapshot: model.parameterSnapshot } : {}),
        ...(model.reasoning === undefined ? {} : { reasoning: model.reasoning }),
        ...(model.contextLimit === undefined ? {} : { context_limit: model.contextLimit }),
        ...(model.maxOutputTokens === undefined ? {} : { max_output_tokens: model.maxOutputTokens }),
        ...(model.variant === undefined ? {} : { variant: model.variant }),
        ...(model.frozen === true ? { frozen: true } : {}),
        ...(model.modelSource ? { modelSource: model.modelSource } : {}),
        ...(model.thinking === undefined ? {} : { thinking: model.thinking }),
    };
}
function agentHostModelIdentity(model) {
    return {
        ...(model.provider_id ? { providerId: model.provider_id } : {}),
        ...(model.model_id ? { modelId: model.model_id } : {}),
    };
}
function agentHostModelParameters(model) {
    return {
        ...(model.parameterSnapshot ? { parameterSnapshot: model.parameterSnapshot } : {}),
        ...(model.reasoning === undefined ? {} : { reasoning: model.reasoning }),
        ...(model.context_limit === undefined ? {} : { contextLimit: model.context_limit }),
        ...(model.max_output_tokens === undefined ? {} : { maxOutputTokens: model.max_output_tokens }),
        ...(model.variant === undefined ? {} : { variant: model.variant }),
        ...(model.frozen === true ? { frozen: true } : {}),
        ...(model.modelSource ? { modelSource: model.modelSource } : {}),
        ...(model.thinking === undefined ? {} : { thinking: model.thinking }),
    };
}
function selectionSource(input, overrideProvider, overrideModelId) {
    if (!overrideProvider && !overrideModelId)
        return 'config_default';
    return input.requested ? 'explicit_request' : 'session_override';
}
async function repairSessionOverride(scope) {
    const { input, preset, stale } = scope;
    const fallback = parseModelKey(input.config.defaultModel);
    const availability = resolveModelAvailability({
        config: input.config,
        providerId: fallback.provider,
        modelId: fallback.modelId,
        preset,
        source: 'config_default',
    });
    if (!availability.available) {
        // Both tiers are unusable: the Session pin is retired AND the configured
        // default cannot be called on this route. Logged separately from the
        // branch above so "repair was attempted but had nowhere to land" is not
        // mistaken for "the Session model was simply invalid".
        logModelGateOutcome(input.logger, {
            outcome: 'repair_unavailable',
            session_id: input.session.sessionId,
            source: stale.source,
            preset,
            route: availability.route,
            from_model: `${stale.providerId}/${stale.modelId}`,
            fallback_model: `${fallback.provider}/${fallback.modelId}`,
            code: availability.code,
        });
        throw new ModelRouteAvailabilityError(availability.code, availability.message);
    }
    const repaired = `${fallback.provider}/${fallback.modelId}`;
    // Variant belongs to the retired model; carrying it to another model would
    // re-pin a thinking mode the user never chose for it.
    if (!input.repair) {
        // Reached by a Task Session whose frozen model was retired: the frozen
        // selection is deliberately not repairable (`canRepair === false` in
        // `resolveTurnModel`), so there is no capability to rewrite it to the
        // default. Preparation must still fail here — before any provider request
        // — but the previous bare "repair is unavailable" message named the missing
        // capability instead of the cause, and this branch emitted no log at all,
        // so the retired model could not be identified from runtime logs.
        logModelGateOutcome(input.logger, {
            outcome: 'frozen_model_unavailable',
            session_id: input.session.sessionId,
            source: stale.source,
            preset,
            model: `${stale.providerId}/${stale.modelId}`,
            fallback_model: repaired,
            repairable: false,
        });
        throw new ModelRouteAvailabilityError('MODEL_NOT_AVAILABLE_FOR_ROUTE', `The model pinned to this Session (${stale.providerId}/${stale.modelId}) is no longer available and this Session's model is frozen, so it cannot be repaired automatically.`);
    }
    await input.repair.repairSessionModel({
        sessionId: input.session.sessionId,
        effectiveModel: repaired,
        effectiveModelVariant: null,
        effectiveModelThinking: null,
    });
    input.logger?.info?.({
        session_id: input.session.sessionId,
        source: stale.source,
        preset,
        from_model: `${stale.providerId}/${stale.modelId}`,
        to_model: repaired,
    }, 'session_model_repaired');
    return { providerId: fallback.provider, modelId: fallback.modelId, source: 'config_default' };
}
/**
 * Wires the repair to the existing Session record service. A failed mutation
 * fails the Turn before an unavailable Session model can reach the upstream.
 */
export function createSessionModelRepair(records, logger) {
    return {
        repairSessionModel: async (input) => {
            try {
                await records.mutateSession(input.sessionId, {
                    effectiveModel: input.effectiveModel,
                    effectiveModelVariant: input.effectiveModelVariant,
                    effectiveModelThinking: input.effectiveModelThinking,
                }, ...(input.expectedModel ? [input.expectedModel] : []));
            }
            catch (error) {
                logger?.warn?.({
                    session_id: input.sessionId,
                    to_model: input.effectiveModel,
                    error: error instanceof Error ? error.message : String(error),
                }, 'session_model_repair_persist_failed');
                throw error;
            }
        },
    };
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
function modelOverrideFromSession(session) {
    const effective = session.effectiveModel?.trim();
    const slash = effective?.indexOf('/') ?? -1;
    if (!effective || slash <= 0 || slash === effective.length - 1) {
        return undefined;
    }
    return {
        provider_id: effective.slice(0, slash),
        model_id: effective.slice(slash + 1),
        ...(typeof session.effectiveModelVariant === 'string'
            ? { variant: session.effectiveModelVariant }
            : {}),
        ...(session.effectiveModelContextWindow != null
            ? { contextLimit: session.effectiveModelContextWindow }
            : {}),
        ...(session.effectiveModelThinking ? { thinking: session.effectiveModelThinking } : {}),
    };
}
//# sourceMappingURL=session-model-selection.js.map