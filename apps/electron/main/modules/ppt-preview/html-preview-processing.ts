const QUICKLOOK_LENGTH_PROPERTIES = [
    'top',
    'left',
    'right',
    'bottom',
    'width',
    'height',
    'min-width',
    'max-width',
    'min-height',
    'max-height',
    'font-size',
    'margin',
    'margin-top',
    'margin-right',
    'margin-bottom',
    'margin-left',
    'padding',
    'padding-top',
    'padding-right',
    'padding-bottom',
    'padding-left',
    'border-width',
    'border-top-width',
    'border-right-width',
    'border-bottom-width',
    'border-left-width',
];
const LENGTH_PROPERTY_PATTERN = QUICKLOOK_LENGTH_PROPERTIES.join('|');
const UNITLESS_LENGTH_PATTERN = new RegExp(`(^|[;{\\s])((?:${LENGTH_PROPERTY_PATTERN})\\s*:\\s*)(-?\\d+(?:\\.\\d+)?)(?=\\s*(?:;|}|$))`, 'gi');
const QUICKLOOK_CONTENT_SECURITY_POLICY = [
    "default-src 'none'",
    "script-src 'none'",
    "connect-src 'none'",
    "img-src 'self' file: data: blob:",
    "style-src 'self' file: 'unsafe-inline'",
    "font-src 'self' file: data:",
    "media-src 'self' file: data: blob:",
    "object-src 'none'",
    "frame-src 'none'",
    "worker-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
].join('; ');
const BLOCKED_CONTAINER_ELEMENT_PATTERN = /<(script|iframe|frame|object|applet|webview)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const BLOCKED_ELEMENT_TAG_PATTERN = /<\/?(?:script|iframe|frame|object|embed|applet|webview)\b[^>]*>/gi;
const EVENT_HANDLER_ATTRIBUTE_PATTERN = /\s+on[a-z0-9_-]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+)/gi;
const SRCDOC_ATTRIBUTE_PATTERN = /\s+srcdoc\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+)/gi;
const QUOTED_URL_ATTRIBUTE_PATTERN = /\s+(href|src|xlink:href|action|formaction|poster)\s*=\s*("[^"]*"|'[^']*')/gi;
const UNQUOTED_URL_ATTRIBUTE_PATTERN = /\s+(href|src|xlink:href|action|formaction|poster)\s*=\s*([^\s"'=<>`]+)/gi;
function htmlAttributeValue(tag, name) {
    const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>\u0060]+))`, 'i'));
    return match ? (match[1] ?? match[2] ?? match[3] ?? '') : null;
}
function stripUnsafeMetaElements(html) {
    return html.replace(/<meta\b[^>]*>/gi, (tag) => {
        const httpEquiv = htmlAttributeValue(tag, 'http-equiv')?.trim().toLowerCase();
        return httpEquiv === 'refresh' ||
            httpEquiv === 'content-security-policy' ||
            httpEquiv === 'content-security-policy-report-only'
            ? ''
            : tag;
    });
}
function isExecutableUrl(value) {
    const normalized = value
        .replace(/^['"]|['"]$/g, '')
        .replace(/[\u0000-\u0020\u007f]+/g, '')
        .toLowerCase();
    return (
    // This is a sanitizer comparison, not an executable URL construction.
    // eslint-disable-next-line no-script-url
    normalized.startsWith('javascript:') ||
        normalized.startsWith('vbscript:') ||
        normalized.startsWith('data:text/html'));
}
function stripExecutableUrlAttributes(html) {
    return html
        .replace(QUOTED_URL_ATTRIBUTE_PATTERN, (attribute, _name, value) => isExecutableUrl(String(value)) ? '' : attribute)
        .replace(UNQUOTED_URL_ATTRIBUTE_PATTERN, (attribute, _name, value) => isExecutableUrl(String(value)) ? '' : attribute);
}
function stripExecutableMarkup(html) {
    let sanitized = html;
    let previous = '';
    while (sanitized !== previous) {
        previous = sanitized;
        sanitized = sanitized.replace(BLOCKED_CONTAINER_ELEMENT_PATTERN, '');
    }
    return stripExecutableUrlAttributes(stripUnsafeMetaElements(sanitized)
        .replace(BLOCKED_ELEMENT_TAG_PATTERN, '')
        .replace(/<base\b[^>]*>/gi, '')
        .replace(EVENT_HANDLER_ATTRIBUTE_PATTERN, '')
        .replace(SRCDOC_ATTRIBUTE_PATTERN, ''));
}
function injectContentSecurityPolicy(html) {
    const meta = `<meta http-equiv="Content-Security-Policy" content="${QUICKLOOK_CONTENT_SECURITY_POLICY}">`;
    if (/<head\b[^>]*>/i.test(html)) {
        return html.replace(/<head\b([^>]*)>/i, (head) => `${head}\n${meta}`);
    }
    if (/<html\b[^>]*>/i.test(html)) {
        return html.replace(/<html\b([^>]*)>/i, (root) => `${root}\n<head>${meta}</head>`);
    }
    return `<head>${meta}</head>\n${html}`;
}
function normalizeQuickLookCss(css) {
    return css.replace(UNITLESS_LENGTH_PATTERN, (_match, prefix, property, value) => {
        return `${prefix}${property}${value}px`;
    });
}
export function normalizeQuickLookHtml(html) {
    const sanitizedHtml = stripExecutableMarkup(html);
    const withNormalizedStyleBlocks = sanitizedHtml.replace(/<style\b([^>]*)>([\s\S]*?)<\/style>/gi, (_match, attributes, css) => {
        const cleanedCss = String(css).replace(/&nbsp;/gi, ' ');
        return `<style${attributes}>${normalizeQuickLookCss(cleanedCss)}</style>`;
    });
    const withNormalizedInlineStyles = withNormalizedStyleBlocks.replace(/style="([^"]*)"/gi, (_match, styleValue) => {
        return `style="${normalizeQuickLookCss(String(styleValue))}"`;
    });
    return injectContentSecurityPolicy(withNormalizedInlineStyles);
}
