/**
 * Read the referenced session out of a user message.
 *
 * Mirrors `packages/ui/src/mentions/session-reference.ts`, which serialises the
 * block the user picks in the composer.
 */
import { isRecord, readString } from './values.js';
const REFERENCE_PATTERN = /<session-reference>([^\n]*?)<\/session-reference>/gu;
export function readSessionReferenceTarget(content) {
    if (typeof content !== 'string' || !content.includes('<session-reference>'))
        return undefined;
    for (const match of content.matchAll(REFERENCE_PATTERN)) {
        const id = sessionIdOfReferenceJson(match[1]);
        if (id)
            return { sessionId: id };
    }
    return undefined;
}
function sessionIdOfReferenceJson(raw) {
    if (!raw)
        return undefined;
    try {
        const value = JSON.parse(raw);
        return isRecord(value) ? readString(value.id) : undefined;
    }
    catch {
        return undefined;
    }
}
//# sourceMappingURL=session-reference.js.map