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
// contract, but a Session pin is no longer waved through unchecked: a pin this
// route can call runs as stored, a pin that only lacks the `custom_provider:`
// prefix the write side now writes is resolved under that prefix, and anything
// else is refused here — past this gate an unresolvable provider id is parsed as
// a builtin managed provider and fails with a credential error instead.
//
// Persistence is injected: this module (and the config builder) must not import
// a repository or write SQL. Composition supplies `repairSessionModel` once the
// SessionSystem is ready, backed by the existing record-service mutation.
import { CUSTOM_PROVIDER_ID_PREFIX, MANAGED_MINIMAX_PROVIDER_ID, MINIMAX_API_PROVIDER_ID, getRuntimePresetKey, resolveModelAvailability, resolveModelReplacement, } from '@mavis/config';
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
    if (outcome.kind === 'replaced' && !isReplaceable(input, selection)) {
        return keepUnreplaceable(input, selection, outcome, { ...log, model: from });
    }
    if (outcome.kind === 'passthrough') {
        // Not ours to decide: an official route that lists nothing. Send it unchanged.
        logModelGateOutcome(input.logger, {
            outcome: 'passthrough',
            reason: outcome.reason,
            ...log,
            model: from,
        });
        return selection;
    }
    if (repairsSession(input, selection))
        await repairSession(input, selection, outcome.model, outcome.cause);
    const to = `${outcome.model.providerId}/${outcome.model.modelId}`;
    input.logger?.info?.({ ...log, tier: outcome.tier, cause: outcome.cause, from_model: from, to_model: to }, 'turn_model_replaced');
    // The retired model's variant/effort/context do not carry over.
    return { ...outcome.model, source: selection.source };
}
/**
 * A frozen selection is never rewritten. A retired official model is sent unchanged for the
 * upstream to decide; a withdrawn agent model access provider cannot run at all, so this
 * Turn uses the replacement without touching the stored definition.
 */
function keepUnreplaceable(input, selection, outcome, log) {
    if (outcome.cause === 'unavailable') {
        logModelGateOutcome(input.logger, {
            outcome: 'replaced_unpersisted',
            reason: 'unavailable',
            ...log,
        });
        return { ...outcome.model, source: selection.source };
    }
    logModelGateOutcome(input.logger, { outcome: 'passthrough', reason: 'frozen', ...log });
    return selection;
}
/**
 * Retirement only concerns official catalogs, so a non-official route keeps
 * its pre-retirement contract. An unlisted Session pin is left to the BYOK
 * resolver (its config can change between writes). Any other unlisted
 * reference is refused: past this gate the resolver would silently swap an
 * unresolvable provider for a builtin model the user did not choose.
 */
function gateUnmanagedRoute(input, selection, log, from) {
    // A Session pin on a route that owns its model list stays with the BYOK
    // resolver: that config can change between writes, so a miss here says
    // nothing. The exception is a pin whose provider id is not a configured
    // provider at all — it can only come from a write that dropped the
    // `custom_provider:` prefix, and past this gate it parses as a builtin
    // managed provider and fails on credentials instead of on the model.
    if (selection.source === 'session_override' && !isBareProviderPin(input.config, selection)) {
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
    if (selection.source === 'session_override') {
        const canonical = canonicalCustomProviderSelection(input.config, selection);
        if (canonical) {
            logModelGateOutcome(input.logger, {
                outcome: 'canonicalized',
                reason: 'custom_provider_prefix',
                ...log,
                model: from,
                to_model: `${canonical.providerId}/${canonical.modelId}`,
            });
            return canonical;
        }
    }
    logModelGateOutcome(input.logger, {
        outcome: 'rejected',
        ...log,
        model: from,
        code: availability.code,
    });
    throw new ModelRouteAvailabilityError(availability.code, availability.message);
}
/**
 * A Session pin whose provider id is neither reserved, nor already a
 * `custom_provider:` id, nor a provider this config declares. Only such a pin
 * is judged here; every other unmanaged pin keeps its own route's contract.
 */
function isBareProviderPin(config, selection) {
    const { providerId } = selection;
    return !(providerId.startsWith(CUSTOM_PROVIDER_ID_PREFIX) ||
        providerId === MANAGED_MINIMAX_PROVIDER_ID ||
        providerId === MINIMAX_API_PROVIDER_ID ||
        Object.hasOwn(config.provider, providerId));
}
/**
 * The same model under the `custom_provider:` prefix the picker writes.
 *
 * A Session pinned before the write side canonicalized its key stores the bare
 * provider key. That id parses as a builtin managed provider, so the Turn fails
 * with `api_key not configured` / `managed-login requires a known managed
 * base_url` even though the very same model is configured and callable. Only
 * the provider id changes; the stored key is left for the user to re-save.
 */
function canonicalCustomProviderSelection(config, selection) {
    if (selection.providerId.startsWith(CUSTOM_PROVIDER_ID_PREFIX) ||
        selection.providerId === MANAGED_MINIMAX_PROVIDER_ID ||
        selection.providerId === MINIMAX_API_PROVIDER_ID) {
        return undefined;
    }
    const providerId = `${CUSTOM_PROVIDER_ID_PREFIX}${selection.providerId}`;
    const availability = resolveModelAvailability({
        config,
        providerId,
        modelId: selection.modelId,
        preset: getRuntimePresetKey(),
        source: selection.source,
    });
    return availability.available ? { ...selection, providerId } : undefined;
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
async function repairSession(input, stale, replacement, cause = 'retired') {
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
        ...(stale.modelId === replacement.modelId && cause === 'retired'
            ? {}
            : {
                replacedFrom: {
                    providerId: stale.providerId,
                    modelId: stale.modelId,
                    ...(cause === 'unavailable' ? { reason: 'unavailable' } : {}),
                },
            }),
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
/** `provider/model` from config; the model id may itself contain `/`. */
export function parseModelKey(value) {
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
// ── Frozen Session model ────────────────────────────────────────
export function usesLegacyFrozenSelection(requested, frozen) {
    return !requested && frozen !== undefined && !frozen.parameterSnapshot;
}
export function withFrozenParameters(selection, requested, frozen) {
    if (!requested && frozen?.parameterSnapshot)
        return { ...selection, parameterSnapshot: frozen.parameterSnapshot };
    return selection;
}
export function withFrozenSessionModelLimits(model, session, selection, isTask) {
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
export function sessionWithFrozenModel(session, model) {
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
//# sourceMappingURL=session-model-selection.js.map