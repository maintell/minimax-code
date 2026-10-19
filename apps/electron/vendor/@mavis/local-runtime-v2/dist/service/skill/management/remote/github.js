import { LocalSkillHubInstallError } from '../hub-errors.js';
const GITHUB_API_TIMEOUT_MS = 30_000;
const COMMON_SINGLE_SEGMENT_REFS = new Set(['main', 'master', 'dev', 'develop', 'trunk']);
export function resolveRemoteArchiveCandidates(sourceUrl, ref) {
    const github = parseGithubUrl(sourceUrl, ref);
    if (github)
        return github;
    return [
        {
            archiveUrl: sourceUrl,
            repoInfo: { repo_url: sourceUrl, source_url: sourceUrl, branch: ref },
            retryable: false,
        },
    ];
}
export async function withResolvedGithubSha(archive, fetchImpl) {
    if (!archive.github || archive.repoInfo.sha)
        return archive;
    const sha = await resolveGithubCommitSha(archive.github, fetchImpl);
    if (sha) {
        return {
            ...archive,
            archiveUrl: `https://codeload.github.com/${archive.github.owner}/${archive.github.repo}/zip/${sha}`,
            repoInfo: { ...archive.repoInfo, sha },
        };
    }
    throw new LocalSkillHubInstallError('Remote skill preview could not resolve the GitHub commit SHA.', 'LOCAL_SKILL_HUB_REMOTE_SHA_UNAVAILABLE', 502);
}
function parseGithubUrl(sourceUrl, ref) {
    let url;
    try {
        url = new URL(sourceUrl);
    }
    catch {
        return undefined;
    }
    if (!['github.com', 'www.github.com'].includes(url.hostname.toLowerCase()))
        return undefined;
    const parts = url.pathname.split('/').filter(Boolean).map(safeDecodeURIComponent);
    if (parts.length < 2)
        return undefined;
    const [owner, rawRepo] = parts;
    if (!owner || !rawRepo)
        return undefined;
    const repo = rawRepo.replace(/\.git$/iu, '');
    const route = parts[2];
    const repoUrl = `https://github.com/${owner}/${repo}`;
    const explicitSkillSubPath = readExplicitSkillSubPath(url.searchParams);
    const makeCandidate = (branch, hintSubPath, exactHintSubPath = false) => {
        const sha = readFullGitSha(branch);
        return {
            archiveUrl: `https://codeload.github.com/${owner}/${repo}/zip/${encodeRefPath(branch)}`,
            repoInfo: {
                repo_url: repoUrl,
                source_url: sourceUrl,
                branch,
                ...(sha ? { sha } : {}),
                ...(hintSubPath ? { hint_sub_path: hintSubPath } : {}),
            },
            retryable: route === 'tree' || route === 'blob',
            exactHintSubPath,
            scanHintSubPath: hintSubPath,
            github: { owner, repo, ref: branch },
        };
    };
    return githubRouteCandidates(route, parts.slice(3), { ref, explicitSkillSubPath }, makeCandidate);
}
function githubRouteCandidates(route, routeTail, options, makeCandidate) {
    const { ref, explicitSkillSubPath } = options;
    if (!route) {
        return [makeCandidate(ref ?? 'HEAD', explicitSkillSubPath, explicitSkillSubPath !== undefined)];
    }
    if (route !== 'tree' && route !== 'blob')
        return undefined;
    if (routeTail.length === 0) {
        return [makeCandidate(ref ?? 'HEAD', explicitSkillSubPath, explicitSkillSubPath !== undefined)];
    }
    if (ref) {
        return [
            makeCandidate(ref, explicitSkillSubPath ?? hintFromExplicitRef(routeTail, ref), explicitSkillSubPath !== undefined),
        ];
    }
    return orderedGithubRefSplits(routeTail).map((split) => makeCandidate(routeTail.slice(0, split).join('/'), explicitSkillSubPath ?? normalizeGithubHintPath(routeTail.slice(split).join('/')), explicitSkillSubPath !== undefined));
}
function hintFromExplicitRef(routeTail, ref) {
    const refParts = ref.split('/').filter(Boolean);
    if (startsWithParts(routeTail, refParts)) {
        return normalizeGithubHintPath(routeTail.slice(refParts.length).join('/'));
    }
    return normalizeGithubHintPath(routeTail.slice(1).join('/'));
}
function orderedGithubRefSplits(routeTail) {
    if (routeTail.length === 0)
        return [1];
    const splits = Array.from({ length: routeTail.length }, (_, index) => index + 1);
    if (COMMON_SINGLE_SEGMENT_REFS.has(routeTail[0] ?? '') || readFullGitSha(routeTail[0] ?? '')) {
        return [1, ...splits.slice(1).reverse()];
    }
    return splits.reverse();
}
async function resolveGithubCommitSha(github, fetchImpl) {
    const directSha = await fetchGithubCommitSha(github, github.ref, fetchImpl);
    if (directSha || github.ref !== 'HEAD')
        return directSha;
    const defaultBranch = await fetchGithubDefaultBranch(github, fetchImpl);
    return defaultBranch ? fetchGithubCommitSha(github, defaultBranch, fetchImpl) : undefined;
}
async function fetchGithubCommitSha(github, ref, fetchImpl) {
    let response;
    try {
        response = await fetchImpl(`https://api.github.com/repos/${github.owner}/${github.repo}/commits/${encodeURIComponent(ref)}`, {
            method: 'GET',
            headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'MiniMaxAgent' },
            signal: AbortSignal.timeout(GITHUB_API_TIMEOUT_MS),
        });
    }
    catch {
        return undefined;
    }
    if (!response.ok)
        return undefined;
    try {
        const payload = (await response.json());
        return readFullGitSha(payload.sha);
    }
    catch {
        return undefined;
    }
}
async function fetchGithubDefaultBranch(github, fetchImpl) {
    let response;
    try {
        response = await fetchImpl(`https://api.github.com/repos/${github.owner}/${github.repo}`, {
            method: 'GET',
            headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'MiniMaxAgent' },
            signal: AbortSignal.timeout(GITHUB_API_TIMEOUT_MS),
        });
    }
    catch {
        return undefined;
    }
    if (!response.ok)
        return undefined;
    try {
        const payload = (await response.json());
        return typeof payload.default_branch === 'string' && payload.default_branch.length > 0
            ? payload.default_branch
            : undefined;
    }
    catch {
        return undefined;
    }
}
function startsWithParts(parts, prefix) {
    return prefix.length <= parts.length && prefix.every((part, index) => parts[index] === part);
}
function encodeRefPath(ref) {
    return ref.split('/').map(encodeURIComponent).join('/');
}
function readFullGitSha(value) {
    return typeof value === 'string' && /^[a-f0-9]{40}$/iu.test(value) ? value : undefined;
}
function safeDecodeURIComponent(value) {
    try {
        return decodeURIComponent(value);
    }
    catch {
        return value;
    }
}
function normalizeGithubHintPath(value) {
    const normalized = value
        ?.split(/[\\/]+/u)
        .filter((part) => part.length > 0 && part !== '.')
        .join('/');
    return normalized || undefined;
}
function readExplicitSkillSubPath(searchParams) {
    const value = searchParams.get('skill_sub_path');
    if (value === null)
        return undefined;
    return normalizeGithubHintPath(value) ?? '';
}
//# sourceMappingURL=github.js.map