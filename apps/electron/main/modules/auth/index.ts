import { resolveMCodeOAuthEndpointConfig, createMCodeAuthManager } from "@mavis/oauth-core";
import { DesktopAuthSession } from "./desktop-auth-session.js";
import { resolveElectronNetFetch } from "../local-runtime/electron-net-fetch.js";
export function createDesktopAuthSession(options, createSession = createDesktopAuthSessionFromCore) {
    return createSession({
        ...options,
        buildEnv: normalizeDesktopOAuthBuildEnv(options.buildEnv),
    });
}
function normalizeDesktopOAuthBuildEnv(buildEnv) {
    return buildEnv === 'dev' ? 'test' : buildEnv;
}
function createDesktopAuthSessionFromCore(options) {
    const endpoints = resolveMCodeOAuthEndpointConfig(options.endpointEnvironment, {
        buildEnv: options.buildEnv,
        region: options.region,
    });
    const core = createMCodeAuthManager({
        dataDir: options.dataDir,
        buildEnv: options.buildEnv,
        region: options.region,
        endpoints,
        fetchImpl: resolveElectronNetFetch(),
    });
    return new DesktopAuthSession(core, options.legacySource, undefined, options.identitySource);
}
export { DesktopAuthSession } from "./desktop-auth-session.js";

export { startDesktopAuthLeaseBroker } from "./lease-broker.js";

