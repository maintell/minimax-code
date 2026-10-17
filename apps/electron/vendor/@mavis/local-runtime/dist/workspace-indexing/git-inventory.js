import { spawn } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
const STDERR_MAX_BYTES = 64 * 1024;
export async function appendGitWorkspacePaths(input) {
    input.signal?.throwIfAborted();
    if (!Number.isInteger(input.maxFiles) || input.maxFiles < 0) {
        throw new Error(`invalid_git_inventory_limit:${input.maxFiles}`);
    }
    const child = spawn('git', ['-c', 'core.quotepath=false', 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
        cwd: input.workspaceDir,
        env: cleanGitEnv(),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 60_000,
        ...(input.signal ? { signal: input.signal } : {}),
    });
    const stdoutDecoder = new StringDecoder('utf8');
    let pending = '';
    const stderrChunks = [];
    let stderrBytes = 0;
    let limitExceeded = input.paths.size > input.maxFiles;
    const acceptRecord = (record) => {
        if (limitExceeded || record.length === 0)
            return;
        const normalized = record.replaceAll('\\', '/');
        if (!input.includePath(normalized))
            return;
        input.paths.add(normalized);
        if (input.paths.size > input.maxFiles) {
            limitExceeded = true;
            child.kill();
        }
    };
    child.stdout.on('data', (chunk) => {
        if (limitExceeded)
            return;
        pending += stdoutDecoder.write(chunk);
        let separatorIndex = pending.indexOf('\0');
        while (separatorIndex >= 0 && !limitExceeded) {
            acceptRecord(pending.slice(0, separatorIndex));
            pending = pending.slice(separatorIndex + 1);
            separatorIndex = pending.indexOf('\0');
        }
    });
    child.stderr.on('data', (chunk) => {
        if (stderrBytes >= STDERR_MAX_BYTES)
            return;
        const bounded = chunk.subarray(0, STDERR_MAX_BYTES - stderrBytes);
        stderrChunks.push(bounded);
        stderrBytes += bounded.byteLength;
    });
    const outcome = await new Promise((resolve) => {
        let settled = false;
        const finish = (result) => {
            if (settled)
                return;
            settled = true;
            resolve(result);
        };
        child.once('error', (error) => finish({ code: null, error }));
        child.once('close', (code) => finish({ code }));
    });
    if (limitExceeded)
        return { status: 'limit_exceeded' };
    input.signal?.throwIfAborted();
    pending += stdoutDecoder.end();
    if (pending.length > 0)
        acceptRecord(pending);
    if (limitExceeded)
        return { status: 'limit_exceeded' };
    if (outcome.code === 0)
        return { status: 'complete' };
    const stderrText = Buffer.concat(stderrChunks, stderrBytes).toString('utf8').trim();
    const hasGitMetadata = await lstat(path.join(input.workspaceDir, '.git'))
        .then(() => true)
        .catch((error) => {
        if (error.code === 'ENOENT')
            return false;
        throw error;
    });
    if (!hasGitMetadata && stderrText.includes('not a git repository')) {
        return { status: 'not_repository' };
    }
    return {
        status: 'failed',
        message: outcome.error?.message || stderrText || `git_ls_files_exit_${outcome.code ?? 'error'}`,
    };
}
function cleanGitEnv() {
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
        if (key.startsWith('GIT_'))
            delete env[key];
    }
    return env;
}
//# sourceMappingURL=git-inventory.js.map