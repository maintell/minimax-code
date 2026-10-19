import { requiresInteractiveLogin } from "@mavis/oauth-core";
const signedOutResolver = async () => false;
let initialAuthResolver = signedOutResolver;
/**
 * Resolve the initial Desktop surface from the Main-owned auth session.
 * Shared OAuth stays authoritative; the composed session may provide the bounded
 * generation-zero legacy SSO upgrade lease. Only a confirmed missing credential resolves to signed out.
 */
export async function resolveSharedOAuthAuthState(source) {
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
