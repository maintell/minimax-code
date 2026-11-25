/** GitLab: https://host/group/sub/project/-/merge_requests/42 (the "/-" segment is optional on old servers). */
const GITLAB_MERGE_REQUEST = /^https?:\/\/([^/\s?#]+)\/(.+?)\/(?:-\/)?merge_requests\/(\d+)(?:[/?#][^\s]*)?$/iu;
/** GitHub and GitHub Enterprise: https://host/owner/repo/pull/42. */
const GITHUB_PULL_REQUEST = /^https?:\/\/([^/\s?#]+)\/([^/\s?#]+\/[^/\s?#]+)\/pull\/(\d+)(?:[/?#][^\s]*)?$/iu;
/** scp-like remotes: git@host:group/project.git. */
const SCP_REMOTE = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)(.+)$/u;
/** Reads a GitLab merge request or GitHub pull request URL; anything else is undefined. */
export function parseMergeRequestUrl(input) {
    const url = input.trim();
    const gitlab = GITLAB_MERGE_REQUEST.exec(url);
    if (gitlab)
        return toRef('gitlab', gitlab[1], gitlab[2], gitlab[3]);
    const github = GITHUB_PULL_REQUEST.exec(url);
    if (github)
        return toRef('github', github[1], github[2], github[3]);
    return undefined;
}
/** Reads host and project path from a git remote URL (https, ssh or scp-like). */
export function parseRemoteUrl(remote) {
    const value = remote.trim();
    if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(value)) {
        try {
            const url = new URL(value);
            // An https remote is served on this port; an ssh remote's port is not its web port.
            const host = url.protocol === 'http:' || url.protocol === 'https:' ? url.host : url.hostname;
            return toRepo(host, decodeURIComponent(url.pathname));
        }
        catch {
            return undefined;
        }
    }
    const scp = SCP_REMOTE.exec(value);
    return scp ? toRepo(scp[1], scp[2] ?? '') : undefined;
}
/** Hosts recognised without asking any CLI. */
export function classifyWellKnownHost(host) {
    if (host === 'github.com')
        return 'github';
    if (host.includes('gitlab'))
        return 'gitlab';
    return undefined;
}
/** Stable identity for a merge request; project paths compare case-insensitively on both platforms. */
export function mergeRequestKey(ref) {
    return `${projectKey(ref.platform, ref.host, ref.projectPath)}!${String(ref.number)}`;
}
export function projectKey(platform, host, projectPath) {
    return `${platform}:${host}/${projectPath.toLowerCase()}`;
}
export function mergeRequestWebUrl(ref) {
    const base = `https://${ref.host}/${ref.projectPath}`;
    return ref.platform === 'gitlab'
        ? `${base}/-/merge_requests/${String(ref.number)}`
        : `${base}/pull/${String(ref.number)}`;
}
export function loginCommand(platform, host) {
    if (platform === 'gitlab')
        return `glab auth login --hostname ${host}`;
    return host === 'github.com' ? 'gh auth login' : `gh auth login --hostname ${host}`;
}
function toRef(platform, rawHost, rawPath, rawNumber) {
    const repo = toRepo(rawHost ?? '', rawPath ?? '');
    const number = Number(rawNumber);
    if (!repo || !Number.isSafeInteger(number) || number <= 0)
        return undefined;
    return { platform, host: repo.host, projectPath: repo.projectPath, number };
}
function toRepo(rawHost, rawPath) {
    const host = (rawHost ?? '').toLowerCase();
    // A local path such as C:\repo parses like an scp remote; real hosts carry a dot.
    const hostname = host.replace(/:\d+$/u, '');
    if (!hostname.includes('.') && hostname !== 'localhost')
        return undefined;
    const projectPath = rawPath
        .replace(/^\/+/u, '')
        .replace(/\/+$/u, '')
        .replace(/\.git$/iu, '');
    if (!projectPath.includes('/'))
        return undefined;
    return { host, projectPath };
}
//# sourceMappingURL=urls.js.map