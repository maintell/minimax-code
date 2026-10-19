/** Read the managed-routing gate without a config fallback. */
export function getRawRuntimeBuildEnv() {
    const value = process.env.MAVIS_BUILD_ENV;
    return value === 'dev' || value === 'test' || value === 'staging' || value === 'prod'
        ? value
        : undefined;
}
//# sourceMappingURL=routing-context.js.map