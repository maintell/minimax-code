import { randomUUID } from 'node:crypto';
import { snapshotComputerUseState } from './state.js';
const scopeKey = (scope) => JSON.stringify([scope.principalId, scope.deployment]);
const revocationKey = (scope) => `computer-use.revocation.v2:${scopeKey(scope)}`;
async function readRevocation(preferences, scope) {
    const value = await preferences.get(revocationKey(scope));
    if (value === undefined || value === null)
        return 'initial';
    if (typeof value !== 'string' || !value)
        throw new Error('Invalid Computer Use revocation record');
    return value;
}
/** Only an explicit official-plugin revocation invalidates saved task selections. */
async function revokeComputerUseSelections(preferences, scope) {
    await preferences.set(revocationKey(scope), randomUUID());
}
/** Runtime availability is a gate, never the persistent identity of a selection. */
export async function resolveComputerUseSelection(preferences, input, scope) {
    const state = snapshotComputerUseState();
    const key = `computer-use.session-selection.v2:${scopeKey(scope)}:${input.sessionId}`;
    if (input.selection === false) {
        await preferences.set(key, null);
        return false;
    }
    if (!state.enabled)
        return false;
    const revocation = await readRevocation(preferences, scope);
    const beforeWrite = snapshotComputerUseState();
    if (!beforeWrite.enabled || beforeWrite.lastChangedAtMs !== state.lastChangedAtMs)
        return false;
    if (input.selection === true) {
        await preferences.set(key, { version: 2, revocation });
    }
    const saved = await preferences.get(key);
    const latestRevocation = await readRevocation(preferences, scope);
    const current = snapshotComputerUseState();
    return (current.enabled &&
        current.lastChangedAtMs === state.lastChangedAtMs &&
        latestRevocation === revocation &&
        matchesSelection(saved, revocation));
}
function matchesSelection(saved, revocation) {
    return (saved !== null &&
        typeof saved === 'object' &&
        !Array.isArray(saved) &&
        Reflect.get(saved, 'version') === 2 &&
        Reflect.get(saved, 'revocation') === revocation);
}
/** Other plugins must not revoke Computer Use selections in the same account. */
export function createComputerUsePluginRevocationHandler(preferences) {
    return async (input) => {
        if (input.pluginName === 'computer-use') {
            await revokeComputerUseSelections(preferences, input.scope);
        }
    };
}
//# sourceMappingURL=session-selection.js.map