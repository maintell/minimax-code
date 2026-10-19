/**
 * Seed the `mavis-trash` script into `<dataDir>/bin/`. Called once during
 * `LocalRuntimeApiHost` startup so the bash-permission `rm → mavis-trash`
 * rewrite has an actual executable to spawn.
 *
 * Ported from the retired daemon package (`packages/daemon/src/server.ts:
 * ensureTrashScript`, deleted by commit 99ccaca02 "chore(local-runtime):
 * retire daemon package"). The pi-agent refactor dropped this seeding
 * step, leaving the rewrite target missing so agent `rm` invocations
 * failed with `mavis-trash: No such file or directory` and the model
 * fell back to `/bin/rm` — hard-deleting the user's files.
 *
 * - macOS / Linux: seeds a POSIX bash script at `mavis-trash` (0o755).
 * - Windows: seeds a Node.js script at `mavis-trash.js` plus a `.cmd`
 *   launcher `mavis-trash.cmd`, so the permission pipeline can invoke
 *   `mavis-trash <paths>` uniformly across platforms.
 *
 * Idempotent: only rewrites when the on-disk content differs from the
 * bundled string (so restarts don't churn the file mtime).
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { TRASH_SCRIPT_CONTENT } from './trash-script.js';
import { TRASH_CMD_LAUNCHER_CONTENT, TRASH_SCRIPT_WIN_CONTENT } from './trash-script-win.js';
export function ensureTrashScript(dataDir, platform = process.platform) {
    const binDir = path.join(dataDir, 'bin');
    mkdirSync(binDir, { recursive: true });
    const isWin = platform === 'win32';
    if (isWin) {
        seedFileIfChanged(path.join(binDir, 'mavis-trash.js'), TRASH_SCRIPT_WIN_CONTENT);
        seedFileIfChanged(path.join(binDir, 'mavis-trash.cmd'), TRASH_CMD_LAUNCHER_CONTENT);
    }
    else {
        seedFileIfChanged(path.join(binDir, 'mavis-trash'), TRASH_SCRIPT_CONTENT, 0o755);
    }
    // Any change to the on-disk launcher invalidates the previous probe cache;
    // otherwise a stale cached "available: true" could survive an overwrite.
    clearTrashRuntimeCache();
}
const trashRuntimeCache = new Map();
export function clearTrashRuntimeCache(dataDir, platform = process.platform) {
    if (dataDir === undefined)
        trashRuntimeCache.clear();
    else
        trashRuntimeCache.delete(`${platform}:${dataDir}`);
}
function sha256(value) {
    return createHash('sha256').update(value).digest('hex');
}
export function inspectTrashRuntime(dataDir, platform = process.platform, probe) {
    if (platform === 'darwin' || platform === 'linux') {
        const scriptPath = path.join(dataDir, 'bin', 'mavis-trash');
        const cacheKey = `${platform}:${dataDir}`;
        try {
            const scriptContent = readFileSync(scriptPath, 'utf8');
            const scriptHash = sha256(scriptContent);
            const launcherHash = 'posix-no-launcher';
            if (scriptContent !== TRASH_SCRIPT_CONTENT) {
                const verdict = { available: false, reason: 'mavis-trash files are stale' };
                trashRuntimeCache.set(cacheKey, { scriptHash, launcherHash, verdict });
                return verdict;
            }
            if ((statSync(scriptPath).mode & 0o111) === 0) {
                // Do not cache mode failures: ensureTrashScript may repair the execute
                // bit without changing the content hash on the next tick.
                return { available: false, reason: 'mavis-trash is not executable' };
            }
            const cached = trashRuntimeCache.get(cacheKey);
            if (cached && cached.scriptHash === scriptHash && cached.launcherHash === launcherHash) {
                return cached.verdict;
            }
            // Unlike the Windows .cmd launcher, POSIX execution uses /bin/bash with
            // the exact verified script bytes, so no separate spawn probe is needed.
            const verdict = { available: true };
            trashRuntimeCache.set(cacheKey, { scriptHash, launcherHash, verdict });
            return verdict;
        }
        catch (error) {
            // Never cache filesystem failures; startup may re-seed the file next.
            return {
                available: false,
                reason: error instanceof Error ? error.message : String(error),
            };
        }
    }
    if (platform !== 'win32')
        return { available: true };
    const scriptPath = path.join(dataDir, 'bin', 'mavis-trash.js');
    const launcherPath = path.join(dataDir, 'bin', 'mavis-trash.cmd');
    const cacheKey = `${platform}:${dataDir}`;
    let phase = 'read-script';
    try {
        // Always re-read both files. If a caller restored the mtime after
        // rewriting the launcher, the mtime would still lie about staleness;
        // hashing the actual bytes is the only tamper-resistant cache key.
        const scriptContent = readFileSync(scriptPath, 'utf8');
        phase = 'read-launcher';
        const launcherContent = readFileSync(launcherPath, 'utf8');
        phase = 'verify-content';
        const scriptHash = sha256(scriptContent);
        const launcherHash = sha256(launcherContent);
        const cached = trashRuntimeCache.get(cacheKey);
        if (cached && cached.scriptHash === scriptHash && cached.launcherHash === launcherHash) {
            return cached.verdict;
        }
        const scriptMatchesBundled = scriptContent === TRASH_SCRIPT_WIN_CONTENT;
        const launcherMatchesBundled = launcherContent === TRASH_CMD_LAUNCHER_CONTENT;
        if (!scriptMatchesBundled || !launcherMatchesBundled) {
            const verdict = {
                available: false,
                reason: 'mavis-trash files are stale',
                diagnostics: {
                    phase: 'verify-content',
                    failure: 'content-mismatch',
                    script_matches_bundled: scriptMatchesBundled,
                    launcher_matches_bundled: launcherMatchesBundled,
                    script_sha256: scriptHash,
                    launcher_sha256: launcherHash,
                },
            };
            trashRuntimeCache.set(cacheKey, { scriptHash, launcherHash, verdict });
            return verdict;
        }
        phase = 'probe';
        const probeResult = probe
            ? probe(scriptPath, launcherPath)
                ? { callable: true }
                : {
                    callable: false,
                    diagnostics: { phase: 'probe', failure: 'probe-rejected' },
                }
            : probeTrashScript(launcherPath);
        const verdict = probeResult.callable
            ? { available: true }
            : {
                available: false,
                reason: 'mavis-trash is not callable',
                diagnostics: probeResult.diagnostics,
            };
        trashRuntimeCache.set(cacheKey, { scriptHash, launcherHash, verdict });
        return verdict;
    }
    catch (error) {
        // Never cache a filesystem-error verdict — the missing file may reappear
        // on the next tick after ensureTrashScript re-seeds.
        return {
            available: false,
            reason: error instanceof Error ? error.message : String(error),
            diagnostics: {
                phase,
                failure: 'read-failed',
                component: phase === 'read-script' ? 'script' : 'launcher',
                ...readNodeErrorDiagnostics(error),
            },
        };
    }
}
function probeTrashScript(launcherPath) {
    const commandInterpreter = process.env.ComSpec || 'cmd.exe';
    const startedAt = Date.now();
    const result = spawnSync(commandInterpreter, ['/d', '/s', '/c', `call "${launcherPath.replaceAll('"', '""')}" --`], {
        encoding: 'utf8',
        timeout: 5000,
        windowsHide: true,
        // The final argv entry is already a complete cmd.exe `/c` payload.
        // Node's default Windows quoting escapes its embedded quotes as `\"`,
        // which cmd.exe treats as literal characters instead of launcher quotes.
        windowsVerbatimArguments: true,
    });
    const durationMs = Date.now() - startedAt;
    const stderr = result.stderr ?? '';
    const stderrMarkerFound = stderr.includes('no files specified');
    if (!result.error && result.status === 1 && stderrMarkerFound)
        return { callable: true };
    const errorCode = readErrorString(result.error, 'code');
    const failure = result.error
        ? errorCode === 'ETIMEDOUT'
            ? 'timed-out'
            : 'spawn-failed'
        : result.status !== 1
            ? 'unexpected-exit'
            : 'unexpected-output';
    return {
        callable: false,
        diagnostics: {
            phase: 'probe',
            failure,
            command_interpreter_source: process.env.ComSpec ? 'ComSpec' : 'default',
            command_interpreter_basename: path.win32.basename(commandInterpreter),
            runtime_kind: process.versions.electron ? 'electron' : 'node',
            runtime_executable_basename: path.win32.basename(process.execPath),
            duration_ms: durationMs,
            exit_status: result.status,
            signal: result.signal,
            expected_stderr_marker_found: stderrMarkerFound,
            ...(errorCode ? { error_code: errorCode } : {}),
            ...readNodeErrorDiagnostics(result.error),
            ...probeOutputDiagnostics(stderr, launcherPath),
        },
    };
}
function readNodeErrorDiagnostics(error) {
    return {
        ...(readErrorString(error, 'code') ? { error_code: readErrorString(error, 'code') } : {}),
        ...(readErrorString(error, 'syscall') ? { syscall: readErrorString(error, 'syscall') } : {}),
    };
}
function readErrorString(error, key) {
    if (!error || typeof error !== 'object')
        return undefined;
    const value = Reflect.get(error, key);
    return typeof value === 'string' && value ? value : undefined;
}
function probeOutputDiagnostics(stderr, launcherPath) {
    const sanitize = (value) => {
        const preview = value
            .replaceAll(launcherPath, '<launcher>')
            .replaceAll(path.dirname(launcherPath), '<runtime-bin>')
            .replaceAll(process.execPath, '<runtime-executable>')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 512);
        return preview || undefined;
    };
    const stderrPreview = sanitize(stderr);
    return {
        ...(stderrPreview ? { stderr_preview: stderrPreview } : {}),
    };
}
/** Write `content` to `filePath` only when the file is missing or stale. */
function seedFileIfChanged(filePath, content, mode) {
    let needsWrite = true;
    if (existsSync(filePath)) {
        try {
            if (readFileSync(filePath, 'utf-8') === content)
                needsWrite = false;
        }
        catch {
            // Can't read — overwrite.
        }
    }
    if (!needsWrite) {
        if (mode !== undefined && (statSync(filePath).mode & 0o111) === 0) {
            chmodSync(filePath, mode);
        }
        return;
    }
    writeFileSync(filePath, content, mode !== undefined ? { mode } : undefined);
}
//# sourceMappingURL=ensure-trash-script.js.map