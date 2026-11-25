import { getBetaDefaultBuildEnvironment, getRuntimeBuildEnv, isInsideBuild, isInternalBuild, } from './config.js';
/**
 * The build facts `parseBetaConfig` resolves every flag with in this process. A caller holding a
 * raw (unparsed) config should prefer {@link betaResolutionContextFor}, which also honours
 * `productionParity` and so resolves a flag exactly as `getConfig()` would.
 */
export function currentBetaResolutionContext() {
    return {
        buildEnv: getRuntimeBuildEnv(),
        defaultBuildEnvironment: getBetaDefaultBuildEnvironment(),
        internalBuild: isInternalBuild(),
        insideBuild: isInsideBuild(),
        mcodeToolsDevMode: process.env.MAVIS_DEV_MCODE_TOOLS_MODE === 'published' ? 'published' : undefined,
    };
}
/**
 * The build facts of a public production install on this platform: no internal or test channel
 * defaults and no build-variant defaults. A flag set in config.yaml still applies within what
 * production allows.
 */
export function productionBetaResolutionContext() {
    return {
        buildEnv: 'prod',
        defaultBuildEnvironment: 'prod',
        internalBuild: false,
        insideBuild: false,
    };
}
/**
 * The build facts a config's flags resolve with: a public production install under
 * `productionParity`, which Internal and test builds turn on to check an upcoming release, and
 * this process otherwise. Every reader that computes a build default goes through it, so
 * `getConfig()`, the PTC default and Bunny agree.
 */
export function betaResolutionContextFor(config) {
    return config.productionParity === true
        ? productionBetaResolutionContext()
        : currentBetaResolutionContext();
}
//# sourceMappingURL=beta-resolution-context.js.map