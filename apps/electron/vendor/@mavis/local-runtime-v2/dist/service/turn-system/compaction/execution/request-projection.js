import { projectRequestMedia, } from './request-media-projection.js';
export function createMainRequestProjection(filterMessages) {
    const filter = (sessionId, messages) => filterMessages?.(sessionId, messages) ?? messages;
    return {
        hooks: [createRequestFilterHook(filter), createRequestMediaGuardHook()],
        project: (input) => projectRequestMedia({ ...input, messages: filter(input.sessionId, input.messages) }).messages,
    };
}
function createRequestFilterHook(filter) {
    return (input) => {
        const messages = filter(input.sessionId, input.messages);
        return messages.length === input.messages.length
            ? { type: 'continue' }
            : {
                type: 'replaceRequestMessages',
                messages: [...messages],
                reason: 'internal-context-filter',
            };
    };
}
/**
 * Request-only image limit for every image, user or tool, on models whose
 * thinking is not bound to the request prefix. Runs after compaction, so its
 * placeholders never reach durable history. A repeated request needs nothing
 * more: compaction has already moved every image out of history. Prefix-bound
 * models skip it, so their requests stay byte-identical until a compaction
 * replaces the history.
 */
function createRequestMediaGuardHook() {
    return (input) => {
        const { messages, omittedCount } = projectRequestMedia(input);
        return omittedCount === 0
            ? { type: 'continue' }
            : { type: 'replaceRequestMessages', messages, reason: 'request-media-guard' };
    };
}
//# sourceMappingURL=request-projection.js.map