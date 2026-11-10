import { getRuntimeBuildEnv } from './config.js';
/**
 * A developer build: NODE_ENV=development with the test build env. Gates local-only debugging
 * paths (unsigned model-access package import); never true in a release.
 */
export function isDevelopmentBuild() {
    return process.env.NODE_ENV === 'development' && getRuntimeBuildEnv() === 'test';
}
//# sourceMappingURL=development-build.js.map