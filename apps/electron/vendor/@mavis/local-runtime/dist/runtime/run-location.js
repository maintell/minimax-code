import { execFile as execFileCallback } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { generateDefaultWorktreeBranch } from '../worktrees/branch.js';
const execFile = promisify(execFileCallback);
export class LocalRunLocationError extends Error {
    code;
    status;
    constructor(message, code, status = 400) {
        super(message);
        this.name = 'LocalRunLocationError';
        this.code = code;
        this.status = status;
    }
}
export function readLocalRunLocationInput(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return undefined;
    const record = value;
    const mode = record.mode;
    if (mode !== 'current' && mode !== 'new-worktree' && mode !== 'existing-worktree') {
        throw new LocalRunLocationError(`Unknown runLocation.mode "${String(mode)}"`, 'RUN_LOCATION_INVALID_MODE');
    }
    return {
        mode,
        ...readOptionalString(record, 'worktreeDir'),
        ...readOptionalString(record, 'branch'),
        ...readOptionalString(record, 'newWorktreeBranch'),
        ...readOptionalString(record, 'newWorktreeBase'),
    };
}
export async function applyLocalRunLocation(input, workspaceDir, nowMs) {
    const createdAt = nowMs();
    if (input.mode === 'current') {
        if (input.branch) {
            await assertSafeBranchName(input.branch, workspaceDir);
            const checkout = await git(['checkout', input.branch], workspaceDir);
            if (checkout.code !== 0) {
                throw new LocalRunLocationError(`Failed to checkout branch "${input.branch}" in ${workspaceDir}: ${checkout.stderr || checkout.stdout}`, 'RUN_LOCATION_CHECKOUT_FAILED');
            }
        }
        return {
            mode: 'current',
            resolvedDir: workspaceDir,
            ...(input.branch ? { resolvedBranch: input.branch } : {}),
            createdAt,
        };
    }
    if (input.mode === 'new-worktree') {
        const branch = input.newWorktreeBranch ?? input.branch ?? generateDefaultWorktreeBranch(createdAt);
        await assertSafeBranchName(branch, workspaceDir);
        if (input.newWorktreeBase)
            assertSafeBaseRef(input.newWorktreeBase);
        const worktreeParentDir = await resolveSafeWorktreeParent(workspaceDir);
        const targetDir = join(worktreeParentDir, branch.replace(/\//g, '-'));
        const addArgs = ['worktree', 'add', '-b', branch, targetDir];
        if (input.newWorktreeBase)
            addArgs.push(input.newWorktreeBase);
        const result = await git(addArgs, workspaceDir);
        if (result.code !== 0) {
            throw new LocalRunLocationError(`git worktree add failed: ${result.stderr || result.stdout}`, 'RUN_LOCATION_WORKTREE_ADD_FAILED');
        }
        return {
            mode: 'new-worktree',
            resolvedDir: targetDir,
            resolvedBranch: branch,
            parentRepoDir: workspaceDir,
            createdAt,
        };
    }
    if (!input.worktreeDir) {
        throw new LocalRunLocationError('runLocation.mode="existing-worktree" requires `worktreeDir`', 'RUN_LOCATION_WORKTREE_DIR_REQUIRED');
    }
    if (!isAbsolute(input.worktreeDir)) {
        throw new LocalRunLocationError(`runLocation.worktreeDir must be an absolute path, got "${input.worktreeDir}"`, 'RUN_LOCATION_WORKTREE_DIR_NOT_ABSOLUTE');
    }
    if (!existsSync(input.worktreeDir)) {
        throw new LocalRunLocationError(`Worktree directory does not exist: ${input.worktreeDir}`, 'RUN_LOCATION_WORKTREE_NOT_FOUND');
    }
    if (input.branch) {
        await assertSafeBranchName(input.branch, input.worktreeDir);
        const checkout = await git(['checkout', input.branch], input.worktreeDir);
        if (checkout.code !== 0) {
            throw new LocalRunLocationError(`Failed to checkout branch "${input.branch}" in ${input.worktreeDir}: ${checkout.stderr || checkout.stdout}`, 'RUN_LOCATION_CHECKOUT_FAILED');
        }
    }
    return {
        mode: 'existing-worktree',
        resolvedDir: input.worktreeDir,
        ...(input.branch ? { resolvedBranch: input.branch } : {}),
        parentRepoDir: workspaceDir,
        createdAt,
    };
}
async function resolveSafeWorktreeParent(workspaceDir) {
    const workspaceReal = await realpath(workspaceDir);
    const worktreeParentDir = join(workspaceDir, '.worktrees');
    await mkdir(worktreeParentDir, { recursive: true });
    const worktreeParentReal = await realpath(worktreeParentDir);
    if (!isPathInside(workspaceReal, worktreeParentReal)) {
        throw new LocalRunLocationError(`Refusing to create worktree outside workspace: ${worktreeParentDir}`, 'RUN_LOCATION_WORKTREE_PARENT_ESCAPES');
    }
    return worktreeParentReal;
}
function isPathInside(parent, child) {
    const rel = relative(resolve(parent), resolve(child));
    return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel));
}
function assertSafeBaseRef(baseRef) {
    if (baseRef.startsWith('-') || baseRef.includes('\0')) {
        throw new LocalRunLocationError(`Invalid git base ref "${baseRef}"`, 'RUN_LOCATION_INVALID_BASE');
    }
}
async function assertSafeBranchName(branch, cwd) {
    if (branch.startsWith('-') || branch.startsWith('@') || branch.includes('\0')) {
        throw new LocalRunLocationError(`Invalid git branch name "${branch}"`, 'RUN_LOCATION_INVALID_BRANCH');
    }
    const check = await git(['check-ref-format', `refs/heads/${branch}`], cwd);
    if (check.code !== 0) {
        throw new LocalRunLocationError(`Invalid git branch name "${branch}": ${check.stderr || check.stdout}`, 'RUN_LOCATION_INVALID_BRANCH');
    }
}
async function git(args, cwd) {
    try {
        const result = await execFile('git', args, { cwd, encoding: 'utf-8', env: gitEnv() });
        return { code: 0, stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? '') };
    }
    catch (error) {
        const err = error;
        return {
            code: typeof err.code === 'number' ? err.code : 1,
            stdout: bufferToString(err.stdout),
            stderr: bufferToString(err.stderr) || err.message,
        };
    }
}
function gitEnv() {
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
        if (key.startsWith('GIT_'))
            delete env[key];
    }
    return env;
}
function readOptionalString(record, key) {
    const value = record[key];
    return typeof value === 'string' && value.length > 0 ? { [key]: value } : {};
}
function bufferToString(value) {
    return Buffer.isBuffer(value) ? value.toString('utf-8') : String(value ?? '');
}
//# sourceMappingURL=run-location.js.map