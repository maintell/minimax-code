/**
 * Write-side trust boundary for a model selection that is about to be stored
 * on a Session or as the Runtime default.
 *
 * The stored key is the only thing a later Turn sees, so it must already be the
 * canonical `<providerId>/<modelId>` the resolver parses. A BYOK provider
 * written without its `custom_provider:` prefix parses as a built-in managed
 * provider and then fails at call time with a credential error
 * (`api_key not configured` / `managed-login requires a known managed
 * base_url`) instead of a clear refusal at the write.
 *
 * The availability asserted here is the same route-aware answer the model list,
 * the DesktopService save entry and the Turn gate use, so the three cannot
 * disagree about what a route may call.
 */
import { getRuntimePresetKey, resolveModelAvailability } from '@mavis/config';
import { canonicalSelectionModelKey } from '../../../service/model-system/index.js';
/**
 * Canonicalizes one selection and refuses it when the route it resolves to
 * cannot call the model. `source: 'explicit_request'` because a write is always
 * an explicit choice, never a default that may be replaced.
 */
export function resolveWritableModelSelection(config, providerId, modelId) {
    const requested = `${providerId.trim()}/${modelId.trim()}`;
    // Same rule the model picker uses, including the legacy bare provider key.
    const canonical = canonicalSelectionModelKey(config, requested, {
        allowCustomProviderPrefixFallback: true,
    });
    if (!canonical) {
        return {
            ok: false,
            code: 'MODEL_SELECTION_INVALID',
            message: `Model selection "${requested}" must use provider/model syntax.`,
        };
    }
    const slash = canonical.indexOf('/');
    const selection = {
        providerId: canonical.slice(0, slash),
        modelId: canonical.slice(slash + 1),
        modelKey: canonical,
    };
    const availability = resolveModelAvailability({
        config,
        providerId: selection.providerId,
        modelId: selection.modelId,
        preset: getRuntimePresetKey(),
        source: 'explicit_request',
    });
    if (availability.available)
        return { ok: true, selection };
    return { ok: false, code: availability.code, message: availability.message };
}
//# sourceMappingURL=model-selection-write.js.map