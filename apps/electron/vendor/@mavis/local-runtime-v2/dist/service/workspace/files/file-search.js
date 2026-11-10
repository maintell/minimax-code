import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { resolvePath, toPortableRelativePath } from './path-utils.js';
import { addParentDirectories, scoreFileSearchCandidate } from './search-candidates.js';
import { json, requiredQuery, notFound, resolveWorkspace, resolveWorkspacePath, } from './file-api-shared.js';
import { git } from '../git/git-api.js';
const HIDDEN_SEARCH_DIRS = new Set([
    '.cache',
    '.git',
    '.next',
    '.pnpm-store',
    '.turbo',
    '.venv',
    '.worktree',
    '.worktrees',
    '__pycache__',
    'build',
    'coverage',
    'dist',
    'node_modules',
    'out',
]);
export async function routeFsApi(method, tail, url) {
    if (method === 'GET' && tail === 'dirs') {
        const directory = url.searchParams.get('directory') || homedir();
        const query = url.searchParams.get('query') ?? '';
        const maxdepth = clampInt(url.searchParams.get('maxdepth'), query ? 8 : 1, 1, 10);
        const offset = clampInt(url.searchParams.get('offset'), 0, 0, Number.MAX_SAFE_INTEGER);
        const limit = clampInt(url.searchParams.get('limit'), 50, 1, 200);
        const hideDotFiles = url.searchParams.get('hideDotFiles') !== 'false';
        return json(await listDirs(directory, { query, maxDepth: maxdepth, offset, limit, hideDotFiles }));
    }
    if (method === 'GET' && tail === 'git-info') {
        const targetPath = requiredQuery(url, 'path');
        if (targetPath instanceof Response)
            return targetPath;
        const gitFile = resolve(targetPath, '.git');
        try {
            const info = await stat(gitFile);
            const isInsideWorktree = info.isFile();
            const hasHead = await probeGitWorkspaceHasHead(gitFile, info);
            return json({ isGitWorkspace: true, isInsideWorktree, hasHead });
        }
        catch {
            return json({ isGitWorkspace: false, isInsideWorktree: false, hasHead: false });
        }
    }
    return notFound(`/fs/${tail}`);
}
/**
 * Pure-fs probe for whether the workspace at `.git` has a resolvable HEAD
 * commit. Returns `false` for the unborn case (`git init` with no
 * commits — HEAD points to `refs/heads/<branch>` but the ref file does
 * not exist yet, so `git worktree add main` would fail with
 * `fatal: invalid reference: main` and BranchPill's base-ref picker
 * would be empty).
 *
 * Stays in-process (no `git` subprocess) so the render-gate probe path
 * keeps the same lightweight semantics as the existing `stat(.git)`
 * probe.
 *
 * @param gitFilePath  resolved path to the workspace's `.git`
 * @param gitFileInfo  stat() of `gitFilePath` — directory (main checkout)
 *                     vs. file (worktree gitlink) decides which gitdir
 *                     houses HEAD.
 */
async function probeGitWorkspaceHasHead(gitFilePath, gitFileInfo) {
    try {
        const gitDir = await resolveGitDirectory(gitFilePath, gitFileInfo);
        if (!gitDir)
            return false;
        const headContent = (await readFile(resolve(gitDir, 'HEAD'), 'utf8')).trim();
        // Detached HEAD: 40-64 hex chars (sha1/sha256). Always backed by an
        // object, so any commit at all means hasHead=true.
        if (/^[0-9a-f]{40,64}$/i.test(headContent))
            return true;
        const symMatch = headContent.match(/^ref:\s*(.+)$/);
        const refName = symMatch?.[1]?.trim();
        if (!refName)
            return false;
        // For linked worktrees, refs live under the main gitdir (resolved via
        // the `commondir` file). For a top-level gitdir, commondir is absent
        // (or `.`).
        let refsBaseDir = gitDir;
        try {
            const commonRel = (await readFile(resolve(gitDir, 'commondir'), 'utf8')).trim();
            if (commonRel) {
                refsBaseDir = isAbsolute(commonRel) ? commonRel : resolve(gitDir, commonRel);
            }
        }
        catch {
            // No `commondir` → main checkout. Keep `refsBaseDir = gitDir`.
        }
        try {
            // Loose ref: <gitdir>/refs/heads/<branch> exists as a regular file.
            const looseInfo = await stat(resolve(refsBaseDir, refName));
            if (looseInfo.isFile())
                return true;
        }
        catch {
            // Loose ref missing → fall through to packed-refs.
        }
        return await hasPackedRef(refsBaseDir, refName);
    }
    catch {
        // Any unexpected probe error (permission denied, unreadable HEAD,
        // partial git layout) is treated as "no HEAD yet" — the conservative
        // default that disables `git worktree add` rather than enabling it
        // against an unverified ref.
        return false;
    }
}
async function resolveGitDirectory(gitFilePath, info) {
    if (info.isDirectory())
        return gitFilePath;
    if (!info.isFile())
        return undefined;
    // A linked worktree stores its Git directory in the .git file.
    const content = (await readFile(gitFilePath, 'utf8')).trim();
    const linkedDir = content.match(/^gitdir:\s*(.+)$/m)?.[1]?.trim();
    if (!linkedDir)
        return undefined;
    return isAbsolute(linkedDir) ? linkedDir : resolve(dirname(gitFilePath), linkedDir);
}
async function hasPackedRef(refsBaseDir, refName) {
    try {
        const packed = await readFile(resolve(refsBaseDir, 'packed-refs'), 'utf8');
        return packed.split('\n').some((line) => {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('^'))
                return false;
            const parts = trimmed.split(/\s+/);
            return parts.length >= 2 && parts[1] === refName;
        });
    }
    catch {
        return false;
    }
}
export async function listFileTree(workspace, subPath) {
    const root = resolveWorkspace(workspace);
    let realRoot;
    try {
        realRoot = await realpath(root);
    }
    catch {
        return [];
    }
    if (!realRoot)
        return [];
    const dir = await resolveWorkspacePath(workspace, subPath);
    if (!dir)
        return [];
    let entries;
    try {
        entries = await readdir(dir, { withFileTypes: true });
    }
    catch {
        return [];
    }
    const relativeBase = relative(realRoot, dir);
    return entries
        .filter((entry) => entry.name !== '.git')
        .map((entry) => {
        const nodePath = !relativeBase || relativeBase === '.' ? entry.name : join(relativeBase, entry.name);
        return {
            name: entry.name,
            path: toPortableRelativePath(nodePath),
            type: entry.isDirectory() ? 'directory' : 'file',
            ignored: entry.isDirectory() && HIDDEN_SEARCH_DIRS.has(entry.name),
        };
    })
        .sort((a, b) => {
        if (a.type !== b.type)
            return a.type === 'directory' ? -1 : 1;
        return a.name.localeCompare(b.name);
    });
}
export async function searchFiles(workspace, query, limit, includeDirectories = false) {
    const root = resolveWorkspace(workspace);
    const needle = query.trim().toLowerCase();
    if (!needle || limit <= 0)
        return [];
    const candidates = await listSearchCandidates(workspace, root, includeDirectories);
    return [...candidates]
        .filter(isSearchableRelativePath)
        .map((filePath) => ({ filePath, score: scoreFileSearchCandidate(filePath, needle) }))
        .filter((item) => item.score !== undefined)
        .sort((a, b) => a.score - b.score || a.filePath.localeCompare(b.filePath))
        .slice(0, limit)
        .map((item) => toPortableRelativePath(item.filePath));
}
/** A trailing slash identifies directories without changing file-only callers. */
async function listSearchCandidates(workspace, root, includeDirectories) {
    const gitFiles = await listGitSearchCandidates(workspace);
    const candidates = new Set(gitFiles ?? (await listFsSearchCandidates(root, includeDirectories)));
    if (!includeDirectories)
        return candidates;
    if (gitFiles) {
        for (const directory of await listGitUntrackedDirectories(workspace)) {
            candidates.add(directory);
        }
    }
    addParentDirectories(candidates);
    return candidates;
}
async function listGitUntrackedDirectories(workspace) {
    const directories = await git(['ls-files', '--others', '--directory', '--exclude-standard', '-z'], workspace);
    if (directories.code !== 0)
        return [];
    return directories.stdout.split('\0').filter((path) => path.endsWith('/'));
}
async function listGitSearchCandidates(workspace) {
    const [result, deletedResult] = await Promise.all([
        git(['ls-files', '-co', '--exclude-standard', '-z'], workspace),
        git(['ls-files', '-d', '-z'], workspace),
    ]);
    if (result.code !== 0 || deletedResult.code !== 0)
        return undefined;
    const deleted = new Set(deletedResult.stdout.split('\0').filter(Boolean));
    const seen = new Set();
    const candidates = [];
    for (const filePath of result.stdout.split('\0')) {
        if (!filePath ||
            deleted.has(filePath) ||
            seen.has(filePath) ||
            !isSearchableRelativePath(filePath)) {
            continue;
        }
        seen.add(filePath);
        candidates.push(filePath);
    }
    return candidates;
}
async function listFsSearchCandidates(root, includeDirectories = false) {
    const results = [];
    await walk(root, async (absolute, entry) => {
        if (entry.isDirectory()) {
            if (includeDirectories)
                results.push(`${toPortableRelativePath(relative(root, absolute))}/`);
            return true;
        }
        const rel = relative(root, absolute);
        if (isSearchableRelativePath(rel))
            results.push(rel);
        return true;
    });
    return results;
}
function isSearchableRelativePath(filePath) {
    return filePath
        .split(/[\\/]/u)
        .filter(Boolean)
        .every((segment) => !HIDDEN_SEARCH_DIRS.has(segment));
}
async function listDirs(directory, { query, maxDepth, offset, limit, hideDotFiles, }) {
    const root = resolvePath(directory);
    const entries = [];
    const needle = query.toLowerCase();
    await walk(root, async (absolute, entry, depth) => {
        if (!entry.isDirectory())
            return false;
        if (depth > maxDepth)
            return false;
        const rel = relative(root, absolute);
        if (hideDotFiles && basename(absolute).startsWith('.'))
            return false;
        if (!query ||
            rel.toLowerCase().includes(needle) ||
            basename(absolute).toLowerCase().includes(needle)) {
            entries.push({ relative: rel ? `${rel}/` : absolute, absolute, type: 'dir' });
        }
        return true;
    });
    entries.sort((a, b) => a.relative.localeCompare(b.relative));
    return { entries: entries.slice(offset, offset + limit), total: entries.length };
}
async function walk(root, visit, depth = 0) {
    let entries;
    try {
        entries = await readdir(root, { withFileTypes: true });
    }
    catch {
        return;
    }
    for (const entry of entries) {
        if (HIDDEN_SEARCH_DIRS.has(entry.name) || entry.isSymbolicLink())
            continue;
        const absolute = join(root, entry.name);
        const shouldDescend = await visit(absolute, entry, depth + 1);
        if (shouldDescend && entry.isDirectory()) {
            await walk(absolute, visit, depth + 1);
        }
    }
}
function clampInt(value, fallback, min, max) {
    const parsed = Number.parseInt(value ?? '', 10);
    if (!Number.isFinite(parsed))
        return fallback;
    return Math.max(min, Math.min(max, parsed));
}
//# sourceMappingURL=file-search.js.map