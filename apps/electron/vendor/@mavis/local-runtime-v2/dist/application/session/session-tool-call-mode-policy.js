import { currentBetaResolutionContext, resolveBetaFeature } from '@mavis/config';
/**
 * `beta.ptc` from the same config the Turn builder reads (Desktop and TUI alike), resolved with
 * the build facts `getConfig()` uses: an unset value follows the build default (on outside the
 * public production build) and an explicit `false` always stays off. The Session system reads it
 * only when a Session is created or has just compacted.
 */
export function createSessionToolCallModePolicy(config, logger) {
    return {
        current: () => resolveBetaFeature('ptc', config().beta?.ptc, currentBetaResolutionContext())
            ? 'ptc'
            : 'native',
        ...(logger ? { logger } : {}),
    };
}
//# sourceMappingURL=session-tool-call-mode-policy.js.map