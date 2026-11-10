import { requiresInteractiveLogin } from "@mavis/oauth-core";
import { configureConnectivityProbe, isCloudReachable } from "../modules/connectivity/offline-mode";
const signedOutResolver = async () => false;
let initialAuthResolver = signedOutResolver;
// Backward-compatible alias: the reachability detector now lives in the
// shared connectivity module so every gate uses one cached decision.
export const configureCloudProbe = configureConnectivityProbe;
/**
 * Resolve the initial Desktop surface from the Main-owned auth session.
 * Shared OAuth stays authoritative; the composed session may provide the bounded
 * generation-zero legacy SSO upgrade lease. Only a confirmed missing credential resolves to signed out.
 */
export async function resolveSharedOAuthAuthState(source) {
    // Cloud unreachable: the login window cannot succeed, so skip it. Both the
    // startup surface decision and the renderer's checkAuthStatus IPC go
    // through this function, so one check serves both.
    try {
        if (!(await isCloudReachable())) return true;
    }
    catch { return true; }
    try {
        const lease = await source.getAccessToken(30000);
        return lease.accessToken.trim().length > 0;
    }
    catch (error) {
        if (requiresInteractiveLogin(error))
            return false;
        throw error;
    }
}
export function configureInitialAuthResolver(resolver) {
    initialAuthResolver = resolver ?? signedOutResolver;
}
export async function resolveInitialAuthState() {
    try {
        return await initialAuthResolver();
    }
    catch {
        // The app surface reports unavailable authentication and offers a retry.
        return undefined;
    }
}
