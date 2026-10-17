import { createHash, randomBytes } from "node:crypto";
import { spawn as child_processSpawn } from "node:child_process";
import { realpath, lstat, access, open, mkdir, mkdtemp, chmod, rm, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { validateSanitizedSourceHandle, resolveSanitizedSourcePath } from "../sanitized-source";
import { noopDocumentPreviewLogger } from "../logging";
const STDERR_STDOUT_LIMIT = 64 * 1024;
const DEFAULT_PROBE_TIMEOUT_MS = 2000;
const DEFAULT_CONVERSION_TIMEOUT_MS = 60000;
const PROCESS_KILL_GRACE_MS = 2000;
const PROCESS_TREE_SETTLEMENT_TIMEOUT_MS = PROCESS_KILL_GRACE_MS * 2;
const PROCESS_GROUP_POLL_MS = 25;
const WINDOWS_OWNER_POLL_MS = 25;
// Windows has no POSIX-style process group that Node can probe after the
// converter's direct process exits.  Keep this trusted wrapper alive as the
// root of the native tree, publish the real soffice exit code through a
// private file, then terminate the still-live root with taskkill /T /F.  This
// avoids targeting an exited/reused soffice PID while preserving taskkill's
// observed close(0) as the only Windows whole-tree proof.
const WINDOWS_PROCESS_OWNER_SCRIPT = String.raw `
$ErrorActionPreference = 'Stop'
function Decode-OwnerValue([string] $value) {
  return [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($value))
}
$executable = Decode-OwnerValue $env:MAVIS_OFFICE_OWNER_EXECUTABLE_B64
$argumentsJson = Decode-OwnerValue $env:MAVIS_OFFICE_OWNER_ARGS_B64
$arguments = @(ConvertFrom-Json -InputObject $argumentsJson)
$completionPath = $env:MAVIS_OFFICE_OWNER_COMPLETION
$completionTempPath = "$completionPath.tmp"
Remove-Item Env:MAVIS_OFFICE_OWNER_EXECUTABLE_B64 -ErrorAction SilentlyContinue
Remove-Item Env:MAVIS_OFFICE_OWNER_ARGS_B64 -ErrorAction SilentlyContinue
Remove-Item Env:MAVIS_OFFICE_OWNER_COMPLETION -ErrorAction SilentlyContinue
try {
  & $executable @arguments
  if ($null -eq $LASTEXITCODE) { throw 'soffice_exit_code_missing' }
  $payload = @{ exitCode = [int]$LASTEXITCODE } | ConvertTo-Json -Compress
} catch {
  $payload = @{ exitCode = $null; error = 'soffice_spawn_failed' } | ConvertTo-Json -Compress
}
$encoding = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($completionTempPath, $payload, $encoding)
Move-Item -LiteralPath $completionTempPath -Destination $completionPath -Force
while ($true) { [System.Threading.Thread]::Sleep(60000) }
`;
const WINDOWS_PROCESS_OWNER_SCRIPT_B64 = Buffer.from(WINDOWS_PROCESS_OWNER_SCRIPT, 'utf16le').toString('base64');
export function getLibreOfficeCandidates(options = {}) {
    const tuple = runtimeTuple(options.platform, options.arch);
    return tuple ? candidateList(options, tuple) : [];
}
function runtimeTuple(platform = process.platform, arch = process.arch) {
    const normalizedPlatform = platform === 'darwin' || platform === 'win32' || platform === 'linux' || platform === 'freebsd'
        ? platform
        : 'unknown';
    if (normalizedPlatform === 'unknown')
        return null;
    if (arch !== 'x64' && arch !== 'arm64')
        return null;
    return { platform: normalizedPlatform, arch };
}
export function getLibreOfficeRuntimeTuple() {
    return runtimeTuple();
}
function uniquePaths(paths) {
    const seen = new Set();
    const result = [];
    for (const value of paths) {
        if (!value || seen.has(value))
            continue;
        seen.add(value);
        result.push(value);
    }
    return result;
}
function executableName(tuple) {
    return tuple.platform === 'win32' ? 'soffice.exe' : 'soffice';
}
function pathEntries(env, tuple) {
    const raw = env.PATH ?? '';
    const delimiter = tuple.platform === 'win32' ? ';' : path.delimiter;
    return raw.split(delimiter).filter(Boolean);
}
function defaultWellKnownPaths(tuple, env) {
    const home = env.HOME || env.USERPROFILE || os.homedir();
    const executable = executableName(tuple);
    const join = tuple.platform === 'win32' ? path.win32.join : path.join;
    if (tuple.platform === 'win32') {
        const programFiles = env.ProgramFiles || 'C:\\Program Files';
        const programFilesX86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
        const localAppData = env.LOCALAPPDATA || join(home, 'AppData', 'Local');
        return [
            join(programFiles, 'LibreOffice', 'program', executable),
            join(programFilesX86, 'LibreOffice', 'program', executable),
            join(localAppData, 'Programs', 'LibreOffice', 'program', executable),
            join(localAppData, 'Microsoft', 'WinGet', 'Links', executable),
            join(home, 'scoop', 'shims', executable),
        ];
    }
    const result = [
        path.join(home, '.local', 'bin', executable),
        path.join(home, 'Applications', 'LibreOffice.app', 'Contents', 'MacOS', executable),
    ];
    if (tuple.platform === 'darwin') {
        result.push(path.join('/Applications', 'LibreOffice.app', 'Contents', 'MacOS', executable));
    }
    else {
        result.push('/usr/local/bin/soffice', '/usr/bin/soffice');
    }
    return result;
}
function parseVersion(output) {
    const match = output.match(/(?:LibreOffice|soffice)[^\d]*(\d+(?:\.\d+){1,3})/iu) ??
        output.match(/\b(\d+\.\d+(?:\.\d+){0,2})\b/u);
    return match?.[1];
}
function architectureMatches(output, tuple) {
    const lower = output.toLowerCase();
    const saysArm = /(?:arm64|aarch64|armv8)/u.test(lower);
    const saysX64 = /(?:x86_64|amd64|x64)/u.test(lower);
    if (tuple.arch === 'arm64')
        return !saysX64 || saysArm;
    return !saysArm;
}
function appendBounded(current, chunk) {
    if (current.length >= STDERR_STDOUT_LIMIT)
        return current;
    const value = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    return (current + value).slice(0, STDERR_STDOUT_LIMIT);
}
function spawnProbe(candidate, options) {
    return new Promise((resolve) => {
        let child;
        try {
            child = options.spawn(candidate, ['--version'], {
                // LibreOffice is an external executable; do not pass the Electron
                // process's full environment (which may contain API keys or session
                // tokens) merely to probe its version.
                env: minimalLibreOfficeEnv(options.env),
                stdio: ['ignore', 'pipe', 'pipe'],
                windowsHide: true,
            });
        }
        catch (error) {
            resolve({ ok: false, reason: error instanceof Error ? error.message : 'spawn_failed' });
            return;
        }
        let stdout = '';
        let stderr = '';
        let settled = false;
        let killWaitTimer;
        const finish = (result) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            if (killWaitTimer)
                clearTimeout(killWaitTimer);
            resolve(result);
        };
        child.stdout?.on('data', (chunk) => {
            stdout = appendBounded(stdout, chunk);
        });
        child.stderr?.on('data', (chunk) => {
            stderr = appendBounded(stderr, chunk);
        });
        child.once('error', (error) => finish({ ok: false, stdout, stderr, reason: error.message }));
        child.once('close', (code) => {
            const combined = `${stdout}\n${stderr}`;
            const version = parseVersion(combined);
            if (code !== 0 || !version) {
                finish({ ok: false, stdout, stderr, reason: `version_probe_exit_${code ?? 'unknown'}` });
                return;
            }
            if (!architectureMatches(combined, options.tuple)) {
                finish({ ok: false, stdout, stderr, version, reason: 'architecture_mismatch' });
                return;
            }
            finish({ ok: true, stdout, stderr, version });
        });
        const timer = setTimeout(() => {
            try {
                child.kill('SIGKILL');
            }
            catch {
                /* already exited */
            }
            // Wait for the child close event before resolving.  Resolving at the
            // instant SIGKILL is sent leaves a still-running probe overlapping the
            // next candidate and can turn a deterministic architecture mismatch
            // into a second timeout under process pressure.
            killWaitTimer = setTimeout(() => finish({ ok: false, stdout, stderr, reason: 'version_probe_timeout' }), PROCESS_KILL_GRACE_MS);
        }, options.timeoutMs);
    });
}
/**
 * Return a canonical executable path only after validating the final target.
 * System LibreOffice launchers are commonly symlinks (for example
 * `/usr/bin/soffice`), so rejecting every symlink makes an otherwise valid
 * installation invisible. Resolving first and probing the canonical target
 * also prevents a later PATH/symlink swap from changing what gets spawned.
 */
async function resolveExecutable(candidate, tuple) {
    try {
        const canonical = await realpath(candidate);
        const info = await lstat(canonical);
        if (!info.isFile() || info.isSymbolicLink())
            return null;
        if (tuple.platform === 'win32')
            return canonical;
        // Do not execute a writable-by-group/other binary discovered through PATH.
        if ((Number(info.mode) & 0o022) !== 0)
            return null;
        await access(canonical, constants.X_OK);
        return canonical;
    }
    catch {
        return null;
    }
}
function minimalLibreOfficeEnv(input) {
    const allowed = new Set([
        'PATH',
        'HOME',
        'USERPROFILE',
        'TEMP',
        'TMP',
        'TMPDIR',
        'SystemRoot',
        'WINDIR',
        'LANG',
        'LC_ALL',
        // Test harness controls are intentionally opt-in and harmless; production
        // environments do not define them.
        'FAKE_SOFFICE_MODE',
        'FAKE_SOFFICE_ARGS_FILE',
    ]);
    return Object.fromEntries(Object.entries(input).filter(([key, value]) => allowed.has(key) && value !== undefined));
}
function candidateList(options, tuple) {
    const env = options.env ?? process.env;
    const managed = [options.managedPath, ...(options.managedPaths ?? [])].filter((value) => Boolean(value));
    const explicit = options.candidates ?? [];
    // An explicit candidate list is a closed test/diagnostic scope.  Do not
    // silently fall through to a machine-wide PATH install after that candidate
    // fails verification (which could select the wrong architecture/version).
    if (options.candidates) {
        return [
            ...uniquePaths(managed).map((executablePath) => ({
                executablePath,
                source: 'managed',
            })),
            ...uniquePaths(explicit).map((executablePath) => ({
                executablePath,
                source: 'explicit',
            })),
        ];
    }
    const join = tuple.platform === 'win32' ? path.win32.join : path.join;
    const fromPath = pathEntries(env, tuple).map((entry) => join(entry, executableName(tuple)));
    const wellKnown = options.wellKnownPaths ?? defaultWellKnownPaths(tuple, env);
    return [
        ...uniquePaths(managed).map((executablePath) => ({
            executablePath,
            source: 'managed',
        })),
        ...uniquePaths(explicit).map((executablePath) => ({
            executablePath,
            source: 'explicit',
        })),
        ...uniquePaths(fromPath).map((executablePath) => ({ executablePath, source: 'path' })),
        ...uniquePaths(wellKnown).map((executablePath) => ({
            executablePath,
            source: 'well-known',
        })),
    ];
}
export async function discoverLibreOffice(options = {}) {
    const tuple = runtimeTuple(options.platform, options.arch);
    if (!tuple) {
        const reportedPlatform = options.platform === 'darwin' ||
            options.platform === 'win32' ||
            options.platform === 'linux' ||
            options.platform === 'freebsd'
            ? options.platform
            : 'unknown';
        const reportedArch = options.arch === 'x64' || options.arch === 'arm64' ? options.arch : 'unknown';
        return {
            availability: 'unavailable',
            reason: 'unsupported_runtime_tuple',
            platform: reportedPlatform,
            arch: reportedArch,
        };
    }
    const env = options.env ?? process.env;
    const probeTimeoutMs = Math.max(1, Math.min(options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS, 30000));
    let lastReason = 'no_verified_soffice';
    for (const candidate of candidateList(options, tuple)) {
        const executablePath = await resolveExecutable(candidate.executablePath, tuple);
        if (!executablePath)
            continue;
        const probe = options.probe
            ? await options.probe(executablePath, { timeoutMs: probeTimeoutMs, tuple })
            : await spawnProbe(executablePath, {
                timeoutMs: probeTimeoutMs,
                tuple,
                spawn: options.spawn ?? child_processSpawn,
                env,
            });
        if (probe.ok) {
            return {
                availability: 'available',
                executablePath,
                version: probe.version,
                source: candidate.source,
                platform: tuple.platform,
                arch: tuple.arch,
            };
        }
        lastReason = probe.reason ?? 'version_probe_failed';
    }
    return {
        availability: 'unavailable',
        reason: lastReason,
        platform: tuple.platform,
        arch: tuple.arch,
    };
}
function encodeOwnerValue(value) {
    return Buffer.from(value, 'utf8').toString('base64');
}
function windowsOwnerFiles(jobDir) {
    return {
        completionPath: path.join(jobDir, '.mavis-office-owner-complete.json'),
    };
}
function trustedWindowsPowerShell(env) {
    const systemRoot = env.SystemRoot || env.WINDIR || 'C:\\Windows';
    return path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}
function parseWindowsOwnerCompletion(value) {
    try {
        const parsed = JSON.parse(value);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
            return null;
        const record = parsed;
        if (record.exitCode !== null &&
            (typeof record.exitCode !== 'number' ||
                !Number.isSafeInteger(record.exitCode) ||
                record.exitCode < 0)) {
            return null;
        }
        if (record.exitCode === null) {
            if (record.error !== 'soffice_spawn_failed')
                return null;
            return {
                code: null,
                signal: null,
                spawnError: new Error('soffice_spawn_failed'),
            };
        }
        return { code: record.exitCode, signal: null };
    }
    catch {
        // The wrapper publishes with an atomic rename.  A malformed/partial file
        // is therefore not completion proof and remains pending until the request
        // deadline terminates and quarantines the tree owner.
        return null;
    }
}
function processGroupExists(pid) {
    try {
        process.kill(-pid, 0);
        return true;
    }
    catch (error) {
        return error.code !== 'ESRCH';
    }
}
function createProcessTreeOwner(child, platform, spawn = child_processSpawn, env = process.env, logger = noopDocumentPreviewLogger) {
    const pid = child.pid;
    if (!pid)
        return undefined;
    const logUnprovenTermination = () => {
        logger.error({
            msg: '[DocumentPreview][libreoffice] process-tree termination could not be proven; a native (soffice) process may be orphaned',
            pid,
            platform,
        });
    };
    if (platform === 'win32') {
        // `taskkill.exe` is a Windows system binary. Resolve it through the
        // trusted SystemRoot rather than PATH (which may be user-controlled), and
        // always attach an error/exit handler: an asynchronous spawn error without
        // a listener would become an uncaught exception in Electron's main
        // process. The timer only issues a best-effort direct-child kill; bounded
        // completion belongs to the orchestrator's termination/quarantine owner
        // when taskkill cannot prove that the whole tree exited.
        const systemRoot = env.SystemRoot || env.WINDIR || 'C:\\Windows';
        const taskkillPath = path.win32.join(systemRoot, 'System32', 'taskkill.exe');
        let directChildHasClosed = false;
        let directKillIssued = false;
        const directKill = () => {
            if (directKillIssued || directChildHasClosed)
                return;
            directKillIssued = true;
            try {
                child.kill();
            }
            catch {
                /* already exited */
            }
        };
        let directKillTimer;
        let settlementTimer;
        let settled = false;
        let resolveSettled;
        const settledPromise = new Promise((resolve) => {
            resolveSettled = resolve;
        });
        const finish = (settlement) => {
            if (settled)
                return;
            settled = true;
            if (directKillTimer)
                clearTimeout(directKillTimer);
            if (settlementTimer)
                clearTimeout(settlementTimer);
            if (!settlement.proven)
                logUnprovenTermination();
            resolveSettled(settlement);
        };
        let terminationRequested = false;
        const requestTermination = () => {
            if (terminationRequested)
                return;
            terminationRequested = true;
            let killer;
            try {
                killer = spawn(taskkillPath, ['/PID', String(child.pid), '/T', '/F'], {
                    windowsHide: true,
                    stdio: 'ignore',
                });
                killer.once('error', directKill);
                killer.once('close', (code) => {
                    if (code === 0)
                        finish({ proven: true });
                    else
                        directKill();
                });
                killer.unref();
            }
            catch {
                directKill();
            }
            if (settled)
                return;
            directKillTimer = setTimeout(() => {
                directKill();
            }, PROCESS_KILL_GRACE_MS);
            directKillTimer.unref();
            settlementTimer = setTimeout(() => {
                // A hung/error/nonzero taskkill never proves that descendants exited.
                // Resolve the owner as unproven so callers can quarantine it; do not
                // turn this deadline into a false whole-tree success.
                finish({ proven: false });
            }, PROCESS_TREE_SETTLEMENT_TIMEOUT_MS);
            settlementTimer.unref();
        };
        return {
            settled: settledPromise,
            requestTermination,
            // A direct soffice close does not prove that taskkill has finished
            // terminating descendants. Only a successful observed taskkill close
            // settles this owner as proven; failed/hung taskkill resolves bounded
            // settlement with `proven: false` so the orchestrator can quarantine.
            directChildClosed: () => {
                // The numeric PID may be recycled after close. A failed taskkill
                // remains unproven, but must never be followed by child.kill() against
                // an identity the owner no longer holds.
                directChildHasClosed = true;
                if (!terminationRequested)
                    finish({ proven: false });
            },
            cancelTimers: () => {
                if (directKillTimer)
                    clearTimeout(directKillTimer);
                if (settlementTimer)
                    clearTimeout(settlementTimer);
            },
        };
    }
    let graceTimer;
    let groupCheckTimer;
    let settlementTimer;
    let settled = false;
    let terminationRequested = false;
    let resolveSettled;
    const settledPromise = new Promise((resolve) => {
        resolveSettled = resolve;
    });
    const finish = (settlement) => {
        if (settled)
            return;
        settled = true;
        if (graceTimer)
            clearTimeout(graceTimer);
        if (groupCheckTimer)
            clearTimeout(groupCheckTimer);
        if (settlementTimer)
            clearTimeout(settlementTimer);
        if (!settlement.proven)
            logUnprovenTermination();
        resolveSettled(settlement);
    };
    const confirmGroupExit = () => {
        if (settled)
            return;
        if (!processGroupExists(pid)) {
            finish({ proven: true });
            return;
        }
        groupCheckTimer = setTimeout(confirmGroupExit, PROCESS_GROUP_POLL_MS);
        groupCheckTimer.unref();
    };
    const requestTermination = () => {
        if (terminationRequested || settled)
            return;
        terminationRequested = true;
        if (!processGroupExists(pid)) {
            finish({ proven: true });
            return;
        }
        try {
            process.kill(-pid, 'SIGTERM');
        }
        catch {
            try {
                child.kill('SIGTERM');
            }
            catch {
                /* already exited */
            }
        }
        confirmGroupExit();
        if (settled)
            return;
        graceTimer = setTimeout(() => {
            if (!processGroupExists(pid)) {
                finish({ proven: true });
                return;
            }
            try {
                process.kill(-pid, 'SIGKILL');
            }
            catch {
                try {
                    child.kill('SIGKILL');
                }
                catch {
                    /* already exited */
                }
            }
        }, PROCESS_KILL_GRACE_MS);
        graceTimer.unref();
        settlementTimer = setTimeout(() => {
            // A surviving group after the bounded TERM/KILL attempt is not proof of
            // termination. Resolve explicitly as unproven for quarantine handling.
            finish({ proven: false });
        }, PROCESS_TREE_SETTLEMENT_TIMEOUT_MS);
        settlementTimer.unref();
    };
    return {
        settled: settledPromise,
        requestTermination,
        // A successful direct child exit is not lifecycle settlement: LibreOffice
        // may leave helpers in the detached process group.  If the group remains,
        // the spawn-time owner starts the same bounded TERM/KILL protocol used by
        // timeout and abort before any private files may be cleaned up.
        directChildClosed: () => {
            if (!processGroupExists(pid))
                finish({ proven: true });
            else
                requestTermination();
        },
        cancelTimers: () => {
            if (graceTimer)
                clearTimeout(graceTimer);
            if (groupCheckTimer)
                clearTimeout(groupCheckTimer);
            if (settlementTimer)
                clearTimeout(settlementTimer);
        },
    };
}
export function terminateProcessTree(child, platform, spawn = child_processSpawn) {
    const owner = createProcessTreeOwner(child, platform, spawn);
    owner?.requestTermination();
    return owner;
}
function readOnlyNoFollowFlags() {
    return constants.O_NOFOLLOW === undefined
        ? constants.O_RDONLY
        : constants.O_RDONLY | constants.O_NOFOLLOW;
}
async function materializeSanitizedJobInput(source, outputDir) {
    if (!(await validateSanitizedSourceHandle(source))) {
        throw new Error('sanitized_source_invalid');
    }
    const sourcePath = resolveSanitizedSourcePath(source);
    if (!sourcePath)
        throw new Error('sanitized_source_invalid');
    let sourceHandle = null;
    let jobDir = null;
    let inputPath = null;
    try {
        sourceHandle = await open(sourcePath, readOnlyNoFollowFlags());
        const before = await sourceHandle.stat({ bigint: true });
        if (!before.isFile() ||
            (process.platform !== 'win32' && (Number(before.mode) & 0o777) !== 0o600)) {
            throw new Error('sanitized_source_invalid');
        }
        const bytes = await sourceHandle.readFile();
        const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
        if (bytes.byteLength !== source.sizeBytes || digest !== source.sanitizedSha256) {
            throw new Error('sanitized_source_mutated');
        }
        const after = await sourceHandle.stat({ bigint: true });
        if (!after.isFile() ||
            after.dev !== before.dev ||
            after.ino !== before.ino ||
            after.size !== before.size ||
            !(await validateSanitizedSourceHandle(source))) {
            throw new Error('sanitized_source_mutated');
        }
        await mkdir(outputDir, { recursive: true, mode: 0o700 });
        jobDir = await mkdtemp(path.join(outputDir, 'mavis-office-job-'));
        await chmod(jobDir, 0o700).catch(() => undefined);
        inputPath = path.join(jobDir, `${randomBytes(16).toString('hex')}.pptx`);
        const jobHandle = await open(inputPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
        try {
            await jobHandle.writeFile(bytes);
            await jobHandle.chmod(0o600);
        }
        finally {
            await jobHandle.close();
        }
        const jobStat = await lstat(inputPath, { bigint: true });
        if (!jobStat.isFile() ||
            jobStat.isSymbolicLink() ||
            jobStat.size !== BigInt(bytes.byteLength) ||
            (process.platform !== 'win32' && (Number(jobStat.mode) & 0o777) !== 0o600)) {
            throw new Error('sanitized_job_input_invalid');
        }
        return { inputPath, jobDir };
    }
    catch (error) {
        if (jobDir)
            await rm(jobDir, { recursive: true, force: true }).catch(() => undefined);
        throw error;
    }
    finally {
        await sourceHandle?.close().catch(() => undefined);
    }
}
async function removeWithRetry(target, recursive = false) {
    for (let attempt = 0; attempt < 4; attempt += 1) {
        try {
            await rm(target, { recursive, force: true });
            return;
        }
        catch {
            if (attempt === 3)
                return;
            await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
        }
    }
}
export async function runSofficeConversion(options) {
    const platform = options.platform ?? process.platform;
    const timeoutMs = Math.max(1, Math.min(options.timeoutMs ?? DEFAULT_CONVERSION_TIMEOUT_MS, 10 * 60000));
    let profileDir = options.profileDir ?? '';
    const ownsProfile = !options.profileDir;
    const outputDir = options.outputDir;
    let outputPath = path.join(outputDir, 'unresolved.pdf');
    let stdout = '';
    let stderr = '';
    let child = null;
    let timedOut = false;
    let aborted = Boolean(options.signal?.aborted);
    let timer;
    let windowsOwnerPollTimer;
    let abortListener;
    let termination;
    let terminationSettlement;
    let jobDir = null;
    const removeOutputIfSafe = async () => {
        if (terminationSettlement?.proven === false)
            return;
        await removeWithRetry(outputPath);
    };
    const cleanup = async () => {
        if (timer)
            clearTimeout(timer);
        if (windowsOwnerPollTimer)
            clearTimeout(windowsOwnerPollTimer);
        if (termination) {
            termination.directChildClosed();
            terminationSettlement ?? (terminationSettlement = await termination.settled);
            termination.cancelTimers();
        }
        if (options.signal && abortListener)
            options.signal.removeEventListener('abort', abortListener);
        // Keep the private job/profile alive when whole-tree termination was not
        // proven.  The caller/orchestrator must quarantine this execution rather
        // than deleting paths that a surviving descendant may still access.
        if (terminationSettlement?.proven === false)
            return;
        if (jobDir)
            await removeWithRetry(jobDir, true);
        if (ownsProfile && profileDir)
            await removeWithRetry(profileDir, true);
    };
    try {
        if (!profileDir)
            profileDir = await mkdtemp(path.join(os.tmpdir(), 'mavis-office-profile-'));
        await mkdir(outputDir, { recursive: true, mode: 0o700 });
        await chmod(outputDir, 0o700).catch(() => undefined);
        await mkdir(profileDir, { recursive: true, mode: 0o700 });
        await chmod(profileDir, 0o700).catch(() => undefined);
        if (aborted) {
            return {
                ok: false,
                profileDir,
                outputPath,
                exitCode: null,
                signal: null,
                stdout,
                stderr,
                aborted: true,
                timedOut: false,
                reason: 'cancelled',
            };
        }
        const materialized = await materializeSanitizedJobInput(options.sanitizedSource, outputDir);
        jobDir = materialized.jobDir;
        // Cancellation may arrive while the sanitized bytes are being copied into
        // the private job directory.  Re-check immediately before constructing or
        // spawning the native process; an AbortSignal is advisory and the child
        // cannot be allowed to start after the request has already been cancelled.
        if (options.signal?.aborted) {
            aborted = true;
            return {
                ok: false,
                profileDir,
                outputPath,
                exitCode: null,
                signal: null,
                stdout,
                stderr,
                aborted: true,
                timedOut: false,
                reason: 'cancelled',
            };
        }
        outputPath = path.join(outputDir, `${path.basename(materialized.inputPath, path.extname(materialized.inputPath))}.pdf`);
        // A job gets a fresh random input name.  Removing any stale path before
        // spawn prevents an old PDF from being mistaken for this conversion's
        // output after a converter failure.
        await removeWithRetry(outputPath);
        const args = [
            '--headless',
            '--invisible',
            '--nologo',
            '--nodefault',
            '--nofirststartwizard',
            '--norestore',
            `-env:UserInstallation=${pathToFileURL(profileDir).href}`,
            '--convert-to',
            'pdf:impress_pdf_Export',
            '--outdir',
            outputDir,
            materialized.inputPath,
        ];
        const spawn = options.spawn ?? child_processSpawn;
        const libreOfficeEnv = minimalLibreOfficeEnv(options.env ?? process.env);
        let windowsFiles;
        if (platform === 'win32') {
            windowsFiles = windowsOwnerFiles(jobDir);
            child = spawn(trustedWindowsPowerShell(libreOfficeEnv), [
                '-NoLogo',
                '-NoProfile',
                '-NonInteractive',
                '-ExecutionPolicy',
                'Bypass',
                '-EncodedCommand',
                WINDOWS_PROCESS_OWNER_SCRIPT_B64,
            ], {
                windowsHide: true,
                env: {
                    ...libreOfficeEnv,
                    MAVIS_OFFICE_OWNER_EXECUTABLE_B64: encodeOwnerValue(options.executablePath),
                    MAVIS_OFFICE_OWNER_ARGS_B64: encodeOwnerValue(JSON.stringify(args)),
                    MAVIS_OFFICE_OWNER_COMPLETION: windowsFiles.completionPath,
                },
                stdio: ['ignore', 'pipe', 'pipe'],
            });
        }
        else {
            child = spawn(options.executablePath, args, {
                detached: true,
                windowsHide: true,
                env: libreOfficeEnv,
                stdio: ['ignore', 'pipe', 'pipe'],
            });
        }
        // Ownership starts with spawn, not with timeout/abort.  Normal exit 0 is
        // accepted only after this owner proves that the entire detached group or
        // Windows tree is gone, which also orders private-file cleanup after
        // native execution.
        termination = createProcessTreeOwner(child, platform, spawn, libreOfficeEnv, options.logger);
        child.stdout?.on('data', (chunk) => {
            stdout = appendBounded(stdout, chunk);
        });
        child.stderr?.on('data', (chunk) => {
            stderr = appendBounded(stderr, chunk);
        });
        const closeResult = await new Promise((resolve) => {
            let settled = false;
            const settle = (value) => {
                if (settled)
                    return;
                settled = true;
                if (windowsOwnerPollTimer)
                    clearTimeout(windowsOwnerPollTimer);
                resolve(value);
            };
            child?.once('error', (error) => {
                termination?.requestTermination();
                settle({ code: null, signal: null, spawnError: error });
            });
            child?.once('close', (code, signal) => {
                if (timer)
                    clearTimeout(timer);
                termination?.directChildClosed();
                settle(windowsFiles
                    ? {
                        code,
                        signal,
                        spawnError: new Error('windows_process_owner_closed_before_completion'),
                    }
                    : { code, signal });
            });
            if (windowsFiles) {
                const pollWindowsOwner = async () => {
                    if (settled)
                        return;
                    const serialized = await readFile(windowsFiles.completionPath, 'utf8').catch(() => null);
                    const completion = serialized ? parseWindowsOwnerCompletion(serialized) : null;
                    if (completion) {
                        if (!termination) {
                            settle({
                                code: null,
                                signal: null,
                                spawnError: new Error('windows_process_owner_unavailable'),
                            });
                            return;
                        }
                        termination.requestTermination();
                        settle(completion);
                        return;
                    }
                    windowsOwnerPollTimer = setTimeout(() => void pollWindowsOwner(), WINDOWS_OWNER_POLL_MS);
                    windowsOwnerPollTimer.unref();
                };
                void pollWindowsOwner();
            }
            timer = setTimeout(() => {
                timedOut = true;
                termination?.requestTermination();
                if (windowsFiles && termination) {
                    void termination.settled.then(() => settle({ code: null, signal: null }));
                }
            }, timeoutMs);
            abortListener = () => {
                aborted = true;
                termination?.requestTermination();
                if (windowsFiles && termination) {
                    void termination.settled.then(() => settle({ code: null, signal: null }));
                }
            };
            options.signal?.addEventListener('abort', abortListener, { once: true });
            if (options.signal?.aborted)
                abortListener();
        });
        if (termination)
            terminationSettlement = await termination.settled;
        if (terminationSettlement?.proven === false) {
            return {
                ok: false,
                profileDir,
                outputPath,
                exitCode: null,
                signal: null,
                stdout,
                stderr,
                aborted,
                timedOut,
                reason: 'process_tree_termination_unproven',
                terminationProven: false,
            };
        }
        if (closeResult.spawnError) {
            await removeOutputIfSafe();
            return {
                ok: false,
                profileDir,
                outputPath,
                exitCode: null,
                signal: null,
                stdout,
                stderr,
                aborted,
                timedOut,
                reason: closeResult.spawnError.message,
            };
        }
        if (aborted || timedOut || closeResult.code !== 0) {
            await removeOutputIfSafe();
            return {
                ok: false,
                profileDir,
                outputPath,
                exitCode: closeResult.code,
                signal: closeResult.signal,
                stdout,
                stderr,
                aborted,
                timedOut,
                reason: aborted
                    ? 'cancelled'
                    : timedOut
                        ? 'conversion_timeout'
                        : `soffice_exit_${closeResult.code ?? 'unknown'}`,
            };
        }
        try {
            const outputStat = await lstat(outputPath, { bigint: true });
            if (!outputStat.isFile() || outputStat.isSymbolicLink() || outputStat.size <= 5n) {
                throw new Error('pdf_missing');
            }
            await chmod(outputPath, 0o600).catch(() => undefined);
            const handle = await open(outputPath, readOnlyNoFollowFlags());
            try {
                const opened = await handle.stat({ bigint: true });
                if (!opened.isFile() ||
                    opened.dev !== outputStat.dev ||
                    opened.ino !== outputStat.ino ||
                    opened.size !== outputStat.size) {
                    throw new Error('pdf_invalid');
                }
                const header = Buffer.alloc(5);
                await handle.read(header, 0, header.length, 0);
                if (header.toString('ascii') !== '%PDF-')
                    throw new Error('pdf_invalid');
                const tailLength = Number(opened.size > 4096n ? 4096n : opened.size);
                const tail = Buffer.alloc(tailLength);
                await handle.read(tail, 0, tail.length, Number(opened.size) - tail.length);
                if (!tail.includes(Buffer.from('%%EOF'))) {
                    throw new Error('pdf_invalid');
                }
            }
            finally {
                await handle.close().catch(() => undefined);
            }
        }
        catch (error) {
            await removeOutputIfSafe();
            return {
                ok: false,
                profileDir,
                outputPath,
                exitCode: closeResult.code,
                signal: closeResult.signal,
                stdout,
                stderr,
                aborted: false,
                timedOut: false,
                reason: error instanceof Error ? error.message : 'pdf_invalid',
            };
        }
        return {
            ok: true,
            profileDir,
            outputPath,
            exitCode: closeResult.code,
            signal: closeResult.signal,
            stdout,
            stderr,
            aborted: false,
            timedOut: false,
        };
    }
    catch (error) {
        await removeOutputIfSafe();
        return {
            ok: false,
            profileDir,
            outputPath,
            exitCode: null,
            signal: null,
            stdout,
            stderr,
            aborted,
            timedOut,
            reason: error instanceof Error ? error.message : 'conversion_failed',
        };
    }
    finally {
        await cleanup();
    }
}
export let convertWithSoffice = runSofficeConversion;
