const MAX_INPUT_LENGTH = 2_048;
const PATH_SEGMENT = /^[A-Za-z0-9_.~-]+$/u;
const SSH_USER = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const GITHUB_OWNER = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/u;
const DNS_HOST = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/u;
const IPV6_HOST = /^\[[0-9a-f:.]+\]$/u;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
// `[user@]host:path` with no slash before the colon, as git defines it.
const SCP_LIKE = /^(?:([^@/:]+)@)?([^@/:]+):(.+)$/u;
const GITHUB_SHORTHAND = /^([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100})(?:@(.+))?$/u;
const FULL_COMMIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const UNSAFE_PATH_CHARACTER = /[\\:*?"<>|\p{Cc}]/u;
const GITHUB_HOSTS = new Set(['github.com', 'www.github.com']);
// GitLab separates a repository from its pages with `/-/`; GitHub pages follow `owner/repo`.
const GITLAB_PAGE_MARKER = '-';
const ROUTE_KINDS = new Map([
    ['tree', 'tree'],
    ['commits', 'tree'],
    ['blob', 'blob'],
    ['raw', 'blob'],
    ['blame', 'blob'],
]);
const MAX_ROUTE_SEGMENTS = 32;
// Refs that are taken without asking the remote, as the GitHub import does.
const COMMON_REFS = new Set(['main', 'master', 'dev', 'develop', 'trunk']);
// A leading `-` would read as an option; the rest mirrors `git check-ref-format`.
const UNSAFE_REF_PATTERNS = [
    /^[-/.]/u,
    /[/.]$/u,
    /\.lock$/u,
    /\.\./u,
    /\/\//u,
    /@\{/u,
    /^@$/u,
    /[\s~^:?*[\\\p{Cc}]/u,
];
/** A Git repository location that is safe to hand to git as one argument. */
export class GitRemote {
    /** Value passed to git. */
    url;
    transport;
    /** Lower-case host name without port. */
    host;
    /** Repository path without a leading slash or trailing `.git`. */
    repositoryPath;
    port;
    constructor(parts) {
        this.url = parts.url;
        this.transport = parts.transport;
        this.host = parts.host;
        this.repositoryPath = parts.segments.join('/').replace(/\.git$/iu, '');
        this.port = parts.port ?? '';
    }
    /**
     * Accepts `https://…` clone URLs and GitHub / GitLab browser pages (tree,
     * blob, commit and other repository pages, with their query and fragment
     * dropped), `ssh://…`, scp-like `git@host:path`, and GitHub
     * `owner/repo[@ref]`. Credentials, other schemes, ssh queries, and
     * option-like hosts or users yield undefined.
     */
    static parse(input, options = {}) {
        const value = input.trim();
        if (!value || value.length > MAX_INPUT_LENGTH || /[\s\p{Cc}]/u.test(value))
            return undefined;
        if (value.includes('://')) {
            const source = parseUrlSource(value, options);
            if (!source)
                return undefined;
            return {
                remote: new GitRemote(source.parts),
                ...(source.ref ? { ref: source.ref } : {}),
                ...(source.route ? { route: source.route } : {}),
            };
        }
        const parts = parseScpParts(value);
        return parts ? { remote: new GitRemote(parts) } : parseGithubShorthand(value);
    }
    static github(owner, repo) {
        const name = repo.replace(/\.git$/iu, '');
        if (!GITHUB_OWNER.test(owner) || !isPathSegment(name))
            return undefined;
        return new GitRemote({
            url: `https://github.com/${owner}/${name}.git`,
            transport: 'https',
            host: 'github.com',
            segments: [owner, name],
        });
    }
    /** Host and explicit port for logs; never the repository path. */
    displayHost() {
        return this.port ? `${this.host}:${this.port}` : this.host;
    }
    /** Same value for one repository written with or without `.git` or as a shorthand. */
    identity() {
        return `${this.transport}://${this.displayHost()}/${this.repositoryPath}`;
    }
    /** First repository path segment, lower-cased (GitHub owner, GitLab group). */
    owner() {
        return (this.repositoryPath.split('/')[0] ?? '').toLowerCase();
    }
}
/**
 * Splits a browser route without asking the remote: after a common branch or a
 * full commit SHA, or when the route names only a ref. A ref that may contain
 * `/` (`release/v2/plugins`) yields undefined; `resolveRoute` asks the remote.
 */
export function splitRouteTail(route) {
    const [first] = route.tail;
    if (!first)
        return undefined;
    const settled = route.tail.length === 1 || COMMON_REFS.has(first) || isFullCommitSha(first);
    return settled ? routeTarget(route, 1) : undefined;
}
/** Ref made of the first `split` segments; a blob path names a file, so its directory is kept. */
export function routeTarget(route, split) {
    const ref = route.tail.slice(0, split).join('/');
    const rest = route.tail.slice(split);
    const directory = route.kind === 'blob' ? rest.slice(0, -1) : rest;
    return directory.length > 0 ? { ref, path: directory.join('/') } : { ref };
}
export function isFullCommitSha(value) {
    return FULL_COMMIT_SHA.test(value.toLowerCase());
}
/** Branch or tag names accepted as a single git argument (subset of `check-ref-format`). */
export function isSafeGitRef(ref) {
    return (ref.length > 0 && ref.length <= 255 && !UNSAFE_REF_PATTERNS.some((pattern) => pattern.test(ref)));
}
/**
 * Normalizes a repository-relative directory written by a catalog or a user
 * (`./a//b` → `a/b`, `.` → ``). Absolute, parent-relative, and non-portable
 * paths yield undefined.
 */
export function normalizeRepositoryPath(value) {
    const trimmed = value.trim();
    if (trimmed.startsWith('/') || /^[A-Za-z]:/u.test(trimmed))
        return undefined;
    if (UNSAFE_PATH_CHARACTER.test(trimmed))
        return undefined;
    const segments = trimmed.split('/').filter((segment) => segment !== '' && segment !== '.');
    if (segments.some((segment) => segment === '..'))
        return undefined;
    return segments.join('/');
}
function parseUrlSource(value, options) {
    const url = parseUrl(value);
    const transport = url ? urlTransport(url, options) : undefined;
    if (!url || !transport || hasForbiddenUrlParts(url, value, transport))
        return undefined;
    const page = isValidHost(url.hostname) ? readUrlPage(url, transport) : undefined;
    const segments = page ? validSegments(page.repository) : undefined;
    if (!page || !segments)
        return undefined;
    return { parts: urlRemoteParts(url, transport, segments, page.page), ...pageTarget(page) };
}
function readUrlPage(url, transport) {
    if (transport !== 'ssh')
        return readBrowserPage(url);
    return { repository: url.pathname.split('/').filter(Boolean), page: false };
}
function pageTarget(page) {
    return {
        ...(page.ref ? { ref: page.ref } : {}),
        ...(page.route ? { route: page.route } : {}),
    };
}
function parseUrl(value) {
    try {
        return new URL(value);
    }
    catch {
        return undefined;
    }
}
/** Clone URL rebuilt from the URL parts git needs; a browser page gets the conventional `.git`. */
function urlRemoteParts(url, transport, segments, page) {
    // `www.github.com` pages clone from the canonical host.
    const hostname = url.hostname === 'www.github.com' ? 'github.com' : url.hostname;
    const host = url.port ? `${hostname}:${url.port}` : hostname;
    const user = url.username ? `${url.username}@` : '';
    const suffix = page && !/\.git$/iu.test(segments.at(-1) ?? '') ? '.git' : '';
    return {
        url: `${url.protocol}//${user}${host}/${segments.join('/')}${suffix}`,
        transport,
        host: hostname,
        segments,
        port: url.port,
    };
}
/** Repository and route named by an HTTP(S) path; the query and fragment are never read. */
function readBrowserPage(url) {
    const segments = url.pathname.split('/').filter(Boolean);
    const marker = segments.indexOf(GITLAB_PAGE_MARKER);
    if (marker === 0)
        return undefined;
    if (marker > 0)
        return pageOf(segments.slice(0, marker), segments.slice(marker + 1));
    if (GITHUB_HOSTS.has(url.hostname) && segments.length > 2) {
        return pageOf(segments.slice(0, 2), segments.slice(2));
    }
    return { repository: segments, page: false };
}
function pageOf(repository, rest) {
    const [name = '', ...encoded] = rest;
    const tail = encoded.map(safeDecode);
    if (tail.some((segment) => segment === undefined))
        return { repository, page: true };
    const decoded = tail;
    const first = decoded[0];
    if (name === 'commit' && first && isFullCommitSha(first)) {
        return { repository, page: true, ref: first.toLowerCase() };
    }
    const kind = ROUTE_KINDS.get(name);
    if (!kind || decoded.length === 0 || decoded.length > MAX_ROUTE_SEGMENTS) {
        return { repository, page: true };
    }
    return { repository, page: true, route: { kind, tail: decoded } };
}
function safeDecode(segment) {
    try {
        return decodeURIComponent(segment);
    }
    catch {
        return undefined;
    }
}
function urlTransport(url, options) {
    if (url.protocol === 'https:')
        return 'https';
    if (url.protocol === 'ssh:')
        return 'ssh';
    if (url.protocol === 'http:' && options.allowLoopbackHttp && LOOPBACK_HOSTS.has(url.hostname)) {
        return 'http';
    }
    return undefined;
}
function hasForbiddenUrlParts(url, raw, transport) {
    // URL parsing silently resolves dot segments; refuse them before it does.
    const [beforeQuery = ''] = raw.split(/[?#]/u);
    const dotSegment = beforeQuery.split('/').some((segment) => segment === '.' || segment === '..');
    if (dotSegment || url.password)
        return true;
    // A browser page carries a query or fragment that git never needs; ssh URLs have none.
    if (transport === 'ssh' && (raw.includes('?') || raw.includes('#')))
        return true;
    // An HTTP(S) user name is a credential; an SSH user name is the login account.
    if (url.username && transport !== 'ssh')
        return true;
    return Boolean(url.username) && !SSH_USER.test(url.username);
}
function parseScpParts(value) {
    const match = SCP_LIKE.exec(value);
    const user = match?.[1];
    const host = match?.[2]?.toLowerCase();
    const rawPath = match?.[3];
    // A one-letter host is a Windows drive (`C:/…`), never a remote.
    if (!host || !rawPath || host.length < 2 || !isValidHost(host))
        return undefined;
    if (user !== undefined && !SSH_USER.test(user))
        return undefined;
    const segments = repositorySegments(rawPath);
    if (!segments)
        return undefined;
    const path = `${rawPath.startsWith('/') ? '/' : ''}${segments.join('/')}`;
    return { url: `${user ? `${user}@` : ''}${host}:${path}`, transport: 'ssh', host, segments };
}
function parseGithubShorthand(value) {
    const match = GITHUB_SHORTHAND.exec(value);
    const ref = match?.[3];
    const remote = match?.[1] && match[2] ? GitRemote.github(match[1], match[2]) : undefined;
    if (!remote || (ref !== undefined && !isSafeGitRef(ref)))
        return undefined;
    return { remote, ...(ref ? { ref } : {}) };
}
function repositorySegments(pathname) {
    return validSegments(pathname.split('/').filter(Boolean));
}
function validSegments(segments) {
    if (segments.length === 0 || !segments.every(isPathSegment))
        return undefined;
    return [...segments];
}
function isPathSegment(segment) {
    return (PATH_SEGMENT.test(segment) && segment !== '.' && segment !== '..' && !segment.startsWith('-'));
}
function isValidHost(host) {
    return DNS_HOST.test(host) || IPV6_HOST.test(host);
}
//# sourceMappingURL=git-remote.js.map