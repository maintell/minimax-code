import { splitModelId } from './host-helpers.js';
export function modelSelectionFromSession(session) {
    if (!session?.effectiveModel)
        return undefined;
    const [providerId, modelId] = splitModelId(session.effectiveModel);
    if (!providerId || !modelId)
        return undefined;
    return {
        providerId,
        modelId,
        ...(session.effectiveModelVariant !== undefined
            ? { variant: session.effectiveModelVariant }
            : {}),
        ...(session.effectiveModelThinking !== undefined
            ? { thinking: session.effectiveModelThinking }
            : {}),
    };
}
/**
 * Inspect a `PUT /config` body to see whether it could have switched the
 * runtime into `acceptEdits` mode. Matches the two body shapes accepted by
 * `applyLocalConfigUpdate`:
 *   1. `{ field: 'permissionMode', set: 'acceptEdits' }`
 *   2. `{ permissionMode: 'acceptEdits', ... }` (bulk patch)
 *
 * False positives are harmless; `syncAcceptEditsSeed()` is idempotent.
 */
export function mayHaveSetAcceptEditsMode(body) {
    if (body.field === 'permissionMode' && body.set === 'acceptEdits')
        return true;
    if (body.permissionMode === 'acceptEdits')
        return true;
    return false;
}
//# sourceMappingURL=host-model-helpers.js.map