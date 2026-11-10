import { hasThinkingPrefixBinding } from '@mavis/agent-core/pi-turn-runner';
import { boundRequestMedia, resolveRequestMediaBudget } from '@mavis/context-manager';
/**
 * The request-only image limit applied to every image, user or tool, before
 * model projection, on models whose thinking is not bound to the request
 * prefix. History is untouched; dropped images become placeholders.
 * Prefix-bound models keep every image so their requests stay byte-identical.
 *
 * It is one step of the main request's request projection (see
 * `request-projection.ts`), which the shared-prefix checkpoint request repeats,
 * so the checkpoint carries the image placeholders the main request already sent.
 */
export function projectRequestMedia(input) {
    if (hasThinkingPrefixBinding(input.model)) {
        return { messages: [...input.messages], omittedCount: 0 };
    }
    return boundRequestMedia(input.messages, resolveRequestMediaBudget(input));
}
//# sourceMappingURL=request-media-projection.js.map