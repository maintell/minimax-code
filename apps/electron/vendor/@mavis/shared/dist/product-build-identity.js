export function resolveProductBuildIdentity(options = {}) {
    const isInternalBuild = options.internalBuild === true;
    const isInsideBuild = options.insideBuild === true;
    if (isInternalBuild && isInsideBuild) {
        throw new Error('A product build cannot be both internal and inside');
    }
    const buildEnv = normalizeProductBuildEnvironment(options.buildEnv);
    const variant = isInsideBuild
        ? 'inside'
        : isInternalBuild
            ? 'internal'
            : 'standard';
    return {
        buildEnv,
        variant,
        isDev: buildEnv === 'dev',
        isTest: buildEnv === 'test',
        isStaging: buildEnv === 'staging',
        isProd: buildEnv === 'prod',
        isInternalBuild,
        isInsideBuild,
    };
}
export function normalizeProductBuildEnvironment(buildEnv) {
    if (buildEnv === 'development')
        return 'dev';
    if (buildEnv === 'production')
        return 'prod';
    if (buildEnv === 'dev' || buildEnv === 'test' || buildEnv === 'staging' || buildEnv === 'prod') {
        return buildEnv;
    }
    return undefined;
}
//# sourceMappingURL=product-build-identity.js.map