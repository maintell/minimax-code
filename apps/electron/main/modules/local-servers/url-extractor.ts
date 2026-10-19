/**
 * Pure helpers for detecting local dev server URLs in terminal output.
 * No Electron imports so the module stays unit-testable.
 */

// CSI sequences (colors, cursor moves) and OSC sequences (titles, hyperlinks).
const ANSI_CSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const ANSI_OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
export function stripAnsi(text) {
    return text.replace(ANSI_OSC_RE, '').replace(ANSI_CSI_RE, '');
}
const LOCAL_URL_RE = /(https?):\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d{1,5})?(?=[/\s'"`)\],;]|$)/gi;
/**
 * Extract normalized local server origins (e.g. "http://localhost:5173")
 * from a chunk of terminal output. Hosts are normalized to `localhost`
 * because 0.0.0.0/[::1] are bind addresses, not navigable hosts.
 */
export function extractLocalServerOrigins(text) {
    const clean = stripAnsi(text);
    const origins = new Set();
    for (const match of clean.matchAll(LOCAL_URL_RE)) {
        const scheme = match[1].toLowerCase();
        const port = match[3] ?? '';
        const defaultPort = scheme === 'http' ? ':80' : ':443';
        const normalizedPort = port === defaultPort ? '' : port;
        origins.add(`${scheme}://localhost${normalizedPort}`);
    }
    return Array.from(origins);
}
