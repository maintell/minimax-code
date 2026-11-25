import { fileURLToPath, pathToFileURL } from 'node:url';
const ASAR_SEGMENT = /\.asar(?=[/\\])/u;
/**
 * The `.asar.unpacked` twin of a path inside an Electron asar archive, or `undefined` outside one.
 * Both separators are handled, so a Windows path maps the same on any host.
 */
export function unpackedAsarPath(file) {
    return ASAR_SEGMENT.test(file) ? file.replace(ASAR_SEGMENT, '.asar.unpacked') : undefined;
}
/**
 * A file resolved against `moduleUrl`, taken from the unpacked twin when the module sits inside an
 * asar archive. Worker threads and child processes need real files on disk; the file must be listed
 * in electron-builder's `asarUnpack`.
 */
export function unpackedFileUrl(file, moduleUrl) {
    const resolved = fileURLToPath(new URL(file, moduleUrl));
    return pathToFileURL(unpackedAsarPath(resolved) ?? resolved);
}
//# sourceMappingURL=asar-unpacked-path.js.map