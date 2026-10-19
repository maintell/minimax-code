import { isFirstPartyMinimaxMessagesRoute } from '@mavis/config';
export function resolveLocalModelCompatibility(input) {
    const firstPartyMinimaxMessages = isFirstPartyMinimaxMessagesRoute(input.api, input.provider);
    const compat = {
        ...(input.forceAdaptiveThinking ? { forceAdaptiveThinking: true } : {}),
        ...(input.completionsThinkingCompat ?? {}),
        ...(firstPartyMinimaxMessages ? { supportsLongCacheRetention: false } : {}),
    };
    return Object.keys(compat).length > 0 ? compat : undefined;
}
//# sourceMappingURL=model-resolver-compat.js.map