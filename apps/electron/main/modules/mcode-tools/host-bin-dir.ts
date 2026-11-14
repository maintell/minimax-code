import { resolveMcodeToolsHostBinDir, ensureMcodeToolsPlaceholderLaunchers } from "@mavis/mcode-tools-host";
import { buildEnv } from "../../config/env";
import { resolveLocalRuntimeDataDir } from "../local-runtime/data-dir";
/**
 * Launcher directory owned by this installed App under the given dataDir. Electron main installs
 * this App's mcode-tools launchers there and hands the directory to its own utility Runtime, which
 * puts it ahead of the shared `<dataDir>/bin` on the Agent PATH. Several Desktop packages may run
 * against one dataDir; the shared copy is last-writer-wins, this one is not.
 */
export function resolveDesktopMcodeToolsHostBinDir(dataDir = resolveLocalRuntimeDataDir(), executable = process.execPath) {
    return resolveMcodeToolsHostBinDir({
        dataDir,
        buildEnv: normalizeMcodeToolsBuildEnv(buildEnv),
        executable,
    });
}
/**
 * The launcher directory to hand to this App's Runtime, never empty: missing launchers are filled
 * with fail-closed placeholders first. An empty directory would let the Agent PATH fall through to
 * the shared `<dataDir>/bin` copy, which belongs to whichever App on this dataDir wrote it last.
 * The mcode-tools integration replaces the placeholders once it is ready.
 */
export function prepareDesktopMcodeToolsHostBinDir(dataDir) {
    const hostBinDir = resolveDesktopMcodeToolsHostBinDir(dataDir);
    ensureMcodeToolsPlaceholderLaunchers({ hostBinDir, platform: process.platform });
    return hostBinDir;
}
export function normalizeMcodeToolsBuildEnv(value) {
    if (value === 'staging' || value === 'prod')
        return value;
    return 'test';
}
