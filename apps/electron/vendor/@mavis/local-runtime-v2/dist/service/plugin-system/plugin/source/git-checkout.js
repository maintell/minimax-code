import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { isFullCommitSha, isSafeGitRef, routeTarget, splitRouteTail, } from './git-remote.js';
import { GitCommandError, runGit } from './git-runner.js';
/** Fetches one version of a repository into a temporary directory under `stagingParent`. */
export async function checkout(remote, options) {
    const sha = immutableTarget(options);
    if (sha === undefined && options.ref !== undefined && !isSafeGitRef(options.ref)) {
        throw new GitCommandError('REF_NOT_FOUND', 'Git ref is not a valid branch or tag name');
    }
    await mkdir(options.stagingParent, { recursive: true });
    const temporary = await mkdtemp(path.join(options.stagingParent, 'git-'));
    const root = path.join(temporary, 'repo');
    try {
        const git = boundGitCommand(options);
        const commitSha = sha === undefined
            ? await checkoutRef(git, remote, root, options)
            : await checkoutCommit(git, remote, root, { ...options, sha });
        if (!options.keepMetadata)
            await rm(path.join(root, '.git'), { recursive: true, force: true });
        const selected = options.subPath ? path.join(root, ...options.subPath.split('/')) : root;
        if (!(await isDirectory(selected))) {
            throw new GitCommandError('PATH_NOT_FOUND', 'Selected repository directory does not exist');
        }
        return { root, path: selected, commitSha, discard: discardOnce(temporary) };
    }
    catch (error) {
        await rm(temporary, { recursive: true, force: true });
        throw error;
    }
}
/** Commit the remote advertises for `ref` (peeled for annotated tags) or for HEAD. */
export async function resolveHead(remote, ref, options = {}) {
    if (ref !== undefined && isFullCommitSha(ref))
        return ref.toLowerCase();
    if (ref !== undefined && !isSafeGitRef(ref)) {
        throw new GitCommandError('REF_NOT_FOUND', 'Git ref is not a valid branch or tag name');
    }
    const patterns = ref === undefined ? ['HEAD'] : refPatterns(ref);
    const { stdout } = await runGit(['ls-remote', '--', remote.url, ...patterns], options);
    const refs = parseAdvertisedRefs(stdout);
    const sha = ref === undefined ? refs.get('HEAD') : pickAdvertisedRef(refs, ref);
    if (sha)
        return sha;
    throw ref === undefined
        ? new GitCommandError('REPO_EMPTY', 'Git repository has no commits')
        : new GitCommandError('REF_NOT_FOUND', 'Git ref was not found');
}
/**
 * Ref and directory named by a browser tree / blob route. A route that may
 * hold a ref with `/` is split at the longest branch or tag the remote
 * advertises, from one `ls-remote`; the GitHub import resolves its routes the
 * same way.
 */
export async function resolveRoute(remote, route, options = {}) {
    const settled = splitRouteTail(route);
    if (settled)
        return settled;
    const { stdout } = await runGit(['ls-remote', '--heads', '--tags', '--', remote.url], options);
    const refs = parseAdvertisedRefs(stdout);
    for (let split = route.tail.length; split >= 1; split -= 1) {
        const ref = route.tail.slice(0, split).join('/');
        if (isSafeGitRef(ref) && pickAdvertisedRef(refs, ref))
            return routeTarget(route, split);
    }
    throw new GitCommandError('REF_NOT_FOUND', 'Git ref was not found');
}
/**
 * Object ids at HEAD of directories (trees) and files (blobs); missing paths
 * are omitted. A directory's tree id is the version identity of a Plugin
 * without a declared version: it only changes when something inside changes.
 */
export async function pathObjectShas(dir, paths) {
    const unique = [...new Set(paths)];
    const result = new Map();
    if (unique.length === 0)
        return result;
    const { stdout } = await runGit(['cat-file', '--batch-check'], {
        cwd: dir,
        input: unique.map((subPath) => `HEAD:${subPath}\n`).join(''),
    });
    // One output line per input line; a missing path prints `<name> missing`.
    const lines = stdout.split('\n');
    for (const [index, subPath] of unique.entries()) {
        const sha = /^([0-9a-f]{40,64}) (?:tree|blob) /u.exec(lines[index] ?? '')?.[1];
        if (sha)
            result.set(subPath, sha);
    }
    return result;
}
function immutableTarget(options) {
    if (options.sha !== undefined) {
        // Validated here as well: the value becomes a git argument.
        if (!isFullCommitSha(options.sha)) {
            throw new GitCommandError('REF_NOT_FOUND', 'Git commit must be a full SHA');
        }
        return options.sha.toLowerCase();
    }
    return options.ref !== undefined && isFullCommitSha(options.ref)
        ? options.ref.toLowerCase()
        : undefined;
}
async function checkoutCommit(git, remote, root, options) {
    const depth = String(depthOf(options));
    await git([
        'clone',
        '--no-checkout',
        '--filter=blob:none',
        '--no-tags',
        '--depth',
        '1',
        '--',
        remote.url,
        root,
    ]);
    if (options.sparsePaths && options.sparsePaths.length > 0) {
        await git(['-C', root, 'sparse-checkout', 'set', '--no-cone', ...sparsePatterns(options)]);
    }
    await git(['-C', root, 'fetch', '--depth', depth, '--no-tags', 'origin', options.sha]);
    await git(['-C', root, 'checkout', '--detach', options.sha]);
    return options.sha;
}
async function checkoutRef(git, remote, root, options) {
    const sparse = options.sparsePaths !== undefined && options.sparsePaths.length > 0;
    const { stderr } = await git([
        'clone',
        '--depth',
        String(depthOf(options)),
        '--no-tags',
        ...(options.ref !== undefined ? ['--branch', options.ref] : []),
        ...(sparse ? ['--filter=blob:none', '--no-checkout'] : []),
        '--',
        remote.url,
        root,
    ]);
    // Cloning an empty repository succeeds with only a warning.
    if (/empty repository/iu.test(stderr)) {
        throw new GitCommandError('REPO_EMPTY', 'Git repository has no commits');
    }
    if (sparse) {
        await git(['-C', root, 'sparse-checkout', 'set', '--no-cone', ...sparsePatterns(options)]);
        await git(['-C', root, 'checkout']);
    }
    const head = await runGit(['rev-parse', '--verify', 'HEAD'], {
        cwd: root,
        signal: options.signal,
        timeoutMs: options.timeoutMs,
    });
    return head.stdout.trim().toLowerCase();
}
function boundGitCommand(options) {
    return (args) => runGit(args, { signal: options.signal, timeoutMs: options.timeoutMs });
}
function depthOf(options) {
    const depth = Math.trunc(options.depth ?? 1);
    return Number.isFinite(depth) && depth > 0 ? depth : 1;
}
// Non-cone patterns are gitignore syntax: anchor each path at the root and
// escape glob characters so a directory name is matched literally.
function sparsePatterns(options) {
    return (options.sparsePaths ?? []).map((sparsePath) => `/${sparsePath.replace(/[[\]*?!#\\]/gu, '\\$&')}`);
}
function refPatterns(ref) {
    if (ref.startsWith('refs/'))
        return [ref, `${ref}^{}`];
    return [`refs/heads/${ref}`, `refs/tags/${ref}`, `refs/tags/${ref}^{}`];
}
function pickAdvertisedRef(refs, ref) {
    if (ref.startsWith('refs/'))
        return refs.get(`${ref}^{}`) ?? refs.get(ref);
    return (refs.get(`refs/heads/${ref}`) ?? refs.get(`refs/tags/${ref}^{}`) ?? refs.get(`refs/tags/${ref}`));
}
function parseAdvertisedRefs(stdout) {
    const refs = new Map();
    for (const line of stdout.split(/\r?\n/u)) {
        const match = /^([0-9a-f]{40,64})\t(\S+)$/u.exec(line.trim());
        if (match?.[1] && match[2])
            refs.set(match[2], match[1]);
    }
    return refs;
}
async function isDirectory(target) {
    try {
        return (await stat(target)).isDirectory();
    }
    catch {
        return false;
    }
}
function discardOnce(directory) {
    let active = true;
    return async () => {
        if (!active)
            return;
        active = false;
        await rm(directory, { recursive: true, force: true });
    };
}
//# sourceMappingURL=git-checkout.js.map