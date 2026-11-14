/**
 * Predicts, without any request, that a URL will not come back as an HTML page.
 * The server reader only extracts HTML (and PDF), so sending such a URL costs a
 * round trip and then a second fetch on this device. Two signals are available
 * before the request: the path's file extension, and hosts the server already
 * answered `non_html` for. Probing the target itself would be a request of its
 * own, which is what the hint exists to avoid.
 */
/** File types the reader cannot turn into page text. PDF is absent on purpose. */
const NON_HTML_EXTENSIONS = new Set([
    'json',
    'jsonl',
    'ndjson',
    'xml',
    'rss',
    'atom',
    'csv',
    'tsv',
    'txt',
    'md',
    'markdown',
    'yaml',
    'yml',
    'toml',
    'ini',
    'js',
    'mjs',
    'cjs',
    'ts',
    'css',
    'map',
    'wasm',
    'svg',
    'png',
    'jpg',
    'jpeg',
    'gif',
    'webp',
    'avif',
    'ico',
    'bmp',
    'tif',
    'tiff',
    'mp3',
    'mp4',
    'm4a',
    'wav',
    'ogg',
    'webm',
    'mov',
    'zip',
    'gz',
    'tgz',
    'tar',
    'bz2',
    'xz',
    '7z',
    'rar',
    'woff',
    'woff2',
    'ttf',
    'otf',
    'eot',
    'exe',
    'dmg',
    'pkg',
    'msi',
    'deb',
    'rpm',
    'apk',
    'bin',
    'iso',
]);
/** How long a host stays on this device after the server called it non-HTML. */
const NON_HTML_HOST_TTL_MS = 30 * 60_000;
export class NonHtmlHint {
    hostTtlMs;
    now;
    hostsUntilMs = new Map();
    constructor(options = {}) {
        this.hostTtlMs = options.hostTtlMs ?? NON_HTML_HOST_TTL_MS;
        this.now = options.now ?? Date.now;
    }
    predicts(url) {
        const parsed = parseUrl(url);
        if (!parsed)
            return false;
        return hasNonHtmlExtension(parsed.pathname) || this.hostIsRemembered(parsed.hostname);
    }
    /** The server answered `non_html` for this URL; read its host here for a while. */
    remember(url) {
        const host = parseUrl(url)?.hostname;
        if (host)
            this.hostsUntilMs.set(host, this.now() + this.hostTtlMs);
    }
    hostIsRemembered(host) {
        const until = this.hostsUntilMs.get(host);
        if (until === undefined)
            return false;
        if (until > this.now())
            return true;
        this.hostsUntilMs.delete(host);
        return false;
    }
}
function hasNonHtmlExtension(pathname) {
    const lastSegment = pathname.slice(pathname.lastIndexOf('/') + 1);
    const dot = lastSegment.lastIndexOf('.');
    if (dot <= 0)
        return false;
    return NON_HTML_EXTENSIONS.has(lastSegment.slice(dot + 1).toLowerCase());
}
function parseUrl(value) {
    try {
        return new URL(value);
    }
    catch {
        return undefined;
    }
}
//# sourceMappingURL=non-html-hint.js.map