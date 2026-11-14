import { getRuntimePresetKey, resolveModelAvailability, resolveModelReplacement, } from '@mavis/config';
import { formatModelKey, modelConfigForRef, normalizeModelThinkingEffortOptions, parseSourceQualifiedModelKey, resolveLegacyMinimaxModel, resolveRequestedSessionModel, } from '../../service/model-system/index.js';
function namesModel(selection) {
    return Boolean(selection.providerId?.trim() && selection.modelId?.trim());
}
/** The same "thinking off" reading the model application applies to a selection. */
function turnsThinkingOff(selection) {
    return (selection.reasoning === false ||
        selection.variant === '' ||
        selection.variant === 'none-thinking');
}
/** The effort levels a model really offers, lowest to highest; `default` is not a level. */
function effortLevels(config, selection) {
    const model = modelConfigForRef(config, selection.providerId, selection.modelId);
    if (model?.parameterErrors?.effortOptions)
        return undefined;
    return normalizeModelThinkingEffortOptions(model?.thinking?.effortOptions)?.filter((option) => option !== 'default');
}
/** The single fixed window a model without `contextWindowOptions` offers, if it has one. */
function fixedContextWindow(model) {
    return model.limit?.context === undefined ? [] : [model.limit.context];
}
/**
 * The context windows a model declares, or `undefined` when it declares none that can be pinned.
 * Mirrors what the managed model application accepts (`validateManagedContext`): it takes
 * `contextWindowOptions` when the model has the field at all and otherwise the single fixed
 * `limit.context`, and rejects any pinned window outside that set — and rejects every pinned
 * window at all when the model's context options are themselves broken. A model that declares
 * nothing therefore cannot take a pinned window, rather than taking any.
 */
function declaredContextWindows(model) {
    if (!model || model.parameterErrors?.contextOptions)
        return undefined;
    const declared = model.contextWindowOptions ?? fixedContextWindow(model);
    const usable = declared.filter((value) => Number.isSafeInteger(value) && Number(value) > 0);
    return usable.length > 0 ? usable : undefined;
}
/**
 * The selection with Bunny's default effort when it carries none. A chosen effort, a selection
 * that turns thinking off, or a model without (valid) effort options is returned unchanged.
 */
function withDefaultEffort(config, selection, end) {
    if (selection.thinking?.effort?.trim() || turnsThinkingOff(selection))
        return selection;
    const levels = effortLevels(config, selection);
    if (!levels?.length)
        return selection;
    const effort = end === 'lowest' ? levels.at(0) : levels.at(-1);
    return effort ? { ...selection, thinking: { ...selection.thinking, effort } } : selection;
}
/**
 * The selection at the effort Apollo pinned, when the model really offers that level. An effort the
 * model does not offer — including `default`, which is not a level, and any effort at all on a
 * model whose effort options are themselves broken — is reported and leaves Bunny's own rule in
 * place; a selection that already carries an effort, or turns thinking off, is never touched.
 */
function withRemoteEffort(context, selection, effort, end) {
    const { config, target, logger } = context;
    if (effort === undefined)
        return withDefaultEffort(config, selection, end);
    if (selection.thinking?.effort?.trim() || turnsThinkingOff(selection))
        return selection;
    const levels = effortLevels(config, selection);
    if (!levels?.includes(effort)) {
        logger.warn({
            event: 'bunny_remote_default_effort_unsupported',
            target,
            providerId: selection.providerId,
            modelId: selection.modelId,
            effort,
            ...(levels ? { effortOptions: levels } : {}),
        }, "Apollo's Bunny default effort is not a level this model offers; Bunny's own rule applies");
        return withDefaultEffort(config, selection, end);
    }
    logger.info({
        event: 'bunny_remote_default_effort_applied',
        target,
        providerId: selection.providerId,
        modelId: selection.modelId,
        effort,
    }, "Bunny's default thinking effort comes from Apollo");
    return { ...selection, thinking: { ...selection.thinking, effort } };
}
/**
 * The selection pinned to the context window Apollo named. Only a window the model itself declares
 * is pinned; anything else is reported and ignored, leaving the model's own window. A window the
 * model does not declare is rejected further down — the managed model application validates
 * `context_limit` against the declared set and throws for anything outside it, including on a
 * model that declares none — and that rejection would take the whole default, model and effort
 * included, down with it.
 */
function withRemoteContextWindow(context, selection, contextWindow) {
    if (contextWindow === undefined || selection.contextLimit !== undefined)
        return selection;
    const { config, target, logger } = context;
    const model = modelConfigForRef(config, selection.providerId, selection.modelId);
    const declared = declaredContextWindows(model);
    if (!declared?.includes(contextWindow)) {
        logger.warn({
            event: 'bunny_remote_default_context_window_unsupported',
            target,
            providerId: selection.providerId,
            modelId: selection.modelId,
            contextWindow,
            ...(declared ? { contextWindowOptions: declared } : { contextWindowOptions: null }),
        }, "Apollo's Bunny default context window is not one this model offers; the model's own window applies");
        return selection;
    }
    logger.info({
        event: 'bunny_remote_default_context_window_applied',
        target,
        providerId: selection.providerId,
        modelId: selection.modelId,
        contextWindow,
    }, "Bunny's default context window comes from Apollo");
    return { ...selection, contextLimit: contextWindow };
}
/**
 * The model a session without a model of its own runs on, picked the way Turn preparation picks
 * it: a retired alias or model becomes its replacement, which keeps none of the old parameters.
 */
function runtimeDefaultModel(config) {
    const configured = parseSourceQualifiedModelKey(config.defaultModel);
    if (!configured)
        return undefined;
    const identity = { providerId: configured.providerId, modelId: configured.modelId };
    const legacy = resolveLegacyMinimaxModel(config, identity);
    const current = legacy ?? identity;
    const outcome = resolveModelReplacement({ config, ...current, preset: getRuntimePresetKey() });
    if (outcome.kind === 'replaced')
        return { ...outcome.model };
    if (legacy)
        return { ...legacy };
    return {
        ...identity,
        ...(config.defaultModelVariant !== undefined ? { variant: config.defaultModelVariant } : {}),
        ...(config.defaultModelContextWindow !== undefined
            ? { contextLimit: config.defaultModelContextWindow }
            : {}),
    };
}
/**
 * The Apollo-named default for this target, or `undefined` when Apollo sent nothing usable: absent,
 * not a `provider/model` reference, or naming a model this Runtime cannot run right now. Every
 * rejection is reported so a rollout that silently reaches nobody stays visible; the caller then
 * falls back to the built-in default, which is exactly how a build without this feature behaves.
 *
 * "Cannot run" is the answer the dispatch gate's own availability check gives, not merely "has no
 * catalog entry": a model the user disabled, and every model of a provider that is disabled or
 * withdrawn, still has an entry here and is refused on the same grounds task creation refuses it.
 * Choosing such a default would turn a rollout into a failing dispatch instead of a fallback, so
 * it is dropped like any other unusable one — with its effort and context window, which belong to
 * the model Apollo named.
 *
 * The gate is not reproduced in full, and deliberately so. It skips availability entirely for
 * `custom_provider` routes, and it applies a second resolver stage — BYOK entry, API key, base URL
 * — that only a live credential check can answer. A model Apollo names that has a catalog entry but
 * no working credential on this machine is therefore still pinned here, exactly as it was before
 * this check existed.
 *
 * A model that cannot be used takes its effort and context window down with it: both belong to the
 * model Apollo named, and the built-in default is a different one.
 */
function remoteBaseModel(config, remote, target, logger) {
    const raw = target === 'main' ? remote?.defaultModel : remote?.defaultTaskModel;
    if (raw === undefined)
        return undefined;
    const parsed = parseSourceQualifiedModelKey(raw.model.trim());
    if (!parsed) {
        logger.warn({ event: 'bunny_remote_default_model_invalid', target, value: raw.model }, "Apollo's Bunny default model is not a provider/model reference; the built-in default applies");
        return undefined;
    }
    const { providerId, modelId } = parsed;
    const availability = resolveModelAvailability({
        config,
        providerId,
        modelId,
        preset: getRuntimePresetKey(),
        source: 'explicit_request',
    });
    // The catalog entry is still required: the effort levels and context windows read below come
    // from it, and a model without one cannot be described even where the route would accept it.
    if (!availability.available || !modelConfigForRef(config, providerId, modelId)) {
        logger.warn({
            event: 'bunny_remote_default_model_unavailable',
            target,
            providerId,
            modelId,
            ...(availability.available ? {} : { reason: availability.code }),
        }, "Apollo's Bunny default model is not available on this Runtime; the built-in default applies");
        return undefined;
    }
    logger.info({ event: 'bunny_remote_default_model_applied', target, providerId, modelId }, "Bunny's default model comes from Apollo");
    return {
        base: { providerId, modelId },
        ...(raw.effort === undefined ? {} : { effort: raw.effort }),
        ...(raw.contextWindow === undefined ? {} : { contextWindow: raw.contextWindow }),
    };
}
/**
 * The model a task Bunny dispatches runs on: the given one (named by Bunny or saved in its
 * settings), else Apollo's default when it is usable, else the Runtime default — at the effort
 * Apollo pinned when it named a level the model offers, at the highest level otherwise, and at the
 * context window Apollo pinned when the model offers it. `undefined` keeps following the Runtime
 * default, as when there is no effort to add; a model Apollo named is always returned concretely.
 */
export function withBunnyTaskEffort(config, selection, remote, logger) {
    // A model Bunny named, or one the user saved, is never replaced by a remote default.
    if (selection)
        return namesModel(selection) ? withDefaultEffort(config, selection, 'highest') : selection;
    const remoteChoice = remoteBaseModel(config, remote, 'task', logger);
    const fallback = remoteChoice?.base ?? runtimeDefaultModel(config);
    if (!fallback)
        return undefined;
    if (!remoteChoice) {
        // Only the Runtime default may collapse into "follow the default".
        const chosen = withDefaultEffort(config, fallback, 'highest');
        return chosen === fallback ? undefined : chosen;
    }
    // Apollo's pick has to survive even when the model offers no effort levels and no window.
    const context = { config, target: 'task', logger };
    return withRemoteContextWindow(context, withRemoteEffort(context, fallback, remoteChoice.effort, 'highest'), remoteChoice.contextWindow);
}
/** The model fields a session holds; written only while they are still what was read. */
function modelSnapshot(session) {
    return {
        effectiveModel: session.effectiveModel ?? null,
        effectiveModelVariant: session.effectiveModelVariant ?? null,
        effectiveModelThinking: session.effectiveModelThinking ?? null,
        effectiveModelContextWindow: session.effectiveModelContextWindow ?? null,
        effectiveModelMaxOutputTokens: session.effectiveModelMaxOutputTokens ?? null,
    };
}
/** The selection Bunny's main conversation gets when it has no model of its own, if any. */
function mainConversationDefault(config, remote, logger) {
    const remoteChoice = remoteBaseModel(config, remote, 'main', logger);
    const fallback = remoteChoice?.base ?? runtimeDefaultModel(config);
    if (!fallback)
        return undefined;
    const context = { config, target: 'main', logger };
    const chosen = remoteChoice
        ? withRemoteContextWindow(context, withRemoteEffort(context, fallback, remoteChoice.effort, 'lowest'), remoteChoice.contextWindow)
        : withDefaultEffort(config, fallback, 'lowest');
    // Without a remote default the only reason to write anything is the effort; with one, the model
    // itself has to be pinned even when it offers no effort levels.
    if (chosen === fallback && !remoteChoice)
        return undefined;
    // The same normalization a session created with a requested model gets.
    const resolved = resolveRequestedSessionModel(config, chosen);
    if (!resolved.providerId || !resolved.modelId)
        return undefined;
    if (!remoteChoice && !resolved.thinking?.effort)
        return undefined;
    return { ...resolved, providerId: resolved.providerId, modelId: resolved.modelId };
}
/**
 * Gives Bunny's main conversation the lowest effort of the model it runs on while it has no model
 * of its own (requirement 5.1), or the effort and context window Apollo pinned for that model. The
 * session record is the only place a session's model and effort live: queue admission, Turn
 * preparation and `models/list` all read it, so the default is written there, pinning Apollo's
 * default model when it sent a usable one and the Runtime default model otherwise. A model the user
 * saved for the conversation is never touched, including one saved while this runs:
 * `session.effectiveModel` is the record of that choice, and a session that already carries one —
 * an existing user's, or one this already pinned — is returned unchanged.
 */
export async function withBunnyMainEffort(records, config, session, context) {
    if (!config || session.effectiveModel)
        return session;
    const { logger, remote } = context;
    try {
        const selection = mainConversationDefault(config, remote, logger);
        if (!selection)
            return session;
        return await records.mutateSession(session.sessionId, {
            effectiveModel: formatModelKey(selection.providerId, selection.modelId),
            effectiveModelVariant: selection.variant ?? null,
            effectiveModelThinking: selection.thinking ?? null,
            effectiveModelContextWindow: selection.contextLimit ?? null,
        }, modelSnapshot(session));
    }
    catch (error) {
        logger.warn({
            event: 'bunny_main_effort_skipped',
            sessionId: session.sessionId,
            error: error instanceof Error ? error.message : String(error),
        }, "Bunny's main conversation keeps its current model; the default effort applies next time");
        return session;
    }
}
//# sourceMappingURL=bunny-model-defaults.js.map