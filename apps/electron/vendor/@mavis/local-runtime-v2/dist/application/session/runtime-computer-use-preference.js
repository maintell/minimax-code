import { getRuntimeBuildEnv, getRuntimeRegion } from '@mavis/config';
import { createComputerUseDefaultPreference, } from '../../service/computer-use/index.js';
/** The default Computer Use preference, keyed by the signed-in account and deployment. */
export function composeRuntimeComputerUseDefaultPreference(options) {
    return createComputerUseDefaultPreference({
        preferences: options.computerUsePreferences,
        clientAvailable: Boolean(options.computerUseClient),
        scope: () => {
            const principalId = options.compatibility.plugin.authContextGetter()?.realUserID?.trim();
            return principalId
                ? { principalId, deployment: `${getRuntimeRegion()}-${getRuntimeBuildEnv()}` }
                : undefined;
        },
    });
}
//# sourceMappingURL=runtime-computer-use-preference.js.map