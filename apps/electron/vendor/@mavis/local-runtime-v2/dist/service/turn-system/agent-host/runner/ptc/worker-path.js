import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
/** Resolves the Worker beside this module, preferring Electron's unpacked ASAR path. */
export function ptcWorkerUrl(moduleUrl = import.meta.url) {
    return pathToFileURL(resolvePtcWorkerPath(fileURLToPath(moduleUrl)));
}
/** @internal Exported for focused tests. */
export function resolvePtcWorkerPath(modulePath, pathApi = path) {
    const workerPath = pathApi.join(pathApi.dirname(modulePath), 'quickjs-worker.js');
    let directory = pathApi.dirname(modulePath);
    while (pathApi.dirname(directory) !== directory) {
        if (pathApi.basename(directory) === 'app.asar') {
            return pathApi.join(`${directory}.unpacked`, pathApi.relative(directory, workerPath));
        }
        directory = pathApi.dirname(directory);
    }
    return workerPath;
}
//# sourceMappingURL=worker-path.js.map