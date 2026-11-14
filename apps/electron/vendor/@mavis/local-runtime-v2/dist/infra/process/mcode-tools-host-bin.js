/**
 * Desktop-owned mcode-tools launcher directory for this Runtime.
 *
 * Several Desktop packages (Test, Staging, Internal, release) default to the same dataDir. The
 * shared `<dataDir>/bin/mcode-tools` launcher is last-writer-wins, so an Agent could resolve a
 * different App's embedded CLI, broker and account. Electron main therefore installs this App's
 * launchers in `<dataDir>/bin/hosts/<buildEnv>-<executable digest>/` and hands that directory to
 * its own utility Runtime through {@link MCODE_TOOLS_HOST_BIN_DIR_ENV}. The Runtime puts it ahead
 * of `<dataDir>/bin`, which keeps working unchanged for every host that sets nothing (TUI, CLI,
 * older Desktop builds).
 *
 * The variable is a Runtime boundary key: it is stripped from Agent bash and child daemons so a
 * nested host never adopts another App's launcher directory.
 */
import path from 'node:path';
/**
 * Fork-env key Electron main sets for its own utility Runtime.
 * @internal Exported only for focused tests.
 */
export const MCODE_TOOLS_HOST_BIN_DIR_ENV = 'MAVIS_MCODE_TOOLS_HOST_BIN_DIR';
/**
 * Returns the App-owned launcher directory when the host supplied one under this dataDir's
 * `bin/hosts`; anything else (unset, relative, another profile, a nested path) is ignored so
 * PATH resolution falls back to the shared `<dataDir>/bin`.
 */
export function resolveMcodeToolsHostBinDir(dataDir, env = process.env, platform = process.platform) {
    const raw = env[MCODE_TOOLS_HOST_BIN_DIR_ENV]?.trim();
    if (!raw)
        return undefined;
    const paths = platform === 'win32' ? path.win32 : path.posix;
    if (!paths.isAbsolute(raw) || !paths.isAbsolute(dataDir))
        return undefined;
    const candidate = paths.resolve(raw);
    const relative = paths.relative(paths.resolve(dataDir, 'bin', 'hosts'), candidate);
    if (!relative ||
        relative.startsWith('..') ||
        paths.isAbsolute(relative) ||
        relative.includes(paths.sep)) {
        return undefined;
    }
    return candidate;
}
//# sourceMappingURL=mcode-tools-host-bin.js.map