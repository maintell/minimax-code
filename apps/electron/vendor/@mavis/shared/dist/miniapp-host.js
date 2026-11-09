export const MINIAPP_HOST_ERROR_CODES = Object.freeze([
    'invalid_request',
    'not_permitted',
    'host_unavailable',
    'unsupported_source',
    'unsupported_target',
    'target_unavailable',
    'result_unknown',
]);
/** Manifest `hostAccess` entries. UI preferences and user-activated opens need no observation grant. */
export const MINIAPP_HOST_ACCESS_ITEMS = ['navigation.read'];
export function isMiniAppHostAccess(value) {
    return MINIAPP_HOST_ACCESS_ITEMS.some((item) => item === value);
}
export function isMiniAppHostErrorCode(value) {
    return MINIAPP_HOST_ERROR_CODES.includes(value);
}
function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
const VIEWS = ['home', 'conversation', 'plugins', 'schedule', 'other'];
function parseView(value) {
    return VIEWS.includes(value) ? value : null;
}
function readOverlay(value) {
    if (value === null)
        return null;
    return isRecord(value) && value.type === 'settings' ? { type: 'settings' } : undefined;
}
/** Rebuilds the public allowlist so extra Host or page metadata cannot cross the boundary. */
export function parseMiniAppHostUIState(value) {
    if (!isRecord(value))
        return null;
    const { theme, language } = value;
    return (theme === 'light' || theme === 'dark') &&
        typeof language === 'string' &&
        language.length > 0 &&
        language.length <= 64 &&
        /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/u.test(language)
        ? { theme, language }
        : null;
}
export function parseMiniAppHostNavigationState(value) {
    if (!isRecord(value))
        return null;
    const { key } = value;
    const view = parseView(value.view);
    const overlay = readOverlay(value.overlay);
    return typeof key === 'string' &&
        key.length > 0 &&
        key.length <= 256 &&
        view &&
        overlay !== undefined
        ? { key, view, overlay }
        : null;
}
export function parseMiniAppHostPublishedState(value) {
    if (!isRecord(value))
        return null;
    const ui = parseMiniAppHostUIState(value.ui);
    if (ui && value.navigation === null)
        return { ui, navigation: null };
    if (!isRecord(value.navigation))
        return null;
    const { context } = value.navigation;
    const view = parseView(value.navigation.view);
    const overlay = readOverlay(value.navigation.overlay);
    return ui &&
        typeof context === 'string' &&
        context.length > 0 &&
        context.length <= 8192 &&
        view &&
        overlay !== undefined
        ? { ui, navigation: { context, view, overlay } }
        : null;
}
/** Reject paths, URLs and cross-Runtime fallbacks; keep source errors separate from malformed input. */
export function readMiniAppHostOpenTarget(value) {
    if (!isRecord(value) || typeof value.id !== 'string')
        return { success: false, code: 'invalid_request' };
    const exact = (keys) => Object.keys(value).every((key) => keys.includes(key));
    if (value.id === 'home' || value.id === 'plugins' || value.id === 'schedule') {
        return exact(['id'])
            ? { success: true, target: { id: value.id } }
            : { success: false, code: 'invalid_request' };
    }
    if (value.id === 'settings') {
        if (!exact(['id', 'section']))
            return { success: false, code: 'invalid_request' };
        if (value.section === undefined)
            return { success: true, target: { id: 'settings' } };
        return value.section === 'appearance' || value.section === 'language'
            ? { success: true, target: { id: 'settings', section: value.section } }
            : { success: false, code: 'unsupported_target' };
    }
    if (value.id === 'session') {
        if (!exact(['id', 'sessionId', 'source']) ||
            typeof value.sessionId !== 'string' ||
            !value.sessionId.trim() ||
            value.sessionId.length > 256 ||
            /[\u0000-\u001f\u007f]/u.test(value.sessionId)) {
            return { success: false, code: 'invalid_request' };
        }
        if (typeof value.source !== 'string')
            return { success: false, code: 'invalid_request' };
        if (value.source !== 'local')
            return { success: false, code: 'unsupported_source' };
        return {
            success: true,
            target: { id: 'session', sessionId: value.sessionId, source: 'local' },
        };
    }
    return { success: false, code: 'unsupported_target' };
}
export function parseMiniAppHostOpenTarget(value) {
    const read = readMiniAppHostOpenTarget(value);
    return read.success ? read.target : null;
}
export function parseMiniAppHostOpenResult(value) {
    if (!isRecord(value))
        return null;
    if (value.status === 'opened')
        return { status: 'opened' };
    return value.status === 'cancelled' &&
        (value.reason === 'user_cancelled' || value.reason === 'superseded')
        ? { status: 'cancelled', reason: value.reason }
        : null;
}
function parseFailure(value) {
    return value.success === false && isMiniAppHostErrorCode(value.code)
        ? { success: false, code: value.code }
        : null;
}
export function parseMiniAppHostUIResponse(value) {
    if (!isRecord(value))
        return null;
    const state = value.success === true ? parseMiniAppHostUIState(value.state) : null;
    return state ? { success: true, state } : parseFailure(value);
}
export function parseMiniAppHostNavigationResponse(value) {
    if (!isRecord(value))
        return null;
    const state = value.success === true ? parseMiniAppHostNavigationState(value.state) : null;
    return state ? { success: true, state } : parseFailure(value);
}
export function parseMiniAppHostOpenResponse(value) {
    if (!isRecord(value))
        return null;
    const result = value.success === true ? parseMiniAppHostOpenResult(value.result) : null;
    return result ? { success: true, result } : parseFailure(value);
}
//# sourceMappingURL=miniapp-host.js.map