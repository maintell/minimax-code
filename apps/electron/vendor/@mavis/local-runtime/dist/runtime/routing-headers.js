import { managedBackendRoutingHeaders as buildManagedBackendRoutingHeaders, normalizeManagedBackendRoutingContext, } from '@mavis/agent-tools/desktop';
export function normalizeLocalRuntimeRoutingContext(value, buildEnv = getRawRuntimeBuildEnv()) {
    return normalizeManagedBackendRoutingContext(value, buildEnv);
}
export function managedBackendRoutingHeaders(context, buildEnv = getRawRuntimeBuildEnv()) {
    return buildManagedBackendRoutingHeaders(context, buildEnv);
}
/** Raw build-env gate for managed routing; intentionally has no config fallback. */
export function getRawRuntimeBuildEnv() {
    const value = process.env.MAVIS_BUILD_ENV;
    return value === 'dev' || value === 'test' || value === 'staging' || value === 'prod'
        ? value
        : undefined;
}
//# sourceMappingURL=routing-headers.js.map