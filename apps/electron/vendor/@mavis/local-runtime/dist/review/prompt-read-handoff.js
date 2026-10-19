import { randomUUID } from 'node:crypto';
/** Reserves the child Turn before submission so preflight consumes its rendered snapshot. */
export function reserveReviewPromptRead(promptRead, registry) {
    const requestedTurnId = `turn_review_${randomUUID()}`;
    if (!promptRead)
        return { requestedTurnId };
    if (!registry?.reserve(requestedTurnId))
        return undefined;
    return { requestedTurnId, promptRead, registry };
}
export function rememberReviewPromptRead(handoff) {
    if ('registry' in handoff)
        handoff.registry.remember(handoff.requestedTurnId, handoff.promptRead);
}
export function rebindReviewPromptRead(handoff, turnId) {
    if ('registry' in handoff && handoff.requestedTurnId !== turnId) {
        handoff.registry.rebind(handoff.requestedTurnId, turnId);
    }
}
export function discardReviewPromptRead(handoff, turnId) {
    if ('registry' in handoff)
        handoff.registry.discard(turnId);
}
//# sourceMappingURL=prompt-read-handoff.js.map