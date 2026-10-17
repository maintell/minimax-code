/**
 * Cross-platform shell detection — single source of truth for both the
 * non-interactive bash tool (`modules/bash`) and the interactive terminal
 * (`modules/terminal`).
 *
 * Detection order:
 *   - Windows: PowerShell 7 (`pwsh.exe`) → Windows PowerShell → `cmd.exe`.
 *   - Unix:    `$SHELL` env var → `/bin/zsh` → `/bin/bash` → `/bin/sh`.
 *
 * The first detection result is cached so callers can invoke `detectShell()`
 * cheaply on every PTY spawn. Tests can call `resetShellInfoCache()` to clear it.
 */
import * as fs from "fs";
import * as path from "path";
let cachedShellInfo = null;
/**
 * Reset the cached shell detection result. Intended for tests only.
 */
export function resetShellInfoCache() {
    cachedShellInfo = null;
}
/**
 * Detect and cache the user's default shell. Subsequent calls return the
 * cached value until `resetShellInfoCache()` is invoked.
 */
export function detectShell() {
    if (cachedShellInfo) {
        return cachedShellInfo;
    }
    if (process.platform === 'win32') {
        cachedShellInfo = detectWindowsShell();
    }
    else {
        cachedShellInfo = detectUnixShell();
    }
    return cachedShellInfo;
}
function detectWindowsShell() {
    // PowerShell 7 (cross-platform) wins over Windows PowerShell so that newer
    // installs are preferred when available; both fall back to %ComSpec%.
    const candidates = [
        'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
        'C:\\Program Files (x86)\\PowerShell\\7\\pwsh.exe',
        'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
        'C:\\Windows\\SysWOW64\\WindowsPowerShell\\v1.0\\powershell.exe',
    ];
    for (const candidate of candidates) {
        if (safeExists(candidate)) {
            return { path: candidate, type: 'pwsh', isWindows: true };
        }
    }
    // Final fallback: Windows guarantees cmd.exe via %ComSpec% even when
    // PowerShell is somehow uninstalled (extremely rare on supported builds).
    const cmdPath = process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe';
    return { path: cmdPath, type: 'cmd', isWindows: true };
}
function detectUnixShell() {
    const envShell = process.env.SHELL || '';
    if (envShell && safeExists(envShell)) {
        return {
            path: envShell,
            type: classifyShellPath(envShell),
            isWindows: false,
        };
    }
    const fallbacks = ['/bin/zsh', '/usr/bin/zsh', '/bin/bash', '/usr/bin/bash', '/bin/sh'];
    for (const candidate of fallbacks) {
        if (safeExists(candidate)) {
            return {
                path: candidate,
                type: classifyShellPath(candidate),
                isWindows: false,
            };
        }
    }
    // Last resort — `/bin/sh` exists on every POSIX system we support; if even
    // that is missing the spawn will throw and the caller will surface it.
    return { path: '/bin/sh', type: 'bash', isWindows: false };
}
function safeExists(p) {
    try {
        return fs.existsSync(p);
    }
    catch {
        return false;
    }
}
function classifyShellPath(shellPath) {
    const base = path.basename(shellPath).toLowerCase();
    if (base.includes('zsh'))
        return 'zsh';
    // bash / sh / dash / ash all map to 'bash' bucket for display purposes;
    // PTY behavior is unaffected.
    return 'bash';
}
