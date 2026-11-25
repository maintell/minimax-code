/**
 * Git commands the merge request actions run on the user's machine: removing a
 * Session's worktree after a merge, and reading and pushing its branch before a
 * merge request is created. Requests to GitLab and GitHub never go through here.
 */
/** Reads finish in well under a second; the limit only guards against a hung process. */
const READ_TIMEOUT_MS = 15_000;
/** git exits with 124 when a command is stopped this way, as timeout(1) does. */
const TIMED_OUT_CODE = 124;
/** Runs git and turns a command still running after `timeoutMs` into a failed result. */
export async function runGit(git, args, cwd, timeoutMs = READ_TIMEOUT_MS) {
    const signal = AbortSignal.timeout(timeoutMs);
    try {
        return await git(args, cwd, { signal });
    }
    catch (error) {
        if (!signal.aborted)
            throw error;
        return {
            code: TIMED_OUT_CODE,
            stdout: '',
            stderr: `git ${args[0] ?? ''} did not finish within ${String(Math.round(timeoutMs / 1_000))} s`,
        };
    }
}
/** Trimmed output of a command that succeeded; undefined when git failed. */
async function gitOutput(git, args, cwd) {
    const result = await runGit(git, args, cwd);
    return result.code === 0 ? result.stdout.trim() : undefined;
}
/** Whether a ref or commit exists locally. */
export async function commitExists(git, cwd, rev) {
    return ((await gitOutput(git, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`], cwd)) !==
        undefined);
}
/** Commits `git rev-list --count` finds for the arguments; undefined when git cannot count them. */
export async function countCommits(git, cwd, args) {
    const output = await gitOutput(git, ['rev-list', '--count', ...args], cwd);
    const count = output === undefined ? Number.NaN : Number(output);
    return Number.isSafeInteger(count) && count >= 0 ? count : undefined;
}
/**
 * The remote a branch is pushed to, chosen the way the workspace repository is
 * read (readWorkspaceRemote): the branch's upstream remote, else "origin", else
 * the first remote. Undefined when the repository has no remote.
 */
export async function pushRemote(git, cwd, branch) {
    const [listed, upstream] = await Promise.all([
        gitOutput(git, ['remote'], cwd),
        gitOutput(git, ['config', '--get', `branch.${branch}.remote`], cwd),
    ]);
    const remotes = (listed ?? '').split(/\r?\n/u).filter((name) => name.length > 0);
    if (upstream && remotes.includes(upstream))
        return upstream;
    if (remotes.includes('origin'))
        return 'origin';
    return remotes[0];
}
/** A commit sha from a platform answer, checked before it reaches a git command line. */
export function isCommitSha(value) {
    return value !== undefined && /^[0-9a-f]{7,64}$/iu.test(value);
}
/** The lines of git's error output that say what went wrong, without hints and progress. */
export function gitFailureMessage(result, fallback) {
    const lines = `${result.stderr}\n${result.stdout}`
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith('hint:') && !line.includes('\r'));
    const text = lines.slice(-4).join('\n');
    if (!text)
        return fallback;
    return text.length > 500 ? `${text.slice(0, 500)}…` : text;
}
//# sourceMappingURL=git-command.js.map