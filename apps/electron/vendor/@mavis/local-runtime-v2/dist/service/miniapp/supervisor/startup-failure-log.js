import path from 'node:path';
import { isSensitiveObservabilityKey, sanitizeObservabilityText, } from '@mavis/shared/local-runtime-diagnostics/redaction';
import { isSecretKey, redactSecretText } from '@mavis/shared/logging/redact-log-secret';
import { boundMiniAppRuntimeErrorText, MINIAPP_RUNTIME_ERROR_TEXT_MAX_BYTES, readMiniAppRuntimeErrorDetail, } from '../errors.js';
const UNCONVERTIBLE_ERROR = 'Runtime startup error could not be converted to text';
// A fixed code-unit check runs before any text scan. Host-attached details fit
// this budget already; oversized fallback strings are omitted whole, never
// sliced into potentially orphaned credential fragments.
const MAX_SCAN_CODE_UNITS = MINIAPP_RUNTIME_ERROR_TEXT_MAX_BYTES;
const CAPTURE_TRUNCATION = /\[\.\.\. [\w ]+ truncated from \d+ bytes(?:; showing last \d+ bytes)? \.\.\.\]/u;
const KEY_PREFIX = /(?<![\w.-])(["']?)([\w.-]+)\1\s*[:=]\s*/gu;
const PRIVATE_KEY_BEGIN = /-----BEGIN ((?:RSA |DSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY|PGP PRIVATE KEY BLOCK)-----/gu;
const CREDENTIAL_HEADER = /\b((?:proxy-authorization|authorization|set-cookie|cookie)\s*[:=]\s*)[^\r\n]*/giu;
// Quotes, brackets, punctuation and spaces are all legal directory characters.
// Once an absolute path begins, only a newline safely ends its private fragment.
const FILE_URL = /\bfile:\/\/[^\r\n]+/giu;
const WINDOWS_PATH = /\b[A-Za-z]:[\\/][^\r\n]+|\\\\[^\r\n]+/gu;
const POSIX_PATH = /(?<![\w:/\\>])\/[^\r\n]+/gu;
/** A detached, bounded log projection; raw Host detail remains in memory only. */
export function miniAppStartupFailureLogDetail(error) {
    let detail;
    try {
        detail = readMiniAppRuntimeErrorDetail(error);
    }
    catch {
        // An arbitrary error can have throwing getters. Diagnostics never replace it.
    }
    return {
        errorText: sanitizeText(detail?.errorText ?? fallbackErrorText(error), 'runtime error text'),
        ...(detail?.stderr !== undefined
            ? { stderr: sanitizeText(detail.stderr, 'runtime stderr') }
            : {}),
    };
}
function sanitizeText(text, label) {
    if (text.length > MAX_SCAN_CODE_UNITS) {
        return `[${label} omitted: exceeds diagnostic text scan limit]`;
    }
    // Capture has already removed context around its retained tail. A credential
    // fragment there cannot safely be identified by any key/value redactor.
    if (CAPTURE_TRUNCATION.test(text)) {
        return `[${label} omitted: captured text was truncated]`;
    }
    const credentialsRemoved = redactSecretText(sanitizeObservabilityText(redactCredentialValues(redactPrivateKeyBlocks(text).replace(CREDENTIAL_HEADER, '$1****'))));
    const pathsRemoved = credentialsRemoved
        .replace(FILE_URL, privatePathLabel)
        .replace(WINDOWS_PATH, privatePathLabel)
        .replace(POSIX_PATH, privatePathLabel);
    return boundMiniAppRuntimeErrorText(pathsRemoved, label);
}
/** Consume each complete key once; credential matching never retries inside it. */
function redactCredentialValues(text) {
    const parts = [];
    let copiedThrough = 0;
    for (const match of text.matchAll(KEY_PREFIX)) {
        const key = match[2] ?? '';
        if (match.index < copiedThrough || !(isSecretKey(key) || isSensitiveObservabilityKey(key))) {
            continue;
        }
        const start = match.index + match[0].length;
        parts.push(text.slice(copiedThrough, start), '****');
        copiedThrough = credentialValueEnd(text, start);
    }
    parts.push(text.slice(copiedThrough));
    return parts.join('');
}
function redactPrivateKeyBlocks(text) {
    const parts = [];
    let copiedThrough = 0;
    for (const match of text.matchAll(PRIVATE_KEY_BEGIN)) {
        if (match.index < copiedThrough)
            continue;
        const closing = `-----END ${match[1] ?? ''}-----`;
        const closingIndex = text.indexOf(closing, match.index + match[0].length);
        parts.push(text.slice(copiedThrough, match.index), '[REDACTED_PRIVATE_KEY]');
        copiedThrough = closingIndex < 0 ? text.length : closingIndex + closing.length;
    }
    parts.push(text.slice(copiedThrough));
    return parts.join('');
}
function credentialValueEnd(text, start) {
    const quote = text.charAt(start);
    if (quote === '{' || quote === '[')
        return structuredCredentialValueEnd(text, start);
    return quote === '"' || quote === "'"
        ? quotedCredentialValueEnd(text, start, quote)
        : unquotedCredentialValueEnd(text, start);
}
function structuredCredentialValueEnd(text, start) {
    let depth = 0;
    let end = start;
    while (end < text.length) {
        const character = text.charAt(end);
        if (character === '"' || character === "'") {
            end = quotedCredentialValueEnd(text, end, character);
            continue;
        }
        if (character === '{' || character === '[')
            depth += 1;
        if (character === '}' || character === ']')
            depth -= 1;
        end += 1;
        if (depth === 0)
            return end;
    }
    return end;
}
function unquotedCredentialValueEnd(text, start) {
    let end = start;
    while (end < text.length && !/[\s"',;}&\]#)]/u.test(text.charAt(end)))
        end += 1;
    return end;
}
function quotedCredentialValueEnd(text, start, quote) {
    let end = start + 1;
    while (end < text.length) {
        const character = text.charAt(end);
        if (character === quote)
            return end + 1;
        end += character === '\\' ? 2 : 1;
    }
    return Math.min(end, text.length);
}
function privatePathLabel(value) {
    let pathname = value;
    if (/^file:\/\//iu.test(value)) {
        try {
            pathname = decodeURIComponent(new URL(value).pathname);
        }
        catch {
            // A malformed URL is still private; retain only its final path component.
            pathname = value.replace(/[?#].*$/u, '');
        }
    }
    const basename = path.posix.basename(pathname.replace(/\\/gu, '/'));
    return basename ? `<path>/${basename}` : '<path>';
}
function fallbackErrorText(error) {
    try {
        if (error instanceof Error) {
            const stack = safeStackText(error);
            if (stack !== undefined)
                return stack;
            const name = safeErrorProperty(error, 'name') ?? 'Error';
            const message = safeErrorProperty(error, 'message');
            return message === undefined ? UNCONVERTIBLE_ERROR : `${name}: ${message}`;
        }
        return typeof error === 'string' ? error : String(error);
    }
    catch {
        return UNCONVERTIBLE_ERROR;
    }
}
function safeStackText(error) {
    try {
        const stack = error.stack;
        if (stack === undefined)
            return undefined;
        if (typeof stack === 'string')
            return stack;
        return String(stack);
    }
    catch {
        // Fall back to name/message even when a custom stack cannot be read.
        return undefined;
    }
}
function safeErrorProperty(error, key) {
    try {
        const value = error[key];
        return typeof value === 'string' ? value : undefined;
    }
    catch {
        return undefined;
    }
}
//# sourceMappingURL=startup-failure-log.js.map