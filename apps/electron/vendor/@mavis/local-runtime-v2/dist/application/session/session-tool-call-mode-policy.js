import { resolveEffectivePtc } from '@mavis/config';
/**
 * `beta.ptc` from the same config the Turn builder reads (Desktop and TUI alike), resolved with
 * the build facts `getConfig()` uses: an unset value follows the build default (on outside the
 * public production build) and an explicit value always wins. The Session system reads it only
 * when a Session is created or has just compacted.
 */
export function createSessionToolCallModePolicy(config, logger, options = {}) {
    const { ptcDefault, metrics } = options;
    return {
        current: () => {
            ptcDefault?.retryCohortWrite();
            return resolveEffectivePtc(config());
        },
        ...(logger ? { logger } : {}),
        ...(metrics ? { metrics } : {}),
    };
}
//# sourceMappingURL=session-tool-call-mode-policy.js.map