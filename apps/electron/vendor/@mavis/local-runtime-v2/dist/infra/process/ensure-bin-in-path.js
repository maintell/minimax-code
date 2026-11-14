/**
 * Inject `<dataDir>/bin` into `process.env.PATH` so that shell commands
 * spawned by the agent (via pi-mono's `getShellEnv()`) can find tools like
 * `mavis-trash`, `mavis`, and `minimax`.
 *
 * `getShellEnv()` (third_party/pi-mono) spreads `process.env` and prepends
 * `~/.pi/agent/bin`, but does NOT add the mavis data-dir bin. Rather than
 * patching third-party code, we inject the entry into `process.env` early
 * — once is enough for the lifetime of the Electron process.
 *
 * When the Desktop host supplied its own mcode-tools launcher directory (see
 * `mcode-tools-host-bin.ts`), that directory goes in front of `<dataDir>/bin` so
 * this App resolves its own launcher rather than whichever package wrote the
 * shared copy last.
 *
 * Idempotent: skips entries that are already present.
 */
import { delimiter, join } from 'node:path';
import { resolveMcodeToolsHostBinDir } from './mcode-tools-host-bin.js';
export function ensureBinInProcessPath(dataDir) {
    const managed = [resolveMcodeToolsHostBinDir(dataDir), join(dataDir, 'bin')].filter((entry) => Boolean(entry));
    const pathKey = Object.keys(process.env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
    const currentPath = process.env[pathKey] ?? '';
    const entries = currentPath.split(delimiter).filter(Boolean);
    const missing = managed.filter((entry) => !entries.includes(entry));
    if (missing.length === 0)
        return;
    // Prepend so mavis-trash and this App's launchers take priority over any stale copy elsewhere.
    process.env[pathKey] = [...missing, currentPath].filter(Boolean).join(delimiter);
}
//# sourceMappingURL=ensure-bin-in-path.js.map