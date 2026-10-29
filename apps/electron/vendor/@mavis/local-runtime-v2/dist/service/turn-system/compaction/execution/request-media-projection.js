import { keepsRequestImages } from '@mavis/agent-core/pi-turn-runner';
import { boundRequestMedia, resolveRequestMediaBudget } from '@mavis/context-manager';
/**
 * The request-only image limit applied to every image, user or tool, before
 * model projection, on models that do not cache by prefix. History is
 * untouched; dropped images become placeholders. Prefix-cached models keep
 * every image so their requests stay byte-identical.
 *
 * Both the main request (request media guard hook) and the shared-prefix
 * checkpoint request use this one projection, so the checkpoint repeats the
 * image placeholders the main request already sent and keeps its prefix.
 */
export function projectRequestMedia(input) {
    if (keepsRequestImages(input.model))
        return { messages: [...input.messages], omittedCount: 0 };
    return boundRequestMedia(input.messages, resolveRequestMediaBudget(input));
}
//# sourceMappingURL=request-media-projection.js.map