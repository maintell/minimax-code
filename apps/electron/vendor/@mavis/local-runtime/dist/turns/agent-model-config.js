import { modelConfigForRef } from '../model-provider/list-models.js';
import { modelRefForModel } from './model-ref.js';
function parseModelKey(modelKey) {
    const raw = modelKey?.trim();
    if (!raw) {
        throw new Error('defaultModel is not configured');
    }
    const slash = raw.indexOf('/');
    if (slash <= 0 || slash === raw.length - 1) {
        throw new Error(`Invalid model key "${raw}". Expected provider/model.`);
    }
    return { provider: raw.slice(0, slash), modelId: raw.slice(slash + 1) };
}
// Exported for tests: the source-aware modelRef assembly is the turn contract.
export function modelRefFromConfig(config, override, options = {}) {
    const overrideProvider = override?.provider_id?.trim() || undefined;
    const overrideModelId = override?.model_id?.trim() || undefined;
    const resolved = overrideProvider && overrideModelId
        ? { provider: overrideProvider, modelId: overrideModelId }
        : (() => {
            const base = parseModelKey(config.defaultModel);
            return {
                provider: overrideProvider ?? base.provider,
                modelId: overrideModelId ?? base.modelId,
            };
        })();
    return modelRefForModel(resolved.provider, resolved.modelId, modelConfigForRef(config, resolved.provider, resolved.modelId), override ? override.variant : config.defaultModelVariant, override?.thinking, options.implicitCustomProviderThinking === true);
}
//# sourceMappingURL=agent-model-config.js.map