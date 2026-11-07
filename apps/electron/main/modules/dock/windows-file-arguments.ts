import path from "node:path";
function isWindowsAbsolutePath(value) {
    return (typeof value === 'string' &&
        /^(?:[a-z]:[\\/]|\\\\[^\\]+\\[^\\]+)/i.test(value) &&
        path.win32.isAbsolute(value));
}
/** Only the installer-owned open verb supplies this marker; ignore unrelated CLI options. */
export function getWindowsOpenFilePaths(argv) {
    const marker = argv.indexOf('--open-file');
    if (marker < 0)
        return [];
    const candidates = argv.slice(marker + 1);
    const nextOption = candidates.findIndex((value) => value.startsWith('--'));
    return candidates
        .slice(0, nextOption < 0 ? undefined : nextOption)
        .filter(isWindowsAbsolutePath);
}
/**
 * Read the file list captured by the second instance before Electron rewrites
 * the command line for the `second-instance` event.
 *
 * `undefined` means no structured payload was supplied, so callers may use the
 * legacy argv parser as a compatibility fallback. An object with an
 * `openFilePaths` array is authoritative, including an empty array.
 */
export function getWindowsOpenFilePathsFromAdditionalData(additionalData) {
    if (!additionalData || typeof additionalData !== 'object')
        return undefined;
    const value = additionalData.openFilePaths;
    if (!Array.isArray(value))
        return undefined;
    return value.filter(isWindowsAbsolutePath);
}
