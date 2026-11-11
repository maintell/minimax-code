import { net } from "electron";
const CLOUD_PROBE_TIMEOUT_MS = 2_000;
/**
 * Single authoritative connectivity decision for the whole main process.
 * `net.isOnline()` only reports a local link; a captive portal or isolated LAN
 * still cannot reach the account servers, so a short `net.fetch` probe to the
 * OAuth host (same Chromium/proxy/VPN path the login flow uses) decides. Any
 * HTTP response means reachable; transport failure or timeout means offline.
 * The result is cached for the process lifetime so every gate agrees and the
 * probe is never paid more than once. Online behaviour is unchanged.
 */
function probeOrigin() {
    const base = (process.env.NEXT_PUBLIC_LOGIN_API_BASE || "https://account.minimax.cn").replace(/\/+$/u, "");
    return `${base}/oauth2/device/code`;
}
async function defaultProbe() {
    try { if (!net.isOnline()) return false; }
    catch { return false; }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CLOUD_PROBE_TIMEOUT_MS);
    try {
        await net.fetch(probeOrigin(), { method: "HEAD", signal: controller.signal });
        return true;
    }
    catch { return false; }
    finally { clearTimeout(timer); }
}
let probe = defaultProbe;
let cachedReachable;
/** Override the reachability detector (used by the branch checks). */
export function configureConnectivityProbe(next) {
    probe = next ?? defaultProbe;
    cachedReachable = undefined;
}
/** Reachability of the cloud, cached. */
export async function isCloudReachable() {
    if (cachedReachable !== undefined) return cachedReachable;
    try { cachedReachable = await probe(); }
    catch { cachedReachable = false; }
    return cachedReachable;
}
/** Convenience: true when the cloud cannot be reached. */
export async function isOffline() {
    return !(await isCloudReachable());
}
/**
 * A COMPLETE synthetic user for offline mode. `useInitFetch` copies these
 * fields into the store / main UI; it must not be a partial object or the main
 * surface dereferences missing userID/membership fields and crashes (the
 * white-screen regression). This is returned at read time by STORAGE_GET_USER,
 * never written to the store, so it never masquerades as a persisted account.
 */
export const OFFLINE_USER_ID = "offline-local";
/**
 * The store keeps the account identity the user last signed in with. While
 * offline the client cannot refresh it, but it must NOT replace it either: the
 * renderer captures that identity at startup and rejects a `getCurrentUser`
 * answer whose `realUserID` differs ("Account identity changed during
 * startup" → `authInitFailed` → the account-unavailable card). A profile that
 * has ever been signed in therefore has to keep its own identity; only a
 * profile with no stored account falls back to the synthetic sentinel.
 */
let identityResolver: (() => Record<string, unknown> | undefined) | null = null;
export function configureOfflineIdentity(resolver: () => Record<string, unknown> | undefined) {
    identityResolver = resolver;
}
const IDENTITY_FIELDS = [
    "userID",
    "realUserID",
    "userName",
    "subUserName",
    "name",
    "userMail",
    "email",
    "userPhone",
    "accountAvatarUrl",
    "accountDefaultAvatarUrl",
    "accountAvatarStatus",
    "webAvatar",
    "subUserAvatar",
    "subUserSocialMediaUrl",
    "deviceID",
] as const;
function storedIdentity() {
    let source: Record<string, unknown> | undefined;
    try {
        source = identityResolver?.();
    }
    catch {
        return {};
    }
    if (!source)
        return {};
    const realUserID = typeof source.realUserID === "string" ? source.realUserID : "";
    const userID = typeof source.userID === "string" ? source.userID : "";
    if (!realUserID && !userID)
        return {};
    // A stored sentinel means this profile never held a real account.
    if (realUserID === OFFLINE_USER_ID || userID === OFFLINE_USER_ID)
        return {};
    const identity: Record<string, string> = {};
    for (const field of IDENTITY_FIELDS) {
        const value = source[field];
        if (typeof value === "string" && value.length > 0)
            identity[field] = value;
    }
    if (!identity.realUserID)
        identity.realUserID = identity.userID;
    if (!identity.userID)
        identity.userID = identity.realUserID;
    if (!identity.userName)
        identity.userName = identity.name ?? "Offline";
    if (!identity.subUserName)
        identity.subUserName = identity.userName;
    if (!identity.name)
        identity.name = identity.userName;
    return identity;
}
export function buildOfflineUser() {
    return {
        userID: OFFLINE_USER_ID,
        realUserID: OFFLINE_USER_ID,
        userName: "Offline",
        subUserName: "Offline",
        userMail: "",
        webAvatar: "",
        subUserAvatar: "",
        accountAvatarUrl: "",
        accountDefaultAvatarUrl: "",
        accountAvatarStatus: "unknown",
        subUserSocialMediaUrl: "",
        userPhone: "",
        email: "",
        ...storedIdentity(),
        offline: true,
    };
}
/**
 * Neutral successful response for account/config/bot-list proxy calls that
 * fail at the transport layer while offline. The renderer only needs a 200 +
 * valid JSON empty state so the axios 401 interceptor never re-opens the login
 * gate. This is the SAME envelope handleProxyFetch returns on success.
 */
export function neutralProxyResult(pathname = "") {
    const isUserInfo = /\/v1\/api\/user\/info/u.test(pathname);
    const user = buildOfflineUser();
    // getCurrentUser (module 22668) is `let {data:e}=await ZP.get("/v1/api/user/info"); return e.data`
    // and useInitFetch.d() destructures {userInfo} from it. The exact envelope
    // nesting varies by axios adapter, so expose userInfo at both levels plus
    // a success base_resp; every bootstrap parser then finds a complete user.
    const userInfoBody = {
        userInfo: user,
        data: { userInfo: user, base_resp: { status_code: 0 } },
        base_resp: { status_code: 0 },
    };
    const configBody = {
        data: {},
        base_resp: { status_code: 0 },
    };
    return {
        ok: true,
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/json" },
        data: isUserInfo ? userInfoBody : configBody,
    };
}
