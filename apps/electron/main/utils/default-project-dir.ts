import * as fs from "fs";
import * as path from "path";
/** Parent folder for projects created without a chosen folder, under the user's Documents. */
export let DEFAULT_PROJECTS_FOLDER_NAME = 'MiniMax';
const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu;
/**
 * Folder name for a project name: path separators, characters Windows rejects and
 * control characters become `-`; leading or trailing dots and spaces are dropped so
 * the folder is never hidden, relative or rejected by Windows. Empty when nothing is left.
 */
export function defaultProjectFolderName(projectName) {
    // eslint-disable-next-line no-control-regex
    const name = projectName
        .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/gu, '-')
        .replace(/^[\s.]+|[\s.]+$/gu, '');
    return WINDOWS_RESERVED_NAME.test(name) ? `${name}-` : name;
}
/**
 * Creates (or reuses) `<documents>/MiniMax/<project name>` and returns its path.
 * `created` is false when the folder already existed, so the caller still confirms trust.
 */
export async function ensureDefaultProjectDir(documentsDir, projectName) {
    const folderName = defaultProjectFolderName(projectName);
    if (!folderName)
        return { success: false, error: 'invalid-name' };
    const dir = path.join(documentsDir, DEFAULT_PROJECTS_FOLDER_NAME, folderName);
    try {
        await fs.promises.mkdir(path.dirname(dir), { recursive: true });
        let created = true;
        try {
            await fs.promises.mkdir(dir);
        }
        catch (error) {
            if (error?.code !== 'EEXIST')
                throw error;
            created = false;
        }
        if (!(await fs.promises.stat(dir)).isDirectory())
            return { success: false, error: 'failed' };
        return { success: true, path: dir, created };
    }
    catch (error) {
        const code = error?.code;
        return {
            success: false,
            error: code === 'EACCES' || code === 'EPERM' ? 'permission-denied' : 'failed',
        };
    }
}
