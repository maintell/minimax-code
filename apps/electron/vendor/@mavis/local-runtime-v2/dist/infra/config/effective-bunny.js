import { productionBetaResolutionContext, resolveBunnyEnabledState, withEffectiveBunny, } from '@mavis/config';
import { incrementMetric } from '../logging/metrics.js';
/**
 * Fills the effective Bunny beta switch into a host's config read boundary:
 * its getter and its updater's answer. Bunny's background owners and the
 * GET/PUT `/config` answers all read these two, so every reader sees one value.
 * The signed-in user decides the Apollo allowlist / rollout bucket; without one
 * the switch falls back to the release package's build variant, then the
 * Apollo default, then the build default. `buildVariant` carries a package
 * identity the process env does not (the TUI's internal package); omitted
 * fields read the process build facts.
 *
 * With a metrics client, `bunny_enabled_state_total{enabled, source}` counts the
 * first resolved state and every later change; repeated reads of an unchanged
 * state do not count again.
 */
export function withEffectiveBunnyConfig(boundary) {
    const reportState = createBunnyEnabledStateReporter(boundary.metricsClient);
    const effective = (config) => {
        const userId = boundary.getUserId?.();
        const remote = boundary.getBunnyPolicy?.();
        const context = {
            ...(config.productionParity === true ? productionBuild() : boundary.buildVariant),
            ...(userId ? { userId } : {}),
        };
        reportState(() => resolveBunnyEnabledState(config.bunny?.enabled, remote, context));
        return withEffectiveBunny(config, remote, context);
    };
    return {
        configGetter: () => effective(boundary.configGetter()),
        configUpdater: async (body) => {
            const result = await boundary.configUpdater(body);
            return { ...result, config: effective(result.config) };
        },
    };
}
/** Under `productionParity` Bunny takes a public production package's default and missing policy. */
function productionBuild() {
    const { buildEnv, internalBuild, insideBuild } = productionBetaResolutionContext();
    return { buildEnv, internalBuild, insideBuild };
}
function createBunnyEnabledStateReporter(metrics) {
    if (!metrics)
        return () => { };
    let last;
    return (resolve) => {
        try {
            const state = resolve();
            const key = `${state.enabled}:${state.source}`;
            if (key === last)
                return;
            last = key;
            incrementMetric(metrics, 'bunny_enabled_state_total', 1, {
                enabled: state.enabled ? 'true' : 'false',
                source: state.source,
            });
        }
        catch {
            // Metrics are observational only; the config read must not fail.
        }
    };
}
//# sourceMappingURL=effective-bunny.js.map