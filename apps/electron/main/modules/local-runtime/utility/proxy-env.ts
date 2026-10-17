/**
 * Network egress env for the utility-process runtime (proposal §2.6).
 *
 * The utility's LLM / MCP-HTTP egress runs on the Node stack, which does
 * not see Chromium's proxy settings. MVP approach (explicitly allowed by
 * the proposal): resolve the OS / PAC proxy ONCE at fork time through
 * Chromium (`session.resolveProxy`) and inject it as static env —
 * user-provided proxy env always wins and is left untouched. The
 * VSCode-style per-request resolveProxy broker stays a follow-up if static
 * injection proves insufficient (PAC rules that differ per host are lossy
 * here by design).
 *
 * CA: `NODE_USE_SYSTEM_CA=1` comes from main's bootstrapManagedRuntimeEnv
 * via the inherited fork env (Node 22 native OS trust); `NODE_EXTRA_CA_CERTS`
 * can be layered by users when needed. DNS ipv4first is per-process libuv
 * state and is re-applied inside the utility entry.
 *
 * Loopback never rides a proxy: NO_PROXY/no_proxy always gain localhost
 * entries (note: this env intentionally reaches MCP stdio / hook children
 * spawned by the utility, same as today's in-process behavior).
 */

const PROXY_ENV_KEYS = [
    'HTTPS_PROXY',
    'https_proxy',
    'HTTP_PROXY',
    'http_proxy',
    'ALL_PROXY',
    'all_proxy',
];
const LOOPBACK_NO_PROXY_ENTRIES = ['localhost', '127.0.0.1', '::1'];
/** Probe used for the one-shot PAC/OS proxy resolution. */
const PROXY_PROBE_URL = 'https://www.minimax.io/';
/**
 * Parses a Chromium `resolveProxy` result ("PROXY host:port; DIRECT",
 * "HTTPS host:port", "DIRECT", ...) into a proxy URL, or null for DIRECT.
 */
export function parseFirstProxy(resolution) {
    for (const part of resolution.split(';')) {
        const token = part.trim();
        if (token.toUpperCase().startsWith('PROXY ')) {
            const target = token.slice('PROXY '.length).trim();
            return target ? `http://${target}` : null;
        }
        if (token.toUpperCase().startsWith('HTTPS ')) {
            const target = token.slice('HTTPS '.length).trim();
            return target ? `https://${target}` : null;
        }
    }
    return null;
}
export function hasExplicitProxyEnv(env = process.env) {
    return PROXY_ENV_KEYS.some((key) => {
        const value = env[key];
        return typeof value === 'string' && value.trim().length > 0;
    });
}
/** Merges loopback entries into an existing NO_PROXY value (order-stable). */
export function withLoopbackNoProxy(existing) {
    const entries = [];
    for (const raw of (existing ?? '').split(',')) {
        const entry = raw.trim();
        if (entry && !entries.includes(entry))
            entries.push(entry);
    }
    for (const entry of LOOPBACK_NO_PROXY_ENTRIES) {
        if (!entries.includes(entry))
            entries.push(entry);
    }
    return entries.join(',');
}
/**
 * Builds the proxy-related fork env. `resolver` defaults to Electron's
 * defaultSession and is injectable for tests. Fail-open: resolution errors
 * leave proxy env untouched (loopback NO_PROXY is still applied).
 */
export async function resolveUtilityProxyEnv(resolver, env = process.env, warn = () => { }) {
    const noProxy = withLoopbackNoProxy(env.NO_PROXY ?? env.no_proxy);
    const result = {
        NO_PROXY: noProxy,
        no_proxy: noProxy,
    };
    if (hasExplicitProxyEnv(env))
        return result;
    try {
        const activeResolver = resolver ?? (await defaultSessionResolver());
        if (!activeResolver) {
            warn('utility proxy resolution skipped: no Chromium session available');
            return result;
        }
        const proxyUrl = parseFirstProxy(await activeResolver.resolveProxy(PROXY_PROBE_URL));
        if (proxyUrl) {
            result.HTTPS_PROXY = proxyUrl;
            result.HTTP_PROXY = proxyUrl;
        }
    }
    catch {
        // Fail-open: no proxy injection beats blocking the runtime fork — but a
        // forced-proxy environment needs a trace of why egress went direct.
        warn('utility proxy resolution failed (fail-open, no proxy injected)');
    }
    return result;
}
async function defaultSessionResolver() {
    try {
        const { session } = await import('electron');
        return session.defaultSession;
    }
    catch {
        return null;
    }
}
