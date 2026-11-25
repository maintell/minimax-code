import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
/** Only ENOENT means absence; dangling links remain visible to lstat. */
export async function editorTypesPathStat(file) {
    try {
        return await lstat(file);
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return undefined;
        throw error;
    }
}
/**
 * Dedicated writer for the fixed editor-type targets, anchored to the real source directory.
 * Preflight every target before mutation, then recheck at each I/O boundary. This detects static
 * links and observed directory replacements, not arbitrary concurrent ancestor swaps: portable
 * Node has no directory-handle-relative open/rename. The source ancestors must remain stable.
 */
export async function writeEditorTypeFiles(packageDir, files, rootConfig) {
    const root = await realpath(packageDir);
    const directories = new Map();
    const targets = [...Object.keys(files), 'tsconfig.json'];
    async function checkDirectory(directory, create) {
        let info = await editorTypesPathStat(directory);
        if (!info && create) {
            await createDirectory(directory);
            info = await editorTypesPathStat(directory);
        }
        if (!info)
            return;
        if (!info.isDirectory()) {
            throw new Error('Unsafe editor types parent: expected an unlinked directory');
        }
        const before = directories.get(directory);
        if (before && !sameFile(before, info))
            throw new Error('Editor types parent changed');
        directories.set(directory, info);
    }
    async function check(relative, createParents = false) {
        if ((await realpath(root)) !== root)
            throw new Error('Editor types source directory changed');
        const parts = relative.split('/');
        for (let i = 0; i < parts.length; i++) {
            await checkDirectory(path.join(root, ...parts.slice(0, i)), createParents);
        }
        const info = await editorTypesPathStat(path.join(root, ...parts));
        if (info && !info.isFile()) {
            throw new Error('Unsafe editor types target: expected an unlinked regular file');
        }
        return info;
    }
    async function read(relative) {
        const before = await check(relative);
        if (!before)
            return undefined;
        const handle = await open(path.join(root, ...relative.split('/')), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        try {
            const opened = await handle.stat();
            if (!opened.isFile() || !sameFile(before, opened))
                throw new Error('Editor types target changed');
            const content = await handle.readFile('utf8');
            const after = await check(relative);
            if (!after || !sameFile(opened, after))
                throw new Error('Editor types target changed');
            return content;
        }
        finally {
            await handle.close();
        }
    }
    // Even a later unsafe target must fail before earlier generated files are touched.
    for (const relative of targets)
        await check(relative);
    const rootBefore = await read('tsconfig.json');
    const selected = { ...files };
    if (rootBefore === undefined || rootBefore === rootConfig.legacy) {
        selected['tsconfig.json'] = rootConfig.current;
    }
    async function replace(relative, content) {
        const before = await read(relative);
        if (before === content)
            return false;
        // The root config is author-owned unless absent or still the exact legacy host output.
        if (relative === 'tsconfig.json' && before !== rootBefore) {
            throw new Error('Editor types root config changed');
        }
        await check(relative, true);
        const temporary = `${path.posix.dirname(relative)}/.editor-types-${randomUUID()}.tmp`;
        const temporaryPath = path.join(root, ...temporary.split('/'));
        const target = path.join(root, ...relative.split('/'));
        const handle = await open(temporaryPath, 'wx', 0o600);
        try {
            try {
                await handle.writeFile(content, 'utf8');
            }
            finally {
                await handle.close();
            }
            // Do not truncate existing files (including hardlinks), or overwrite a newly created config.
            if ((await read(relative)) !== before)
                throw new Error('Editor types target changed');
            await check(temporary);
            if (before === undefined)
                await link(temporaryPath, target);
            else
                await rename(temporaryPath, target);
        }
        finally {
            // Never clean up through a parent that has been replaced with a link.
            if (await check(temporary))
                await unlink(temporaryPath);
        }
        return true;
    }
    const written = [];
    for (const [relative, content] of Object.entries(selected)) {
        if (await replace(relative, content))
            written.push(relative);
    }
    return written;
}
async function createDirectory(directory) {
    try {
        await mkdir(directory);
    }
    catch (error) {
        if (error.code !== 'EEXIST')
            throw error;
    }
}
function sameFile(a, b) {
    return a.dev === b.dev && a.ino === b.ino;
}
//# sourceMappingURL=editor-types-files.js.map