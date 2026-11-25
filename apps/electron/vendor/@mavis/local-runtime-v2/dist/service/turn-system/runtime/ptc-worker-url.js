import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { defaultPtcWorkerUrl } from '@mavis/harness';
/**
 * The harness PTC Worker entry for this process. Electron cannot start a
 * Worker from inside app.asar, so a packaged build loads the copy that
 * electron-builder's `asarUnpack` puts in app.asar.unpacked; development and
 * the TUI keep the Worker beside the harness module.
 */
export function packagedPtcWorkerUrl(workerUrl = defaultPtcWorkerUrl()) {
    return pathToFileURL(resolveUnpackedAsarPath(fileURLToPath(workerUrl)));
}
/** @internal Exported for focused tests. */
export function resolveUnpackedAsarPath(filePath, pathApi = path) {
    let directory = pathApi.dirname(filePath);
    while (pathApi.dirname(directory) !== directory) {
        if (pathApi.basename(directory) === 'app.asar') {
            return pathApi.join(`${directory}.unpacked`, pathApi.relative(directory, filePath));
        }
        directory = pathApi.dirname(directory);
    }
    return filePath;
}
//# sourceMappingURL=ptc-worker-url.js.map