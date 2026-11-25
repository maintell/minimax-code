import { mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { EXTENSION_DEV_SESSION_SEGMENT } from '@mavis/permission';
import { writeFileAtomic } from '../storage/store-files.js';
import { pluginDirectoryName } from './candidate.js';
const POINTERS = '.pointers';
/**
 * `<dataDir>/v2/plugin-dev/extensions/<sessionId>/<pluginId>/`: the directory is the preview
 * intent (four.md #11). A preview of a workspace path keeps a pointer file instead.
 */
export class ExtensionDevDirectories {
    root;
    constructor(root) {
        this.root = root;
    }
    directory(sessionId, pluginId) {
        return path.join(this.root, segment(sessionId), pluginDirectoryName(pluginId));
    }
    /** `preview({ sourcePath })`: records where the source of this intent lives. */
    async pointTo(sessionId, pluginId, sourcePath) {
        const file = this.pointerFile(sessionId, pluginId);
        await mkdir(path.dirname(file), { recursive: true });
        await writeFileAtomic(file, JSON.stringify({ pluginId, sourcePath: path.resolve(sourcePath) }));
    }
    /** Source directory of the intent: the pointer target, else the dev directory if it exists. */
    async source(sessionId, pluginId) {
        const pointer = await readPointer(this.pointerFile(sessionId, pluginId));
        if (pointer)
            return pointer.sourcePath;
        const directory = this.directory(sessionId, pluginId);
        return (await isDirectory(directory)) ? directory : undefined;
    }
    async deleteSession(sessionId) {
        await rm(path.join(this.root, segment(sessionId)), { recursive: true, force: true });
    }
    async listSessions() {
        try {
            return (await readdir(this.root, { withFileTypes: true }))
                .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
                .map((entry) => entry.name);
        }
        catch (error) {
            if (error.code === 'ENOENT')
                return [];
            throw error;
        }
    }
    pointerFile(sessionId, pluginId) {
        return path.join(this.root, segment(sessionId), POINTERS, `${pluginDirectoryName(pluginId)}.json`);
    }
}
function segment(sessionId) {
    if (!EXTENSION_DEV_SESSION_SEGMENT.test(sessionId)) {
        throw new TypeError(`Invalid session id for an extension dev directory: ${sessionId}`);
    }
    return sessionId;
}
async function readPointer(file) {
    try {
        const value = JSON.parse(await readFile(file, 'utf8'));
        return typeof value.sourcePath === 'string' ? { sourcePath: value.sourcePath } : undefined;
    }
    catch {
        return undefined;
    }
}
async function isDirectory(directory) {
    try {
        return (await stat(directory)).isDirectory();
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=dev-directory.js.map