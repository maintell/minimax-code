import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { win32 } from 'node:path';
/**
 * Cold PowerShell 5.1 starts behind Defender/AMSI routinely exceed 3s; a
 * probe that times out must not turn a healthy shell into a failed command.
 */
const PROBE_TIMEOUT_MS = 10_000;
async function statFingerprint(path) {
    try {
        const info = await stat(path);
        return info.isFile() ? `${info.size}:${info.mtimeMs}` : undefined;
    }
    catch {
        return undefined;
    }
}
function validVersion(family, lines) {
    const version = lines[0]?.trim() ?? '';
    if (family === 'git-bash')
        return /^\d+\.\d+/u.test(version) && /^(?:msys|cygwin)$/u.test(lines[1]?.trim() ?? '');
    if (family === 'pwsh')
        return Number(version.split('.')[0]) >= 7;
    return /^5\.1(?:\.|$)/u.test(version);
}
function probeFailureReason(error) {
    const failure = error;
    // execFile kills the child on maxBuffer overflow too; that is not a timeout.
    if (failure?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER')
        return 'probe-failed';
    if (failure?.code === 'ETIMEDOUT' || failure?.killed)
        return 'probe-timed-out';
    if (failure?.code === 'EACCES' || failure?.code === 'EPERM')
        return 'probe-access-denied';
    if (failure?.code === 'ENOENT')
        return 'not-installed';
    return 'probe-failed';
}
/** Fixed probes only. User commands never enter discovery or version detection. */
export function createWindowsShellDetector(options = {}) {
    const env = options.environment ?? process.env;
    const run = options.run ??
        ((file, args) => new Promise((resolve, reject) => {
            execFile(file, [...args], {
                windowsHide: true,
                timeout: PROBE_TIMEOUT_MS,
                maxBuffer: 64 * 1024,
                encoding: 'utf8',
                env,
            }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
        }));
    const fingerprint = options.fingerprint ?? statFingerprint;
    const root = env.SystemRoot ?? env.windir ?? 'C:\\Windows';
    const where = async (name) => {
        try {
            return (await run(win32.join(root, 'System32', 'where.exe'), [name]))
                .split(/\r?\n/u)
                .map((path) => path.trim())
                .filter((path) => win32.isAbsolute(path))
                .slice(0, 8);
        }
        catch {
            return [];
        }
    };
    const gitFor = (bashPath) => win32.join(win32.dirname(bashPath), '..', 'cmd', 'git.exe');
    const spawnProbe = async (family, executablePath) => {
        try {
            if (family === 'git-bash') {
                const git = gitFor(executablePath);
                if (!/^git version \d+\..*\.windows\./u.test((await run(git, ['--version'])).trim())) {
                    return { family, available: false, reason: 'not-git-for-windows' };
                }
            }
            const output = await run(executablePath, family === 'git-bash'
                ? ['--noprofile', '--norc', '-c', 'printf "%s\\n%s\\n" "$BASH_VERSION" "$OSTYPE"']
                : ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()']);
            const lines = output.trim().split(/\r?\n/u);
            const version = lines[0]?.trim() ?? '';
            if (!validVersion(family, lines))
                return { family, available: false, reason: 'unexpected-shell-version' };
            return { family, available: true, executablePath, version };
        }
        catch (error) {
            return { family, available: false, reason: probeFailureReason(error) };
        }
    };
    /**
     * Successful probes keyed by family + path and the on-disk identity of every
     * probed binary. Commands run once per tool call, so re-spawning a shell
     * before each one only adds latency and a timeout window; an unchanged file
     * cannot change its version. Failures are never cached so recovery is
     * immediate, and concurrent first probes share one child process.
     */
    const verified = new Map();
    const inflight = new Map();
    const probe = async (family, executablePath) => {
        // File metadata only controls cache reuse. Fixed process probes decide availability,
        // including Windows execution aliases whose filesystem checks may disagree.
        const key = `${family}\u0000${executablePath.toLowerCase()}`;
        const parts = await Promise.all((family === 'git-bash' ? [executablePath, gitFor(executablePath)] : [executablePath]).map((path) => fingerprint(path)));
        const identity = parts.every(Boolean) ? parts.join('|') : undefined;
        // The cache key folds case, so echo this request's spelling back: callers
        // compare the returned path strictly against their persisted binding.
        const asRequested = (candidate) => candidate.available ? { ...candidate, executablePath } : candidate;
        const cached = verified.get(key);
        if (identity && cached?.identity === identity)
            return asRequested(cached.candidate);
        const flightKey = `${key}\u0000${identity ?? ''}`;
        let pending = inflight.get(flightKey);
        if (!pending) {
            pending = (async () => {
                try {
                    return await spawnProbe(family, executablePath);
                }
                finally {
                    inflight.delete(flightKey);
                }
            })();
            inflight.set(flightKey, pending);
        }
        const candidate = await pending;
        if (identity && candidate.available)
            verified.set(key, { identity, candidate });
        else
            verified.delete(key);
        return asRequested(candidate);
    };
    const first = async (family, paths) => {
        let failure = { family, available: false, reason: 'not-installed' };
        const seen = new Set();
        for (const path of paths) {
            if (!path || seen.has(path.toLowerCase()))
                continue;
            seen.add(path.toLowerCase());
            const candidate = await probe(family, path);
            if (candidate.available)
                return candidate;
            if (candidate.reason !== 'not-installed')
                failure = candidate;
        }
        return failure;
    };
    return {
        async detect() {
            const [pwshPaths, gitPaths] = await Promise.all([where('pwsh.exe'), where('git.exe')]);
            const gitBashPaths = gitPaths.map((path) => {
                const directory = win32.dirname(path);
                if (win32.basename(directory).toLowerCase() === 'cmd')
                    return win32.join(directory, '..', 'bin', 'bash.exe');
                if (/[\\/]Git[\\/]/iu.test(path))
                    return win32.join(directory, 'bash.exe');
                return undefined;
            });
            return Promise.all([
                first('pwsh', [
                    ...pwshPaths,
                    env.ProgramFiles && win32.join(env.ProgramFiles, 'PowerShell', '7', 'pwsh.exe'),
                ]),
                first('windows-powershell', [
                    win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
                ]),
                first('git-bash', [
                    ...[env.ProgramFiles, env.ProgramW6432, env['ProgramFiles(x86)']].map((path) => path && win32.join(path, 'Git', 'bin', 'bash.exe')),
                    env.LOCALAPPDATA && win32.join(env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe'),
                    ...gitBashPaths,
                ]),
            ]);
        },
        validate: (shell) => probe(shell.family, shell.executablePath),
    };
}
//# sourceMappingURL=windows-shell-detector.js.map