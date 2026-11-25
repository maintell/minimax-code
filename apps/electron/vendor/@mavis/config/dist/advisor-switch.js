import { currentBetaResolutionContext, getRuntimePresetKey, resolveBetaFeature } from './config.js';
import { resolveAdvisorEnabled } from './advisor-config.js';
/**
 * Whether this build ships the advisor (`beta.advisor`: on in every channel by default; an
 * explicit `beta.advisor: false` turns it off).
 * A product config carries the value it resolved for its package; one without it (a bare
 * runtime config) resolves for this process, the same way `getConfig()` would.
 */
export function isAdvisorReleasedInConfig(config) {
    return (config.beta?.advisor ?? resolveBetaFeature('advisor', undefined, currentBetaResolutionContext()));
}
/**
 * The global advisor switch every advisor read obeys: off in a build without the advisor, else
 * the user's `advisor.enabled`, else the catalog default. Computed on every read, never stored.
 */
export function resolveAdvisorSwitch(config) {
    return isAdvisorReleasedInConfig(config) && resolveAdvisorEnabled(config, getRuntimePresetKey());
}
/**
 * Fills the effective switch into a config snapshot, so the runtime and the config the settings
 * page reads see one value instead of each re-deriving it.
 */
export function withEffectiveAdvisor(config) {
    return { ...config, advisor: { ...config.advisor, enabled: resolveAdvisorSwitch(config) } };
}
//# sourceMappingURL=advisor-switch.js.map