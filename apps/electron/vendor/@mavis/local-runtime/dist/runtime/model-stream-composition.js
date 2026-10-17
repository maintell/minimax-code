import { withByokErrorAttribution } from './byok-error-attribution.js';
import { withLocalDynamicMaxTokens, } from './dynamic-max-tokens.js';
export function composeLocalModelStream(streamFn, dynamicMaxTokensState, sessionId, byokProviderId, fetchImpl) {
    const dynamicStreamFn = withLocalDynamicMaxTokens(streamFn, dynamicMaxTokensState, sessionId);
    const attributedStreamFn = byokProviderId
        ? withByokErrorAttribution({ streamFn: dynamicStreamFn, providerId: byokProviderId })
        : dynamicStreamFn;
    return fetchImpl ? withFetch(attributedStreamFn, fetchImpl) : attributedStreamFn;
}
function withFetch(inner, fetchImpl) {
    return ((model, context, options) => inner(model, context, {
        ...(options ?? {}),
        fetch: options?.fetch ?? fetchImpl,
    }));
}
//# sourceMappingURL=model-stream-composition.js.map