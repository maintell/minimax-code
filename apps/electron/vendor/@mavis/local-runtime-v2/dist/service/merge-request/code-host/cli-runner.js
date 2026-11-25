import { execFile } from 'node:child_process';
/** Keeps glab / gh non-interactive and colour-free while their output is captured. */
const CLI_ENV = {
    GH_PROMPT_DISABLED: '1',
    GH_NO_UPDATE_NOTIFIER: '1',
    GLAB_CHECK_UPDATE: 'false',
    NO_PROMPT: 'true',
    NO_COLOR: '1',
    CLICOLOR: '0',
};
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
/**
 * Runs glab / gh with the runtime's environment. Electron merges the login
 * shell PATH into it before the runtime starts, so Homebrew installs resolve.
 */
export function createCliExec(baseEnv = process.env) {
    return (file, args, options) => new Promise((resolve) => {
        const child = execFile(file, [...args], {
            env: { ...baseEnv, ...CLI_ENV },
            timeout: options.timeoutMs,
            maxBuffer: MAX_OUTPUT_BYTES,
            windowsHide: true,
            encoding: 'utf8',
            killSignal: 'SIGKILL',
        }, (error, stdout, stderr) => {
            resolve(toResult(error, String(stdout ?? ''), String(stderr ?? '')));
        });
        if (options.stdin === undefined)
            return;
        // A CLI that exits before reading it all reports why through its exit status.
        child.stdin?.on('error', () => undefined);
        child.stdin?.end(options.stdin);
    });
}
function toResult(error, stdout, stderr) {
    if (!error)
        return { exitCode: 0, stdout, stderr, timedOut: false, missing: false };
    const failure = error;
    const missing = failure.code === 'ENOENT';
    return {
        exitCode: typeof failure.code === 'number' ? failure.code : null,
        stdout,
        stderr,
        timedOut: !missing && failure.killed === true,
        missing,
    };
}
/**
 * Splits "api --include" output into status line, headers and body. Output
 * without a status line is all body. A redirect followed by the CLI prints one
 * header block per hop; the last one describes the body.
 */
export function parseIncludedResponse(stdout) {
    if (!stdout.startsWith('HTTP/'))
        return { headers: {}, body: stdout };
    const separator = /\r?\n\r?\n/u.exec(stdout);
    const head = separator ? stdout.slice(0, separator.index) : stdout;
    const body = separator ? stdout.slice(separator.index + separator[0].length) : '';
    const [statusLine = '', ...headerLines] = head.split(/\r?\n/u);
    const status = Number(/^HTTP\/\S+\s+(\d{3})/u.exec(statusLine)?.[1]);
    if (status >= 300 && status < 400 && body.startsWith('HTTP/'))
        return parseIncludedResponse(body);
    const headers = {};
    for (const line of headerLines) {
        const colon = line.indexOf(':');
        if (colon <= 0)
            continue;
        headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
    }
    return { ...(Number.isInteger(status) ? { status } : {}), headers, body };
}
export class CodeHostRequestError extends Error {
    kind;
    /** For `rate_limited`: how long the platform asked to wait, when it said. */
    retryAfterMs;
    /**
     * The HTTP status when the request reached the platform. A write reads it to
     * tell its refusals apart: GitLab answers 409 both for a merge whose head moved
     * and for a branch that already has a merge request.
     */
    httpStatus;
    platformMessage;
    constructor(kind, message, waitMs, answer = {}) {
        super(message);
        this.name = 'CodeHostRequestError';
        this.kind = kind;
        if (waitMs !== undefined)
            this.retryAfterMs = waitMs;
        if (answer.httpStatus !== undefined)
            this.httpStatus = answer.httpStatus;
        if (answer.platformMessage !== undefined)
            this.platformMessage = answer.platformMessage;
    }
}
const AUTH_HINT = /not logged in|not been authenticated|not authenticated|auth login|no token|token .*invalid|bad credentials|\b401\b/iu;
/** Whether CLI output reads like a missing or rejected login. */
export function looksUnauthenticated(text) {
    return AUTH_HINT.test(text);
}
/** glab prints this warning on every run when it finds two config files. */
const GLAB_CONFIG_NOISE = /Multiple config files found|^\s*Using:|^\s*Ignoring:|Consider consolidating/u;
/**
 * Maps a CLI run onto a failure kind. Returns undefined when the request
 * reached the platform and came back 2xx: a GraphQL error body is the
 * caller's to read even though the CLI then exits non-zero.
 */
export function classifyCliFailure(result, response, nowMs) {
    if (result.missing)
        return new CodeHostRequestError('cli_missing', 'CLI not found on PATH');
    if (result.timedOut)
        return new CodeHostRequestError('timeout', 'The request timed out');
    const message = summarizeStderr(result.stderr);
    if (response?.status === undefined)
        return classifyExitFailure(result, message);
    return classifyHttpFailure(response, response.status, message, nowMs);
}
const HTTP_FAILURE_KINDS = {
    401: 'not_authenticated',
    403: 'forbidden',
    404: 'not_found',
    408: 'timeout',
};
/** GitHub's secondary rate limits answer 403 with these words, and often a wait to honour. */
const SECONDARY_LIMIT = /secondary rate limit|abuse detection/iu;
/** A 429, or a GitHub 403 that is a rate limit rather than a missing permission. */
function isRateLimited(response, status) {
    if (status === 429)
        return true;
    if (status !== 403)
        return false;
    const { headers } = response;
    return (headers['x-ratelimit-remaining'] === '0' ||
        headers['retry-after'] !== undefined ||
        SECONDARY_LIMIT.test(response.body));
}
function classifyHttpFailure(response, status, message, nowMs) {
    if (isRateLimited(response, status)) {
        return new CodeHostRequestError('rate_limited', 'The platform rate-limited this account', retryAfterMs(response.headers, nowMs));
    }
    if (status < 400)
        return undefined;
    const platformMessage = readPlatformMessage(response.body);
    // Any other 4xx is the platform refusing this request; a 5xx is its own failure.
    return new CodeHostRequestError(HTTP_FAILURE_KINDS[status] ?? (status < 500 ? 'invalid' : 'upstream'), message || `HTTP ${String(status)}`, undefined, { httpStatus: status, ...(platformMessage ? { platformMessage } : {}) });
}
const PLATFORM_MESSAGE_CHARS = 500;
/**
 * The platform's own words in an error body. GitLab puts them in "message" as
 * a string, a list, or errors per field, or in "error_description"; GitHub puts
 * a summary in "message" and the details in "errors". The CLIs print only part
 * of this: gh drops the details of a 422.
 * @internal Exported only for focused tests.
 */
export function readPlatformMessage(body) {
    const record = parseObject(body);
    if (!record)
        return undefined;
    const summary = messageTexts(record['message'] ?? record['error_description'] ?? record['error']).join('; ');
    const details = (Array.isArray(record['errors']) ? record['errors'] : [])
        .flatMap(errorText)
        .join('; ');
    const text = [summary, details].filter((part) => part.length > 0).join(': ');
    return text ? text.slice(0, PLATFORM_MESSAGE_CHARS) : undefined;
}
function parseObject(body) {
    try {
        const parsed = JSON.parse(body);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed
            : undefined;
    }
    catch {
        return undefined;
    }
}
/** A message string, a list of them, or GitLab's errors per field ("title can't be blank"). */
function messageTexts(value, field) {
    if (typeof value === 'string')
        return value ? [field ? `${field} ${value}` : value] : [];
    if (Array.isArray(value))
        return value.flatMap((item) => messageTexts(item, field));
    if (value && typeof value === 'object')
        return Object.entries(value).flatMap(([key, item]) => messageTexts(item, key));
    return [];
}
/** One of GitHub's "errors": a string, an object with a message, or a field and a code. */
function errorText(item) {
    if (typeof item === 'string')
        return item ? [item] : [];
    if (!item || typeof item !== 'object')
        return [];
    const record = item;
    const message = record['message'];
    if (typeof message === 'string' && message)
        return [message];
    const parts = [record['field'], record['code']].filter((part) => typeof part === 'string' && part.length > 0);
    return parts.length > 0 ? [parts.join(' ')] : [];
}
/** No HTTP status line: the CLI failed before or without reaching the platform. */
function classifyExitFailure(result, message) {
    if (result.exitCode === 0)
        return undefined;
    if (AUTH_HINT.test(result.stderr))
        return new CodeHostRequestError('not_authenticated', message);
    return new CodeHostRequestError('upstream', message || `The CLI exited with ${String(result.exitCode)}`);
}
/** Reads Retry-After (seconds) or a reset timestamp (epoch seconds) into a delay. */
export function retryAfterMs(headers, nowMs) {
    const seconds = Number(headers['retry-after']);
    if (Number.isFinite(seconds) && seconds >= 0)
        return Math.max(1_000, seconds * 1_000);
    const reset = Number(headers['x-ratelimit-reset'] ?? headers['ratelimit-reset']);
    if (Number.isFinite(reset) && reset > 0)
        return Math.max(1_000, reset * 1_000 - nowMs);
    return undefined;
}
/** The CLI's own one-line error, without glab's config-file warning. */
export function summarizeStderr(stderr) {
    const lines = stderr
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter((line) => line && !GLAB_CONFIG_NOISE.test(line));
    return (lines.at(-1) ?? '').slice(0, 300);
}
//# sourceMappingURL=cli-runner.js.map