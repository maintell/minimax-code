import { execFile as execFileCallback, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { and, eq } from 'drizzle-orm';
import { sessions } from '../../../../infra/db/schema/sessions.js';
import { excludeManagedWorktrees } from '../../../../infra/git/worktree-exclude.js';
import { parseSessionExtraData } from '../repo/drizzle/codec.js';
import { createWorktreeCreationProgressTracker, } from './worktree-creation-progress.js';
import { generateDefaultWorktreeBranch, resolveExistingWorktreeRepository, } from '../../../workspace/index.js';
const execFile = promisify(execFileCallback);
const UPSTREAM_FETCH_TIMEOUT_MS = 60_000;
export class LocalRunLocationError extends Error {
    code;
    constructor(message, code) {
        super(message);
        this.code = code;
        this.name = 'LocalRunLocationError';
    }
}
export function readLocalRunLocationInput(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return undefined;
    const mode = Reflect.get(value, 'mode');
    if (mode !== 'current' && mode !== 'new-worktree' && mode !== 'existing-worktree') {
        throw new LocalRunLocationError(`Unknown runLocation.mode "${String(mode)}"`, 'RUN_LOCATION_INVALID_MODE');
    }
    return {
        mode,
        ...optionalField(value, 'worktreeDir'),
        ...optionalField(value, 'branch'),
        ...optionalField(value, 'newWorktreeBranch'),
        ...optionalField(value, 'newWorktreeBase'),
    };
}
export async function applyLocalRunLocation(input, workspaceDir, nowMs, options = {}) {
    const createdAt = nowMs();
    if (input.mode === 'current') {
        await checkoutOptionalBranch(input.branch, workspaceDir);
        return {
            mode: 'current',
            resolvedDir: workspaceDir,
            ...(input.branch ? { resolvedBranch: input.branch } : {}),
            createdAt,
        };
    }
    if (input.mode === 'new-worktree') {
        return createNewWorktree(input, workspaceDir, createdAt, options);
    }
    return resolveExistingWorktree(input, workspaceDir, createdAt, options.workspaceDirImplicit === true);
}
async function createNewWorktree(input, workspaceDir, createdAt, options) {
    const branch = input.newWorktreeBranch ?? input.branch ?? generateDefaultWorktreeBranch(createdAt);
    const progress = createWorktreeCreationProgressTracker({
        workspace: workspaceDir,
        branch,
        sink: options.onWorktreeProgress,
    });
    try {
        await assertSafeBranchName(branch, workspaceDir);
        const baseSha = await resolveWorktreeBase(input.newWorktreeBase ?? 'HEAD', workspaceDir, options.refreshBeforeCreate ?? true, progress);
        const worktreeParentDir = await resolveSafeWorktreeParent(workspaceDir);
        const targetDir = join(worktreeParentDir, branch.replaceAll('/', '-'));
        progress.beginCheckout();
        await createPinnedBranch(branch, input.newWorktreeBase ?? 'HEAD', baseSha, workspaceDir);
        const result = await gitStreaming(['worktree', 'add', targetDir, branch], workspaceDir, {
            onOutput: (text) => progress.checkoutOutput(text),
        });
        if (result.code !== 0) {
            await git(['branch', '-D', branch], workspaceDir);
            throw new LocalRunLocationError(`git worktree add failed: ${summarizeGitOutput(result.stderr) || summarizeGitOutput(result.stdout)}`, 'RUN_LOCATION_WORKTREE_ADD_FAILED');
        }
        progress.complete(targetDir);
        return {
            mode: 'new-worktree',
            resolvedDir: targetDir,
            resolvedBranch: branch,
            parentRepoDir: workspaceDir,
            createdAt,
        };
    }
    catch (error) {
        progress.fail(error instanceof Error ? error.message : String(error));
        throw error;
    }
}
async function createPinnedBranch(branch, baseRef, baseSha, cwd) {
    // Let Git apply autoSetupMerge/autoSetupRebase to the selected reference before
    // pinning the new branch. Starting directly from a SHA loses that information.
    const createBranch = await git(['branch', branch, baseRef], cwd);
    if (createBranch.code !== 0) {
        throw new LocalRunLocationError(`git branch failed: ${createBranch.stderr || createBranch.stdout}`, 'RUN_LOCATION_WORKTREE_ADD_FAILED');
    }
    const branchRef = `refs/heads/${branch}`;
    const initial = await git(['rev-parse', '--verify', branchRef], cwd);
    const pin = initial.code === 0
        ? await git(['update-ref', branchRef, baseSha, initial.stdout.trim()], cwd)
        : initial;
    if (pin.code !== 0) {
        await git(['branch', '-D', branch], cwd);
        throw new LocalRunLocationError(`Could not pin worktree branch: ${pin.stderr || pin.stdout}`, 'RUN_LOCATION_WORKTREE_ADD_FAILED');
    }
}
async function resolveExistingWorktree(input, fallbackWorkspaceDir, createdAt, workspaceDirImplicit) {
    if (!input.worktreeDir) {
        throw new LocalRunLocationError('runLocation.mode="existing-worktree" requires `worktreeDir`', 'RUN_LOCATION_WORKTREE_DIR_REQUIRED');
    }
    if (!isAbsolute(input.worktreeDir)) {
        throw new LocalRunLocationError(`runLocation.worktreeDir must be an absolute path, got "${input.worktreeDir}"`, 'RUN_LOCATION_WORKTREE_DIR_NOT_ABSOLUTE');
    }
    if (!existsSync(input.worktreeDir)) {
        throw new LocalRunLocationError(`Worktree directory does not exist: ${input.worktreeDir}`, 'RUN_LOCATION_WORKTREE_NOT_FOUND');
    }
    const workspaceDir = await requireWorktreeRepository(input.worktreeDir, fallbackWorkspaceDir, workspaceDirImplicit);
    await checkoutOptionalBranch(input.branch, input.worktreeDir);
    return {
        mode: 'existing-worktree',
        resolvedDir: input.worktreeDir,
        ...(input.branch ? { resolvedBranch: input.branch } : {}),
        parentRepoDir: workspaceDir,
        createdAt,
    };
}
async function requireWorktreeRepository(worktreeDir, workspaceDir, workspaceDirImplicit) {
    const result = await resolveExistingWorktreeRepository(worktreeDir, workspaceDir, workspaceDirImplicit);
    if (result.kind === 'resolved')
        return result.repoDir;
    throw new LocalRunLocationError(result.message, 'RUN_LOCATION_WORKTREE_NOT_IN_REPOSITORY');
}
async function checkoutOptionalBranch(branch, cwd) {
    if (!branch)
        return;
    await assertSafeBranchName(branch, cwd);
    const result = await git(['checkout', branch], cwd);
    if (result.code !== 0) {
        throw new LocalRunLocationError(`Failed to checkout branch "${branch}" in ${cwd}: ${result.stderr || result.stdout}`, 'RUN_LOCATION_CHECKOUT_FAILED');
    }
}
async function resolveSafeWorktreeParent(workspaceDir) {
    const workspaceReal = await realpath(workspaceDir);
    const parent = join(workspaceDir, '.worktrees');
    await mkdir(parent, { recursive: true });
    await excludeManagedWorktrees(workspaceDir);
    const parentReal = await realpath(parent);
    const pathFromParent = relative(resolve(workspaceReal), resolve(parentReal));
    if (pathFromParent.startsWith('..') || isAbsolute(pathFromParent)) {
        throw new LocalRunLocationError(`Refusing to create worktree outside workspace: ${parent}`, 'RUN_LOCATION_WORKTREE_PARENT_ESCAPES');
    }
    return parentReal;
}
function assertSafeBaseRef(baseRef) {
    if (baseRef.startsWith('-') || baseRef.includes('\0')) {
        throw new LocalRunLocationError(`Invalid git base ref "${baseRef}"`, 'RUN_LOCATION_INVALID_BASE');
    }
}
/** Resolve the selected ref once; the worktree setting owns network refresh policy. */
async function resolveWorktreeBase(baseRef, cwd, refresh, progress) {
    assertSafeBaseRef(baseRef);
    const ref = refresh ? await resolvePreferredRef(baseRef, cwd, progress) : baseRef;
    const result = await git(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`], cwd);
    const sha = result.stdout.trim();
    if (result.code !== 0 || !/^[0-9a-f]{40,64}$/.test(sha)) {
        throw new LocalRunLocationError(`Could not resolve worktree base "${baseRef}": ${result.stderr || result.stdout}`, 'RUN_LOCATION_INVALID_BASE');
    }
    return sha;
}
async function resolvePreferredRef(baseRef, cwd, progress) {
    const result = await git(['remote'], cwd);
    if (result.code !== 0) {
        throw new LocalRunLocationError(result.stderr, 'RUN_LOCATION_INVALID_BASE');
    }
    const remotes = result.stdout
        .trim()
        .split('\n')
        .filter(Boolean)
        .sort((a, b) => b.length - a.length);
    const localName = baseRef.replace(/^refs\/heads\//, '');
    const local = await git(['show-ref', '--verify', '--quiet', `refs/heads/${localName}`], cwd);
    if (local.code === 0 || baseRef === 'HEAD') {
        const branchResult = baseRef === 'HEAD'
            ? await git(['symbolic-ref', '--quiet', '--short', 'HEAD'], cwd)
            : { stdout: localName };
        const branch = branchResult.stdout.trim();
        return branch ? resolveBranchUpstream(branch, cwd, progress) : baseRef;
    }
    const shortRef = baseRef.replace(/^refs\/remotes\//, '');
    const remote = remotes.find((name) => shortRef.startsWith(`${name}/`));
    if (remote)
        return fetchBaseRef(remote, shortRef.slice(remote.length + 1), cwd, progress);
    if (baseRef.startsWith('refs/remotes/')) {
        throw new LocalRunLocationError(`Remote no longer exists for ${baseRef}`, 'RUN_LOCATION_FETCH_FAILED');
    }
    return baseRef;
}
async function resolveBranchUpstream(branch, cwd, progress) {
    const [remoteConfig, mergeConfig] = await Promise.all([
        git(['config', '--get', `branch.${branch}.remote`], cwd),
        git(['config', '--get', `branch.${branch}.merge`], cwd),
    ]);
    const remote = remoteConfig.stdout.trim();
    const mergeRef = mergeConfig.stdout.trim();
    if (remote === '.' && mergeRef)
        return mergeRef;
    if (remote && mergeRef.startsWith('refs/heads/')) {
        return fetchBaseRef(remote, mergeRef.slice('refs/heads/'.length), cwd, progress);
    }
    return `refs/heads/${branch}`;
}
async function resolveRemoteBranch(remote, branch, cwd) {
    if (branch !== 'HEAD')
        return branch;
    const prefix = `refs/remotes/${remote}/`;
    const result = await git(['symbolic-ref', '--quiet', `${prefix}HEAD`], cwd);
    const target = result.stdout.trim();
    if (result.code !== 0 || !target.startsWith(prefix)) {
        throw new LocalRunLocationError(`Could not resolve ${remote}/HEAD`, 'RUN_LOCATION_INVALID_BASE');
    }
    return target.slice(prefix.length);
}
async function fetchBaseRef(remote, branch, cwd, progress) {
    const resolvedBranch = await resolveRemoteBranch(remote, branch, cwd);
    const ref = `refs/remotes/${remote}/${resolvedBranch}`;
    const validRef = await git(['check-ref-format', ref], cwd);
    if (!remote || remote.startsWith('-') || !resolvedBranch || validRef.code !== 0) {
        throw new LocalRunLocationError(`Invalid remote base "${remote}/${resolvedBranch}"`, 'RUN_LOCATION_INVALID_BASE');
    }
    progress.beginFetch(`${remote}/${resolvedBranch}`);
    // `--progress` keeps Git's transfer meter on the pipe so the UI can show it.
    const result = await gitStreaming([
        'fetch',
        '--progress',
        '--no-tags',
        '--no-recurse-submodules',
        '--',
        remote,
        `+refs/heads/${resolvedBranch}:${ref}`,
    ], cwd, { timeoutMs: UPSTREAM_FETCH_TIMEOUT_MS, onOutput: (text) => progress.fetchOutput(text) });
    if (result.code !== 0) {
        throw new LocalRunLocationError(`Failed to fetch latest ${remote}/${resolvedBranch}. Retry or turn off upstream refresh in Worktree settings: ${summarizeGitOutput(result.stderr) || summarizeGitOutput(result.stdout)}`, 'RUN_LOCATION_FETCH_FAILED');
    }
    progress.endFetch();
    return ref;
}
async function assertSafeBranchName(branch, cwd) {
    if (branch.startsWith('-') || branch.startsWith('@') || branch.includes('\0')) {
        throw new LocalRunLocationError(`Invalid git branch name "${branch}"`, 'RUN_LOCATION_INVALID_BRANCH');
    }
    const result = await git(['check-ref-format', `refs/heads/${branch}`], cwd);
    if (result.code !== 0) {
        throw new LocalRunLocationError(`Invalid git branch name "${branch}": ${result.stderr || result.stdout}`, 'RUN_LOCATION_INVALID_BRANCH');
    }
}
async function git(args, cwd) {
    try {
        const result = await execFile('git', args, {
            cwd,
            encoding: 'utf-8',
            env: { ...gitEnv(), GIT_TERMINAL_PROMPT: '0' },
        });
        return { code: 0, stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? '') };
    }
    catch (error) {
        const failure = error;
        return {
            code: typeof failure.code === 'number' ? failure.code : 1,
            stdout: bufferToString(failure.stdout),
            stderr: bufferToString(failure.stderr) || failure.message,
        };
    }
}
/** Bounded capture for the error text; live output goes to `onOutput` as it arrives. */
const MAX_CAPTURED_GIT_OUTPUT = 256 * 1024;
/**
 * Runs a long Git command with its output streamed to `onOutput`, so callers can
 * surface Git's progress meter while the command is still running.
 */
function gitStreaming(args, cwd, options = {}) {
    return new Promise((resolveResult) => {
        let stdout = '';
        let stderr = '';
        let settled = false;
        let timedOut = false;
        const stdoutDecoder = new TextDecoder();
        const stderrDecoder = new TextDecoder();
        const child = spawn('git', [...args], {
            cwd,
            env: { ...gitEnv(), GIT_TERMINAL_PROMPT: '0' },
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
        });
        const timer = options.timeoutMs === undefined
            ? undefined
            : setTimeout(() => {
                timedOut = true;
                child.kill();
            }, options.timeoutMs);
        timer?.unref?.();
        const forward = (text) => {
            if (!text)
                return;
            try {
                options.onOutput?.(text);
            }
            catch {
                // Progress observers never change the command outcome.
            }
        };
        child.stdout.on('data', (chunk) => {
            const text = stdoutDecoder.decode(chunk, { stream: true });
            stdout = keepTail(stdout + text);
            forward(text);
        });
        child.stderr.on('data', (chunk) => {
            const text = stderrDecoder.decode(chunk, { stream: true });
            stderr = keepTail(stderr + text);
            forward(text);
        });
        const settle = (code, failure) => {
            if (settled)
                return;
            settled = true;
            if (timer)
                clearTimeout(timer);
            stdout = keepTail(stdout + stdoutDecoder.decode());
            stderr = keepTail(stderr + stderrDecoder.decode());
            if (timedOut)
                stderr = `${stderr}\ngit ${args[0]} timed out after ${options.timeoutMs}ms`;
            else if (failure && !stderr.trim())
                stderr = failure;
            resolveResult({ code, stdout, stderr });
        };
        child.once('error', (error) => settle(1, error.message));
        child.once('close', (code, signal) => settle(code ?? 1, signal ? `git ${args[0]} terminated by ${signal}` : undefined));
    });
}
function keepTail(text) {
    return text.length > MAX_CAPTURED_GIT_OUTPUT ? text.slice(-MAX_CAPTURED_GIT_OUTPUT) : text;
}
/** Meter titles are translated; the `: NN% (done/total)` shape is not. */
const GIT_PROGRESS_LINE = /^(?:remote:\s*)?[^:]+:\s+\d{1,3}% \(\d+\/\d+\)/u;
/** Error text without the transfer/checkout meter lines `--progress` adds. */
function summarizeGitOutput(output) {
    return output
        .split(/\r\n|\r|\n/u)
        .map((line) => line.trimEnd())
        .filter((line) => line && !GIT_PROGRESS_LINE.test(line))
        .join('\n');
}
function gitEnv() {
    return Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
}
function optionalField(value, key) {
    const field = Reflect.get(value, key);
    return typeof field === 'string' && field.length > 0 ? { [key]: field } : {};
}
function bufferToString(value) {
    return Buffer.isBuffer(value) ? value.toString('utf-8') : String(value ?? '');
}
/**
 * Whether the Session's worktree was cleaned and can still be restored, read
 * inside a Turn admission transaction. Once the snapshot is known to be gone
 * (`restorable: false`) there is nothing to wait for, so the Session runs again.
 * Malformed metadata never blocks admission; the codec reports it elsewhere.
 */
export function sessionAwaitsWorktreeRestoreInTransaction(db, sessionId) {
    const row = db
        .select({ extraDataJson: sessions.extraDataJson })
        .from(sessions)
        .where(and(eq(sessions.sessionId, sessionId), eq(sessions.columnarVersion, 3)))
        .get();
    if (!row)
        return false;
    try {
        const location = parseSessionExtraData(row.extraDataJson).runLocation;
        return location?.cleanedAt !== undefined && location.restorable !== false;
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=run-location.js.map