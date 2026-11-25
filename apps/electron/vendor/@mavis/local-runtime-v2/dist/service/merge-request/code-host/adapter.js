import { CodeHostRequestError, looksUnauthenticated, retryAfterMs, summarizeStderr, } from './cli-runner.js';
import { mergeRequestKey } from './urls.js';
/** Failed jobs a pipeline summary carries; the IDL promises at most this many. */
export const FAILED_JOBS_LIMIT = 10;
export function emptyHostQueryResult() {
    return {
        mergeRequests: new Map(),
        branches: new Map(),
        details: new Map(),
        missingProjects: new Set(),
    };
}
export function mergeHostQueryResults(results) {
    const merged = emptyHostQueryResult();
    const times = results.flatMap((result) => result.fetchedAtMs === undefined ? [] : [result.fetchedAtMs]);
    for (const result of results) {
        for (const [key, value] of result.mergeRequests)
            merged.mergeRequests.set(key, value);
        for (const [key, value] of result.branches)
            merged.branches.set(key, value);
        for (const [key, value] of result.details)
            merged.details.set(key, value);
        for (const key of result.missingProjects)
            merged.missingProjects.add(key);
    }
    return times.length > 0 ? { ...merged, fetchedAtMs: Math.min(...times) } : merged;
}
export function branchKey(projectKeyValue, branch) {
    return `${projectKeyValue}#${branch}`;
}
/** Splits a list into chunks of at most `size` items. */
export function chunk(items, size) {
    const chunks = [];
    for (let index = 0; index < items.length; index += size)
        chunks.push(items.slice(index, index + size));
    return chunks;
}
/**
 * Packs items into groups whose costs add up to at most `limit`, in order. An
 * item costing more than the limit gets a group of its own.
 */
export function packByCost(items, cost, limit) {
    const groups = [];
    let current = [];
    let total = 0;
    for (const item of items) {
        const itemCost = cost(item);
        if (current.length > 0 && total + itemCost > limit) {
            groups.push(current);
            current = [];
            total = 0;
        }
        current.push(item);
        total += itemCost;
    }
    if (current.length > 0)
        groups.push(current);
    return groups;
}
/** Runs one query through "<cli> api graphql" and returns its data object. */
export async function runGraphql(call, host, query, nowMs) {
    const document = typeof query === 'string' ? { query, variables: {} } : query;
    const head = ['api', '--include', '--hostname', host];
    const { result, response } = isLong(document.variables)
        ? await call([...head, '--method', 'POST', '-H', JSON_BODY, 'graphql', '--input', '-'], {
            include: true,
            stdin: JSON.stringify(document),
        })
        : await call([...head, 'graphql', '-f', `query=${document.query}`, ...fieldArgs(document.variables)], { include: true });
    let parsed;
    try {
        parsed = JSON.parse(response?.body ?? result.stdout);
    }
    catch {
        throw new CodeHostRequestError('upstream', 'The platform returned a response that is not JSON');
    }
    const record = asRecord(parsed);
    const errors = asArray(record?.['errors']).flatMap((item) => {
        const error = asRecord(item);
        const message = asString(error?.['message']);
        if (!message)
            return [];
        const type = asString(error?.['type']);
        return [type ? { message, type } : { message }];
    });
    const rateLimited = errors.find((error) => error.type === 'RATE_LIMITED');
    if (rateLimited) {
        throw new CodeHostRequestError('rate_limited', rateLimited.message, retryAfterMs(response?.headers ?? {}, nowMs));
    }
    const data = asRecord(record?.['data']);
    if (!data) {
        throw new CodeHostRequestError('upstream', errors[0]?.message ?? 'The platform returned no data');
    }
    return { data, errors };
}
/** GitHub error types that keep their meaning when a mutation fails. */
const GRAPHQL_ERROR_KINDS = {
    FORBIDDEN: 'forbidden',
    INSUFFICIENT_SCOPES: 'forbidden',
    NOT_FOUND: 'not_found',
};
/** GitLab answers a mutation the account may not make with this, without an error type. */
const GITLAB_NO_ACCESS = /does not exist or you don't have permission/iu;
/**
 * The payload of a mutation, or the failure the platform reported instead:
 * GitHub's error types and GitLab's "errors" list both become a
 * CodeHostRequestError carrying the platform's words.
 */
export function mutationPayload(outcome, field, fallback = 'upstream') {
    const payload = asRecord(outcome.data[field]);
    const payloadErrors = asArray(payload?.['errors']).flatMap((item) => {
        const message = asString(item);
        return message ? [{ message }] : [];
    });
    const errors = payload ? payloadErrors : outcome.errors;
    if (payload && errors.length === 0)
        return payload;
    // A payload's own errors are the platform refusing the change as asked, such as a note too long.
    throw graphqlFailure(errors, payload ? 'invalid' : fallback);
}
export function graphqlFailure(errors, fallback) {
    const message = errors.map((error) => error.message).join('; ') || 'The platform did not make the change';
    const typed = errors.find((error) => error.type && GRAPHQL_ERROR_KINDS[error.type]);
    const kind = (typed?.type ? GRAPHQL_ERROR_KINDS[typed.type] : undefined) ??
        (GITLAB_NO_ACCESS.test(message) ? 'forbidden' : fallback);
    return new CodeHostRequestError(kind, message);
}
/**
 * One REST request through "<cli> api". A refusal arrives as the
 * CodeHostRequestError the CLI call raises, with the HTTP status and the
 * platform's words, for relabelFailure to sort out.
 */
export async function callApi(call, request) {
    const fields = request.fields ?? {};
    const head = [
        'api',
        '--include',
        '--hostname',
        request.host,
        '--method',
        request.method ?? 'GET',
    ];
    const { result, response } = isLong(fields)
        ? await call([...head, '-H', JSON_BODY, request.path, '--input', '-'], {
            include: true,
            stdin: JSON.stringify(fields),
        })
        : await call([...head, request.path, ...fieldArgs(fields)], { include: true });
    return response ?? { headers: {}, body: result.stdout };
}
/**
 * Past this many characters of field values a request goes as a JSON body on
 * stdin: a Windows command line holds 32,767 characters in all, and a
 * description or a comment can be longer.
 */
const LONG_FIELDS_CHARS = 8_000;
const JSON_BODY = 'Content-Type: application/json';
function isLong(fields) {
    let length = 0;
    for (const value of Object.values(fields)) {
        if (typeof value === 'string')
            length += value.length;
        else if (Array.isArray(value))
            for (const item of value)
                length += item.length;
    }
    return length > LONG_FIELDS_CHARS;
}
function fieldArgs(fields) {
    return Object.entries(fields).flatMap(([name, value]) => {
        if (typeof value === 'string')
            return ['-f', `${name}=${value}`];
        if (typeof value === 'number' || typeof value === 'boolean')
            return ['-F', `${name}=${String(value)}`];
        return value.flatMap((item) => ['-f', `${name}[]=${item}`]);
    });
}
/** The JSON a REST request answered with. */
export function jsonBody(response) {
    try {
        return JSON.parse(response.body);
    }
    catch {
        throw new CodeHostRequestError('upstream', 'The platform returned a response that is not JSON');
    }
}
/**
 * The failure a write reports: the first rule matching the HTTP status and the
 * platform's words turns the error into its kind, with the platform's words as
 * the message. Any other error passes through unchanged.
 */
export function relabelFailure(error, rules) {
    if (!(error instanceof CodeHostRequestError) || error.httpStatus === undefined)
        return error instanceof Error ? error : new Error(String(error));
    const status = error.httpStatus;
    const words = error.platformMessage ?? error.message;
    const rule = rules.find((candidate) => candidate.statuses.includes(status) && (!candidate.pattern || candidate.pattern.test(words)));
    if (!rule)
        return error;
    return new CodeHostRequestError(rule.kind, words, undefined, {
        httpStatus: status,
        ...(error.platformMessage ? { platformMessage: error.platformMessage } : {}),
    });
}
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const CONTROL_SEQUENCE = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]|${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)`, 'gu');
/** GitLab wraps collapsible log sections in markers such as "section_start:1700000000:build\r". */
const GITLAB_SECTION_MARKER = new RegExp(`section_(?:start|end):\\d+:[^\\r\\n]*?\\r(?:${ESC}\\[0K)?`, 'gu');
const LOG_TAIL_LINES = 400;
const LOG_TAIL_CHARS = 64_000;
/** A full log keeps its last 4 MB (UTF-8), as the IDL promises. */
const LOG_FULL_BYTES = 4 * 1024 * 1024;
/** A CI log as it reads on screen: control sequences removed, progress-bar rewrites collapsed. */
function readableLogLines(raw) {
    const lines = raw
        .replace(GITLAB_SECTION_MARKER, '')
        .replace(CONTROL_SEQUENCE, '')
        .split('\n')
        .map((line) => {
        const content = line.endsWith('\r') ? line.slice(0, -1) : line;
        const rewritten = content.lastIndexOf('\r');
        return rewritten === -1 ? content : content.slice(rewritten + 1);
    });
    while (lines.length > 0 && lines.at(-1) === '')
        lines.pop();
    return lines;
}
/**
 * The readable end of a CI log.
 * @internal Exported only for focused tests.
 */
export function tailLog(raw) {
    let truncated = false;
    let kept = readableLogLines(raw);
    if (kept.length > LOG_TAIL_LINES) {
        kept = kept.slice(-LOG_TAIL_LINES);
        truncated = true;
    }
    let text = kept.join('\n');
    if (text.length > LOG_TAIL_CHARS) {
        text = text.slice(-LOG_TAIL_CHARS);
        truncated = true;
    }
    return { text, truncated };
}
/**
 * The whole readable log, or its last 4 MB starting at a whole line when it is
 * longer.
 * @internal Exported only for focused tests.
 */
export function fullLog(raw) {
    const text = readableLogLines(raw).join('\n');
    const bytes = Buffer.from(text, 'utf8');
    if (bytes.length <= LOG_FULL_BYTES)
        return { text, truncated: false };
    const end = bytes.subarray(bytes.length - LOG_FULL_BYTES).toString('utf8');
    const newline = end.indexOf('\n');
    return { text: newline === -1 ? end : end.slice(newline + 1), truncated: true };
}
export function asRecord(value) {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value
        : undefined;
}
function asArray(value) {
    return Array.isArray(value) ? value : [];
}
export function asString(value) {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}
export function asNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
export function asBoolean(value) {
    return typeof value === 'boolean' ? value : undefined;
}
/** The fields that have a value; a missing value stays absent instead of becoming undefined. */
export function definedFields(fields) {
    return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
}
/** The fields that have a value, or undefined when none has. */
export function someFields(fields) {
    const defined = definedFields(fields);
    return Object.keys(defined).length > 0 ? defined : undefined;
}
/** "nodes" of a GraphQL connection. */
export function nodesOf(connection) {
    return asArray(asRecord(connection)?.['nodes']).flatMap((node) => {
        const record = asRecord(node);
        return record ? [record] : [];
    });
}
/** The objects in a JSON list. */
export function recordsOf(list) {
    return asArray(list).flatMap((item) => {
        const record = asRecord(item);
        return record ? [record] : [];
    });
}
/** The cursor of the next page of a GraphQL connection, when there is one. */
export function nextCursor(connection) {
    const pageInfo = asRecord(asRecord(connection)?.['pageInfo']);
    return pageInfo?.['hasNextPage'] === true ? asString(pageInfo['endCursor']) : undefined;
}
export function parseTimeMs(value) {
    const text = asString(value);
    if (!text)
        return undefined;
    const ms = Date.parse(text);
    return Number.isFinite(ms) ? ms : undefined;
}
/**
 * How much of a comment body the runtime keeps: 64 KB of Markdown. Descriptions stay whole.
 * @internal Exported only for focused tests.
 */
export const NOTE_BODY_LIMIT = 65_536;
/** A note body cut to NOTE_BODY_LIMIT characters; `bodyTruncated` marks a cut. */
export function limitBody(value) {
    const text = asString(value);
    if (!text)
        return {};
    if (text.length <= NOTE_BODY_LIMIT)
        return { body: text };
    return { body: cutText(text, NOTE_BODY_LIMIT), bodyTruncated: true };
}
/** The first `length` characters without splitting a surrogate pair. */
function cutText(text, length) {
    const last = text.charCodeAt(length - 1);
    return text.slice(0, last >= 0xd800 && last <= 0xdbff ? length - 1 : length);
}
/** GraphQL list literal of strings. */
export function gqlStringList(values) {
    return `[${values.map((value) => JSON.stringify(value)).join(', ')}]`;
}
/** Reads a job or check log through the CLI's api command. */
export async function readApiLog(call, source) {
    const { result, response } = await call(['api', '--include', '--hostname', source.host, source.apiPath], { include: true });
    const raw = response?.body ?? result.stdout;
    return { ...(source.full ? fullLog(raw) : tailLog(raw)), webUrl: source.webUrl };
}
/** A file's unified diff from the first hunk on, and the lines it adds and removes. */
export function readPatch(diff) {
    const start = diff.startsWith('@@') ? 0 : diff.indexOf('\n@@') + 1;
    if (start === 0 && !diff.startsWith('@@'))
        return { additions: 0, deletions: 0 };
    const patch = diff.slice(start);
    let additions = 0;
    let deletions = 0;
    for (const line of patch.split('\n')) {
        if (line.startsWith('+'))
            additions += 1;
        else if (line.startsWith('-'))
            deletions += 1;
    }
    return { patch, additions, deletions };
}
/** Link suggestions come in this order of reasons, then most recently updated first. */
const CANDIDATE_RANK = {
    exact: 0,
    mine_in_repository: 1,
    mine: 2,
    review_requested: 3,
    in_repository: 4,
    search: 5,
};
/** Each merge request once, under its strongest reason, in display order. */
export function rankCandidates(candidates) {
    const strongest = new Map();
    for (const candidate of candidates) {
        const key = mergeRequestKey(candidate.ref);
        const known = strongest.get(key);
        if (!known || CANDIDATE_RANK[candidate.reason] < CANDIDATE_RANK[known.reason])
            strongest.set(key, candidate);
    }
    return [...strongest.values()].sort((a, b) => CANDIDATE_RANK[a.reason] - CANDIDATE_RANK[b.reason] ||
        (b.updatedAtMs ?? 0) - (a.updatedAtMs ?? 0));
}
/**
 * The shared shape of a CLI login check: "--version" tells whether the CLI is
 * installed, "auth status --hostname" tells whether this host is logged in. The
 * two CLIs differ only in how they name the account and in the CLI's own name.
 */
export async function probeCli(cli, accountPattern, host, call) {
    const versionRun = await call(['--version'], { raw: true });
    if (versionRun.result.missing)
        return { installed: false, auth: 'unavailable' };
    const version = /(\d+\.\d+\.\d+)/u.exec(versionRun.result.stdout)?.[1];
    const { result } = await call(['auth', 'status', '--hostname', host], { raw: true });
    const text = `${result.stdout}\n${result.stderr}`;
    const base = { installed: true, ...(version ? { version } : {}) };
    if (result.exitCode === 0) {
        const login = accountPattern.exec(text)?.[1];
        return { ...base, auth: 'ready', ...(login ? { accountLogin: login } : {}) };
    }
    if (looksUnauthenticated(text)) {
        return { ...base, auth: 'not_authenticated', message: summarizeStderr(text) };
    }
    return {
        ...base,
        auth: 'unavailable',
        message: result.timedOut ? `${cli} auth status timed out` : summarizeStderr(text),
    };
}
/** Host header lines of "glab auth status" / "gh auth status": unindented host names. */
export function readAuthStatusHosts(text) {
    const hosts = new Set();
    for (const line of text.split(/\r?\n/u)) {
        const match = /^([a-z0-9][a-z0-9.-]*\.[a-z]{2,})(?::\d+)?\s*$/iu.exec(line);
        if (match?.[1])
            hosts.add(match[1].toLowerCase());
    }
    return [...hosts];
}
//# sourceMappingURL=adapter.js.map