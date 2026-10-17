import { validateLookupName } from '../domain/names.js';
export async function readAgentGreetingState(repository, exactOwnerName) {
    const meta = await repository.get(validateLookupName(exactOwnerName));
    if (!meta)
        return undefined;
    return {
        greetingSent: meta.greetingSent,
        ...(meta.rootSessionId === undefined ? {} : { rootSessionId: meta.rootSessionId }),
    };
}
export function markAgentGreetingSent(repository, exactOwnerName, nowMs) {
    return repository.update(validateLookupName(exactOwnerName), {
        greetingSent: true,
        updatedAtMs: nowMs,
    });
}
//# sourceMappingURL=greeting-state.js.map