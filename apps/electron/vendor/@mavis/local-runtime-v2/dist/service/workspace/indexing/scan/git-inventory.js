import { spawn } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
const STDERR_MAX_BYTES = 64 * 1024;
/**
 * Filtering inventory paths is synchronous CPU work over tens of thousands of
 * records in large repositories. It runs inside the runtime process, so it
 * yields this often to keep streaming turns and requests responsive.
 */
export const INVENTORY_FILTER_SLICE_MS = 8;
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
    // Consumed as an async iterator rather than 'data' events: libuv drains a
    // ready pipe in one poll pass, so event handlers would filter the whole
    // inventory in a single blocking turn. Pausing here applies backpressure.
    const consumeStdout = async () => {
        let sliceStartedMs = performance.now();
        for await (const chunk of child.stdout) {
            if (limitExceeded)
                return;
            pending += stdoutDecoder.write(chunk);
            let recordStart = 0;
            let separatorIndex = pending.indexOf('\0');
            while (separatorIndex >= 0 && !limitExceeded) {
                acceptRecord(pending.slice(recordStart, separatorIndex));
                recordStart = separatorIndex + 1;
                separatorIndex = pending.indexOf('\0', recordStart);
                if (performance.now() - sliceStartedMs >= INVENTORY_FILTER_SLICE_MS) {
                    await yieldToEventLoop();
                    sliceStartedMs = performance.now();
                }
            }
            pending = pending.slice(recordStart);
        }
    };
    child.stderr.on('data', (chunk) => {
        if (stderrBytes >= STDERR_MAX_BYTES)
            return;
        const bounded = chunk.subarray(0, STDERR_MAX_BYTES - stderrBytes);
        stderrChunks.push(bounded);
        stderrBytes += bounded.byteLength;
    });
    const closed = new Promise((resolve) => {
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
    try {
        await consumeStdout();
    }
    catch (error) {
        // An aborted or failed read surfaces through the child's own outcome.
        child.kill();
        if (!input.signal?.aborted)
            throw error;
    }
    const outcome = await closed;
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
    return resolveGitFailure(input.workspaceDir, outcome, Buffer.concat(stderrChunks, stderrBytes));
}
async function hasGitMetadata(workspaceDir) {
    try {
        await lstat(path.join(workspaceDir, '.git'));
        return true;
    }
    catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
            return false;
        throw error;
    }
}
async function resolveGitFailure(workspaceDir, outcome, stderr) {
    const stderrText = stderr.toString('utf8').trim();
    if (!(await hasGitMetadata(workspaceDir)) && stderrText.includes('not a git repository')) {
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