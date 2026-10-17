import { messagesTokenCounterAdapter } from './messages.js';
import { kimiEstimateTokenCountAdapter, zhipuTokenizerTokenCounterAdapter, } from './openai-chat-tokenizers.js';
import { genericResponsesTokenCounterAdapter, minimaxResponsesTokenCounterAdapter, } from './responses.js';
/** First match wins: source-specific adapters must precede generic protocols. */
export const DEFAULT_REMOTE_TOKEN_COUNTER_ADAPTERS = Object.freeze([
    minimaxResponsesTokenCounterAdapter,
    zhipuTokenizerTokenCounterAdapter,
    kimiEstimateTokenCountAdapter,
    genericResponsesTokenCounterAdapter,
    messagesTokenCounterAdapter,
]);
export function resolveRemoteTokenCounterAdapter(ctx, adapters = DEFAULT_REMOTE_TOKEN_COUNTER_ADAPTERS) {
    return adapters.find((adapter) => adapter.matches(ctx));
}
//# sourceMappingURL=registry.js.map