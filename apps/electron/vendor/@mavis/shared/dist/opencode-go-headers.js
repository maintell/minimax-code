import { MINIMAX_CODE_USER_AGENT } from './minimax-code-user-agent.js';
/** Go routes inference by conversation, independently of prompt cache settings. */
export function withOpenCodeGoHeaders(baseUrl, headers, sessionId) {
    if (!isOpenCodeGoUrl(baseUrl))
        return headers ? { ...headers } : undefined;
    const merged = { ...headers };
    for (const name of Object.keys(merged)) {
        if (name.toLowerCase() === 'x-opencode-session' || name.toLowerCase() === 'user-agent') {
            delete merged[name];
        }
    }
    // Runtime identity wins case-insensitively over stale, static config headers.
    // Connectivity requests have no conversation and receive their own identity.
    merged['x-opencode-session'] = sessionId || crypto.randomUUID();
    merged['user-agent'] = MINIMAX_CODE_USER_AGENT;
    return merged;
}
/**
 * Official Go roots. models.dev moved Go from `/zen/go` to per-protocol
 * `/inference/go/*` endpoints; both still require a session header, and
 * saved providers may keep either root.
 */
const OPENCODE_GO_PATH_ROOTS = ['/zen/go', '/inference/go'];
function isOpenCodeGoUrl(value) {
    if (!value)
        return false;
    try {
        const url = new URL(value);
        return (url.protocol === 'https:' &&
            url.hostname === 'opencode.ai' &&
            OPENCODE_GO_PATH_ROOTS.some((root) => url.pathname === root || url.pathname.startsWith(`${root}/`)));
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=opencode-go-headers.js.map