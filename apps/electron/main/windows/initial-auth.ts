import { net } from "electron";
import { requiresInteractiveLogin } from "@mavis/oauth-core";
const signedOutResolver = async () => false;
const CLOUD_PROBE_TIMEOUT_MS = 2_000;
/**
 * A machine can report a local network connection while still being unable to
 * reach the cloud (captive portal, isolated LAN, firewall). `net.isOnline()`
 * alone cannot detect that, so the login gate probes the same Account OAuth
 * host the login flow uses. Any HTTP response — including 4xx/5xx — proves the
 * cloud is reachable; a transport failure or timeout means it is not. We use
 * Electron's `net.fetch` so the probe follows the same Chromium/proxy/VPN
 * path as the real OAuth requests. When the cloud cannot be reached, the login
 * window cannot succeed anyway, so the desktop opens the main surface directly
 * and lets the local runtime start anonymously (it already supports that).
 */
function probeOrigin() {
    const base = (process.env.NEXT_PUBLIC_LOGIN_API_BASE || "https://account.minimax.cn").replace(/\/+$/u, "");
    return `${base}/oauth2/device/code`;
}
async function defaultCloudProbe() {
    // Completely offline: fail fast without issuing a request.
    try { if (!net.isOnline()) return false; }
    catch { return false; }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CLOUD_PROBE_TIMEOUT_MS);
    try {
        // A real OAuth device endpoint answers POST/GET with an HTTP status;
        // reaching any status means the account server is reachable.
        await net.fetch(probeOrigin(), { method: "HEAD", signal: controller.signal });
        return true;
    }
    catch { return false; }
    finally { clearTimeout(timer); }
}
let cloudProbe = defaultCloudProbe;
/** Override the reachability detector (used by the branch checks). */
export function configureCloudProbe(probe) {
    cloudProbe = probe ?? defaultCloudProbe;
}
let initialAuthResolver = signedOutResolver;
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
        if (!(await cloudProbe())) return true;
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
