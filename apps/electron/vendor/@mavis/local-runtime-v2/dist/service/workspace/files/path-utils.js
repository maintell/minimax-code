import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
/** Serialize a workspace-relative path consistently across operating systems. */
export function toPortableRelativePath(input) {
    return input.replace(/\\/gu, '/');
}
/**
 * Convert Windows drive spellings that Node cannot resolve into native paths on win32:
 * - MSYS paths (/c/Users/...) from Git Bash output;
 * - file-URI style drive paths (/D:/work/...) that models write in Markdown links.
 * Node's path.resolve() would otherwise produce C:\c\Users\... or C:\D:\work\....
 * Other platforms keep the input unchanged.
 */
export function toNativeWindowsDrivePath(input) {
    if (process.platform !== 'win32')
        return input;
    const slashDriveMatch = input.match(/^\/([a-zA-Z]):([\\/].*)$/u);
    if (slashDriveMatch) {
        const drive = (slashDriveMatch[1] ?? '').toUpperCase();
        return `${drive}:${(slashDriveMatch[2] ?? '\\').replace(/\//gu, '\\')}`;
    }
    const msysMatch = input.match(/^\/([a-zA-Z])(\/.*)?$/u);
    if (msysMatch) {
        const drive = (msysMatch[1] ?? '').toUpperCase();
        const rest = msysMatch[2]?.replace(/\//gu, '\\') ?? '\\';
        return `${drive}:${rest}`;
    }
    return input;
}
export function resolvePath(input) {
    const path = input.startsWith('~') ? join(homedir(), input.slice(1)) : input;
    return resolve(toNativeWindowsDrivePath(path));
}
//# sourceMappingURL=path-utils.js.map