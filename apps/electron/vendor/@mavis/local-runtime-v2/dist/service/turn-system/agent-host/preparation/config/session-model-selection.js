// Single route-aware model selection for one Turn.
//
// The priority stays `explicit request > Session effectiveModel >
// config.defaultModel`, resolved exactly once here and handed to the rest of
// preparation together with its source.
//
// A reference the official catalog no longer lists is replaced, never refused:
// the next callable tier wins, ending at the delivered default (see
// `resolveModelReplacement`). A replaced Session model is written back so the
// Session and UI converge. Retired managed minimax-legacy aliases resolve the
// same way. Frozen official selections are never replaced and never blocked
// locally: they are sent unchanged and the upstream decides.
//
// Non-official routes (custom providers, configured providers) keep their own
// contract: an unlisted Session pin is left to the BYOK resolver, while an
// explicit, default or frozen reference is refused here, because past this gate
// that resolver silently swaps an unresolvable provider for a builtin model.
//
// Persistence is injected: this module (and the config builder) must not import
// a repository or write SQL. Composition supplies `repairSessionModel` once the
// SessionSystem is ready, backed by the existing record-service mutation.
import { getRuntimePresetKey, resolveModelAvailability, resolveModelReplacement, } from '@mavis/config';
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
    const selection = await resolveLegacySelection(input, selectRequestedModel(input));
    const preset = getRuntimePresetKey();
    const outcome = resolveModelReplacement({
        config: input.config,
        providerId: selection.providerId,
        modelId: selection.modelId,
        preset,
        fallbacks: fallbackTiers(input, selection.source),
    });
    if (outcome.kind === 'available')
        return selection;
    const log = {
        session_id: input.session.sessionId,
        source: selection.source,
        preset,
        route: outcome.route,
    };
    const from = `${selection.providerId}/${selection.modelId}`;
    if (outcome.kind === 'passthrough' && outcome.reason === 'unmanaged_route') {
        return gateUnmanagedRoute(input, selection, log, from);
    }
    if (outcome.kind === 'passthrough' || !isReplaceable(input, selection)) {
        // Not ours to decide: a frozen official selection, or an official route
        // that lists nothing. Send it unchanged; record why.
        const reason = outcome.kind === 'passthrough' ? outcome.reason : 'frozen';
        logModelGateOutcome(input.logger, { outcome: 'passthrough', reason, ...log, model: from });
        return selection;
    }
    if (repairsSession(input, selection))
        await repairSession(input, selection, outcome.model);
    const to = `${outcome.model.providerId}/${outcome.model.modelId}`;
    input.logger?.info?.({ ...log, tier: outcome.tier, from_model: from, to_model: to }, 'turn_model_replaced');
    // The retired model's variant/effort/context do not carry over.
    return { ...outcome.model, source: selection.source };
}
/**
 * Retirement only concerns official catalogs, so a non-official route keeps
 * its pre-retirement contract. An unlisted Session pin is left to the BYOK
 * resolver (its config can change between writes). Any other unlisted
 * reference is refused: past this gate the resolver would silently swap an
 * unresolvable provider for a builtin model the user did not choose.
 */
function gateUnmanagedRoute(input, selection, log, from) {
    if (selection.source === 'session_override') {
        logModelGateOutcome(input.logger, {
            outcome: 'passthrough',
            reason: 'unmanaged_route',
            ...log,
            model: from,
        });
        return selection;
    }
    const availability = resolveModelAvailability({
        config: input.config,
        providerId: selection.providerId,
        modelId: selection.modelId,
        preset: getRuntimePresetKey(),
        source: selection.source,
    });
    if (availability.available)
        return selection;
    logModelGateOutcome(input.logger, {
        outcome: 'rejected',
        ...log,
        model: from,
        code: availability.code,
    });
    throw new ModelRouteAvailabilityError(availability.code, availability.message);
}
/** Maps a retired managed alias to its official model; only a Session pin is repaired. */
async function resolveLegacySelection(input, selection) {
    const legacy = selection.frozen ? undefined : resolveLegacyMinimaxModel(input.config, selection);
    if (!legacy)
        return selection;
    // An explicit queued override must not overwrite a newer Session model.
    if (selection.source === 'session_override')
        await repairSession(input, selection, legacy);
    return { ...legacy, source: selection.source };
}
/**
 * Frozen selections are never replaced. A Session pin without a repair
 * capability is a frozen Task definition, so it is left alone too.
 */
function isReplaceable(input, selection) {
    return !selection.frozen && (selection.source !== 'session_override' || !!input.repair);
}
/**
 * The Session pin is rewritten when it is the stale model: either it was the
 * selected tier, or an explicit request repeated it (the UI re-sends its
 * pending choice). A different explicit model never overwrites the Session.
 */
function repairsSession(input, stale) {
    if (stale.source === 'session_override')
        return true;
    return (stale.source === 'explicit_request' &&
        input.session.effectiveModel?.trim() === `${stale.providerId}/${stale.modelId}`);
}
/** Lower-priority tiers tried before the delivered default. */
function fallbackTiers(input, source) {
    const configDefault = parseModelReference(input.config.defaultModel);
    if (source === 'explicit_request') {
        return [parseModelReference(input.session.effectiveModel), configDefault];
    }
    return source === 'session_override' ? [configDefault] : [];
}
async function repairSession(input, stale, replacement) {
    if (!input.repair)
        return;
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
        ...(stale.modelId === replacement.modelId
            ? {}
            : { replacedFrom: { providerId: stale.providerId, modelId: stale.modelId } }),
    });
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
/**
 * Wires the repair to the existing Session record service. A failed mutation
 * fails the Turn before the stale Session model can reach the upstream.
 * `onRepaired` publishes the committed change so the UI can show a notice;
 * the low-level record mutation emits no model fact by itself.
 */
export function createSessionModelRepair(records, logger, onRepaired) {
    return {
        repairSessionModel: async (input) => {
            let session;
            try {
                session = await records.mutateSession(input.sessionId, {
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
            logger?.info?.({
                session_id: input.sessionId,
                ...(input.replacedFrom
                    ? { from_model: `${input.replacedFrom.providerId}/${input.replacedFrom.modelId}` }
                    : {}),
                to_model: input.effectiveModel,
            }, 'session_model_repaired');
            onRepaired?.(session, input.replacedFrom);
        },
    };
}
function parseModelKey(value) {
    const parsed = parseModelReference(value);
    if (!parsed) {
        const raw = value?.trim();
        throw new Error(raw
            ? `Invalid model key "${raw}". Expected provider/model.`
            : 'defaultModel is not configured');
    }
    return { provider: parsed.providerId, modelId: parsed.modelId };
}
function parseModelReference(value) {
    const raw = value?.trim();
    const slash = raw?.indexOf('/') ?? -1;
    if (!raw || slash <= 0 || slash === raw.length - 1)
        return undefined;
    return { providerId: raw.slice(0, slash), modelId: raw.slice(slash + 1) };
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