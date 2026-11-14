import { currentBetaResolutionContext, resolveBetaFeature } from '@mavis/config';
import { lookupLocalModelLimits } from '../../../infra/config/model-catalog.js';
import { AgentModelSelectionError, resolveEffectiveAgentModelSelection, } from './agent-model-selection.js';
const DROPPABLE_PARAMETER = {
    MODEL_EFFORT_UNSUPPORTED: 'effort',
    MODEL_LIMIT_INVALID: 'contextWindow',
    MODEL_LIMIT_UNAVAILABLE: 'contextWindow',
};
/**
 * Whether this build ships the advisor (`beta.advisor`: dev/test and internal builds only).
 * A product config carries the value it resolved for its package; one without it (a bare
 * runtime config) resolves for this process, the same way `getConfig()` would.
 */
export function isAdvisorReleased(config) {
    return (config.beta?.advisor ?? resolveBetaFeature('advisor', undefined, currentBetaResolutionContext()));
}
/**
 * Single source of truth for whether a stored advisor is usable and with which limits, read
 * the way the main model's selection is (reads fall back, saves validate strictly). It resolves
 * with the same catalog and route rules as an Agent model, without reading credentials. An
 * effort or window the model no longer accepts falls back to the model default instead of
 * disabling the advisor; only an unusable model leaves no advisor. Writes keep the strict
 * {@link validateAdvisorModel}. Never throws. A build without the advisor reads every stored
 * one as none, so no Turn offers the tool and every listing shows it off.
 */
export function readAdvisorSelection(config, stored) {
    if (!isAdvisorReleased(config))
        return { selection: { enabled: false }, dropped: [] };
    let selection = stored;
    const dropped = [];
    const model = stored.model;
    if (!model)
        return { selection, dropped };
    for (;;) {
        try {
            const advisor = validateAdvisorModel(config, { ...selection, model });
            return { selection, dropped, ...(selection.enabled ? { advisor } : {}) };
        }
        catch (error) {
            const parameter = error instanceof AgentModelSelectionError ? DROPPABLE_PARAMETER[error.code] : undefined;
            if (!parameter || !hasParameter(selection, parameter)) {
                return { selection, dropped, failure: selectionFailure(error) };
            }
            selection = withoutParameter(selection, parameter);
            dropped.push(parameter);
        }
    }
}
function hasParameter(selection, parameter) {
    return parameter === 'effort'
        ? selection.thinking?.effort !== undefined
        : selection.contextWindow !== undefined;
}
function withoutParameter(selection, parameter) {
    const { thinking, contextWindow, ...rest } = selection;
    return {
        ...rest,
        ...(parameter === 'effort' || thinking === undefined ? {} : { thinking }),
        ...(parameter === 'contextWindow' || contextWindow === undefined ? {} : { contextWindow }),
    };
}
function selectionFailure(error) {
    return error instanceof AgentModelSelectionError
        ? { code: error.code, message: error.message }
        : { code: 'UNKNOWN', message: error instanceof Error ? error.message : String(error) };
}
/**
 * The strict form of {@link readAdvisorSelection} for selection writes: the same resolution, but
 * an unusable model, effort or window throws the catalog's `AgentModelSelectionError`.
 */
export function validateAdvisorModel(config, selection) {
    const effort = selection.thinking?.effort;
    const resolved = resolveEffectiveAgentModelSelection({
        config,
        sources: [
            {
                source: 'session-advisor',
                selection: {
                    model: selection.model,
                    ...(effort === undefined ? {} : { effort }),
                    ...(selection.contextWindow === undefined
                        ? {}
                        : { contextWindow: selection.contextWindow }),
                },
                requireCatalog: true,
            },
        ],
    });
    if (!resolved) {
        throw new AgentModelSelectionError('MODEL_SELECTION_INCOMPLETE', 'No advisor model selected.');
    }
    return withLimitFallback(resolved);
}
/** Catalog limits first; otherwise the same global fallback the local model resolver uses. */
function withLimitFallback(resolved) {
    const fallback = lookupLocalModelLimits(resolved.providerId, resolved.modelId);
    return {
        providerId: resolved.providerId,
        modelId: resolved.modelId,
        ...(resolved.effort === undefined ? {} : { effort: resolved.effort }),
        contextWindow: resolved.contextWindow ?? fallback.contextWindow,
        maxOutputTokens: resolved.maxOutputTokens ?? fallback.maxTokens,
    };
}
//# sourceMappingURL=advisor-selection.js.map