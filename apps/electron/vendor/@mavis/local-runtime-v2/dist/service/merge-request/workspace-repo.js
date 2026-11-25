import { parseRemoteUrl } from './code-host/urls.js';
/**
 * The remote a workspace pushes to: the current branch's upstream remote,
 * else "origin", else the first remote. Undefined outside a git repository,
 * before the first commit, or without a parsable remote.
 */
export async function readWorkspaceRemote(workspaceDir, runGit) {
    const head = await readHead(workspaceDir, runGit);
    const remotes = head ? await readRemoteUrls(workspaceDir, runGit) : undefined;
    if (!head || !remotes)
        return undefined;
    const upstream = head.branch
        ? await readUpstreamRemote(head.branch, workspaceDir, runGit)
        : undefined;
    const name = pickRemote(remotes, upstream);
    const url = name ? remotes.get(name) : undefined;
    const parsed = url ? parseRemoteUrl(url) : undefined;
    if (!name || !parsed)
        return undefined;
    const defaultBranch = await readDefaultBranch(name, workspaceDir, runGit);
    return { ...parsed, ...head, ...(defaultBranch ? { defaultBranch } : {}) };
}
/**
 * The branch the remote's HEAD pointed at when the clone last learned it:
 * `git clone` records it, a remote added by hand has none until
 * `git remote set-head`. Read locally, so it costs no request to the host.
 */
async function readDefaultBranch(remote, workspaceDir, runGit) {
    const ref = await runGit(['symbolic-ref', '--quiet', '--short', `refs/remotes/${remote}/HEAD`], workspaceDir);
    if (ref.code !== 0)
        return undefined;
    const short = ref.stdout.trim();
    const prefix = `${remote}/`;
    return short.startsWith(prefix) && short.length > prefix.length
        ? short.slice(prefix.length)
        : undefined;
}
async function readHead(workspaceDir, runGit) {
    const head = await runGit(['rev-parse', 'HEAD', '--abbrev-ref', 'HEAD'], workspaceDir);
    if (head.code !== 0)
        return undefined;
    const [headSha = '', abbrev = ''] = head.stdout.trim().split(/\r?\n/u);
    return {
        ...(abbrev && abbrev !== 'HEAD' ? { branch: abbrev } : {}),
        ...(/^[0-9a-f]{40,64}$/u.test(headSha) ? { headSha } : {}),
    };
}
async function readRemoteUrls(workspaceDir, runGit) {
    const urls = await runGit(['config', '--get-regexp', '^remote\\..*\\.url$'], workspaceDir);
    if (urls.code !== 0)
        return undefined;
    const remotes = new Map();
    for (const line of urls.stdout.split(/\r?\n/u)) {
        const match = /^remote\.(.+)\.url\s+(.+)$/u.exec(line.trim());
        if (match?.[1] && match[2] && !remotes.has(match[1]))
            remotes.set(match[1], match[2]);
    }
    return remotes;
}
async function readUpstreamRemote(branch, workspaceDir, runGit) {
    const configured = await runGit(['config', '--get', `branch.${branch}.remote`], workspaceDir);
    return configured.code === 0 ? configured.stdout.trim() : undefined;
}
function pickRemote(remotes, upstream) {
    if (upstream && remotes.has(upstream))
        return upstream;
    if (remotes.has('origin'))
        return 'origin';
    return remotes.keys().next().value;
}
//# sourceMappingURL=workspace-repo.js.map