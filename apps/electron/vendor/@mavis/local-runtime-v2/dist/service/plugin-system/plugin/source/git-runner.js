import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
export class GitCommandError extends Error {
    category;
    constructor(category, message, options) {
        super(message, options);
        this.category = category;
        this.name = 'GitCommandError';
    }
}
// Ordered: the first matching class wins. Messages are stable because every
// command runs with LC_ALL=C.
const FAILURE_PATTERNS = [
    ['REPO_EMPTY', /empty repository|remote HEAD refers to nonexistent ref/iu],
    [
        'AUTH_REQUIRED',
        /could not read (?:username|password)|terminal prompts disabled|authentication (?:failed|required)|permission denied \(|host key verification failed|returned error: 40[13]\b|access denied|invalid (?:username or password|credentials)/iu,
    ],
    [
        'REF_NOT_FOUND',
        /remote branch .+ not found|couldn't find remote ref|not our ref|unadvertised object|unknown revision|bad revision|invalid reference|did not match any|no such ref|reference is not a tree|not a valid object name/iu,
    ],
    ['PATH_NOT_FOUND', /does not exist in '|exists on disk, but not in/iu],
];
/**
 * The only way plugin code starts git. Every command is non-interactive:
 * a missing credential fails instead of prompting on a terminal, a GUI
 * credential manager, or an SSH passphrase dialog.
 */
export async function runGit(args, options = {}) {
    const pending = execFileAsync('git', [...args], {
        cwd: options.cwd,
        env: gitCommandEnvironment(process.env),
        signal: options.signal,
        timeout: options.timeoutMs ?? GIT_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: MAX_OUTPUT_BYTES,
        encoding: 'utf8',
    });
    if (options.input !== undefined)
        pending.child?.stdin?.end(options.input);
    try {
        const { stdout, stderr } = await pending;
        return { stdout: String(stdout), stderr: String(stderr) };
    }
    catch (error) {
        // Caller cancellation stays an abort; only git's own failures are classified.
        if (options.signal?.aborted)
            throw error;
        throw classifyGitFailure(subcommandOf(args), error, await isMissingDirectory(options.cwd));
    }
}
/**
 * The user's own git configuration (`url.<base>.insteadOf`, credential
 * helpers, `GIT_SSH_COMMAND`) is trusted and kept: it is how they reach their
 * hosts, and pinning transports here would break an https-to-ssh rewrite.
 * Input URLs are restricted at the parsing boundary instead (GitRemote), git
 * never allows `ext` by default, and clones never recurse into submodules.
 *
 * @internal Exported for focused environment tests.
 */
export function gitCommandEnvironment(base) {
    const env = {
        ...base,
        GIT_TERMINAL_PROMPT: '0',
        GCM_INTERACTIVE: 'never',
        // Empty, not unset: git then skips core.askPass and SSH_ASKPASS, so an
        // inherited GUI askpass program cannot open a credential dialog.
        GIT_ASKPASS: '',
        // Plugin packages never need LFS payloads; skipping avoids a second download path.
        GIT_LFS_SKIP_SMUDGE: '1',
        LC_ALL: 'C',
    };
    // Respect an explicit user SSH command (custom keys, jump hosts).
    if (!base.GIT_SSH_COMMAND && !base.GIT_SSH)
        env.GIT_SSH_COMMAND = 'ssh -o BatchMode=yes';
    return env;
}
function classifyGitFailure(command, error, cwdMissing) {
    const details = isRecord(error) ? error : {};
    if (details.code === 'ENOENT') {
        // Node reports a missing working directory as ENOENT of the executable.
        return cwdMissing
            ? new GitCommandError('PATH_NOT_FOUND', 'git working directory is missing', { cause: error })
            : new GitCommandError('GIT_UNAVAILABLE', 'git executable was not found', { cause: error });
    }
    if (details.killed === true) {
        return new GitCommandError('TIMEOUT', `git ${command} timed out`, { cause: error });
    }
    const stderr = typeof details.stderr === 'string' ? details.stderr : '';
    const category = FAILURE_PATTERNS.find(([, pattern]) => pattern.test(stderr))?.[0];
    // The message never repeats stderr: it may contain repository paths.
    return new GitCommandError(category ?? 'UNREACHABLE', `git ${command} failed`, {
        cause: error,
    });
}
function subcommandOf(args) {
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index] ?? '';
        if (arg === '-C' || arg === '-c')
            index += 1;
        else if (!arg.startsWith('-'))
            return arg;
    }
    return 'command';
}
async function isMissingDirectory(directory) {
    if (!directory)
        return false;
    try {
        return !(await stat(directory)).isDirectory();
    }
    catch {
        return true;
    }
}
function isRecord(value) {
    return typeof value === 'object' && value !== null;
}
//# sourceMappingURL=git-runner.js.map