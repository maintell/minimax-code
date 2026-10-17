/**
 * OpenCode conversion wrapper around the Session-owned legacy history normalizer.
 *
 * The caller must pass only rows produced by the current OpenCode migration round. Active or
 * mixed pi-agent history must never be sanitized.
 */
import { normalizeLegacyHistoryForMessages, } from '../../messages/history/legacy-history-normalizer.js';
export function sanitizePiHistoryForMessages(messages, options = {}) {
    const result = normalizeLegacyHistoryForMessages(messages, {
        message: (value) => value,
        replaceAssistantContent: (value, content) => ({ ...value, content }),
    }, options);
    return {
        messages: [...result.items],
        warnings: [...result.warnings],
        stats: result.stats,
    };
}
//# sourceMappingURL=pi-history-sanitizer.js.map