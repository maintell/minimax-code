import { isComputerUseEnabled } from './state.js';
const preferenceKey = (scope) => `computer-use.conversation-default.v1:${JSON.stringify([scope.principalId, scope.deployment])}`;
export class ComputerUsePreferenceError extends Error {
    code;
    constructor(code) {
        super(`Computer Use preference: ${code}`);
        this.code = code;
    }
}
export async function readComputerUseDefault(preferences, scope) {
    return (await preferences.get(preferenceKey(scope))) === true;
}
export async function clearComputerUseDefault(preferences, scope) {
    await preferences.set(preferenceKey(scope), null);
}
/** The profile owns the DB; account and deployment own each preference key. */
export function createComputerUseDefaultPreference(input) {
    const available = () => input.clientAvailable && isComputerUseEnabled();
    const requireScope = () => {
        const scope = input.scope();
        if (!scope)
            throw new ComputerUsePreferenceError('SCOPE_UNAVAILABLE');
        return scope;
    };
    const checkScope = (scope) => {
        const current = input.scope();
        if (current?.principalId !== scope.principalId || current.deployment !== scope.deployment)
            throw new ComputerUsePreferenceError('SCOPE_CHANGED');
    };
    return {
        async get() {
            const scope = requireScope();
            const enabled = await readComputerUseDefault(input.preferences, scope);
            checkScope(scope);
            return { enabled, available: available() };
        },
        async set(enabled) {
            const scope = requireScope();
            if (!available())
                throw new ComputerUsePreferenceError('UNAVAILABLE');
            await input.preferences.set(preferenceKey(scope), enabled);
            checkScope(scope);
            const saved = await readComputerUseDefault(input.preferences, scope);
            checkScope(scope);
            return { enabled: saved, available: available() };
        },
    };
}
//# sourceMappingURL=default-preference.js.map