import { execFile as execFileCallback, spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { WorkspaceGitCommandError } from '../contracts.js';
const execFile = promisify(execFileCallback);
const GIT_MAX_BUFFER = 16 * 1024 * 1024;
export async function git(args, workspace, options = {}) {
    if (options.signal?.aborted)
        throw abortError();
    try {
        const pending = execFile('git', ['-c', 'core.quotePath=false', '--no-optional-locks', ...args], {
            cwd: resolve(workspace),
            encoding: 'utf-8',
            env: gitEnv(),
            maxBuffer: GIT_MAX_BUFFER,
            ...(options.signal ? { signal: options.signal } : {}),
        });
        if (options.input !== undefined) {
            // An early Git exit can close stdin before all revisions are written.
            // execFile's completion reports the process failure to the caller.
            pending.child.stdin?.on('error', () => { });
            pending.child.stdin?.end(options.input);
        }
        const result = await pending;
        return { code: 0, stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? '') };
    }
    catch (error) {
        if (isAbortFailure(error, options.signal)) {
            throw abortError();
        }
        const err = error;
        return {
            code: typeof err.code === 'number' ? err.code : 1,
            stdout: bufferToString(err.stdout),
            stderr: bufferToString(err.stderr) || err.message,
        };
    }
}
/**
 * Runs Git without buffering stdout. Review search and untracked enumeration
 * use this path so repository-sized output never crosses execFile.maxBuffer.
 */
export async function gitStream(args, workspace, options) {
    if (options.signal?.aborted)
        throw abortError();
    return new Promise((resolvePromise, reject) => {
        const child = spawn('git', ['-c', 'core.quotePath=false', '--no-optional-locks', ...args], {
            cwd: resolve(workspace),
            env: gitEnv(),
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
        });
        const stdoutDecoder = new TextDecoder();
        const stderrDecoder = new TextDecoder();
        const stderrLimit = options.maxStderrBytes ?? 64 * 1024;
        let stderr = '';
        let settled = false;
        const cleanup = () => options.signal?.removeEventListener('abort', onAbort);
        const finishError = (error) => {
            if (settled)
                return;
            settled = true;
            cleanup();
            reject(error);
        };
        const onAbort = () => {
            child.kill();
            finishError(abortError());
        };
        options.signal?.addEventListener('abort', onAbort, { once: true });
        child.stdout.on('data', (chunk) => {
            if (settled)
                return;
            const text = stdoutDecoder.decode(chunk, { stream: true });
            if (text)
                options.onStdout(text);
        });
        child.stderr.on('data', (chunk) => {
            if (stderr.length >= stderrLimit)
                return;
            stderr += stderrDecoder.decode(chunk, { stream: true });
            if (stderr.length > stderrLimit)
                stderr = stderr.slice(0, stderrLimit);
        });
        child.on('error', finishError);
        child.on('close', (code) => {
            if (settled)
                return;
            settled = true;
            cleanup();
            const tail = stdoutDecoder.decode();
            if (tail)
                options.onStdout(tail);
            stderr += stderrDecoder.decode();
            resolvePromise({ code: code ?? 1, stderr });
        });
    });
}
export function requireGitSuccess(result, operation) {
    if (result.code !== 0) {
        throw new WorkspaceGitCommandError(operation, result.code, (result.stderr || result.stdout).trim());
    }
    return result;
}
function gitEnv() {
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
        if (key.startsWith('GIT_'))
            delete env[key];
    }
    return env;
}
function abortError() {
    const error = new Error('Git operation aborted');
    error.name = 'AbortError';
    return error;
}
function isAbortFailure(error, signal) {
    return signal?.aborted === true || (error instanceof Error && error.name === 'AbortError');
}
function bufferToString(value) {
    return Buffer.isBuffer(value) ? value.toString('utf-8') : String(value ?? '');
}
//# sourceMappingURL=git-process.js.map