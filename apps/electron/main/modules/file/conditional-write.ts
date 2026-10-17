import { createHash, randomUUID } from "node:crypto";
import { realpath, lstat, readFile, open, rename, unlink } from "node:fs/promises";
import path from "node:path";
const writes = new Map();
const digest = (data) => createHash('sha256').update(data).digest('hex');
/** Replace a complete document; never fall back to truncating the destination. */
export async function writeFileIfUnchanged(filePath, data, expected) {
    if (!/^[a-f0-9]{64}$/.test(expected))
        throw new Error('Invalid expected file digest');
    const target = await realpath(filePath);
    const previous = writes.get(target) ?? Promise.resolve();
    const write = previous
        .catch(() => { })
        .then(async () => {
        const info = await lstat(target);
        if (!info.isFile() || info.nlink !== 1)
            throw new Error('Document is not a regular independent file');
        const check = async () => {
            const latest = await lstat(target);
            if ((await realpath(filePath)) !== target ||
                latest.ino !== info.ino ||
                latest.mtimeMs !== info.mtimeMs ||
                latest.nlink !== 1 ||
                digest(await readFile(target)) !== expected) {
                throw new Error('FILE_CHANGED: The file changed on disk. Your editor content was kept. Save a copy or reopen the file.');
            }
        };
        await check();
        const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`);
        try {
            const handle = await open(temporary, 'wx', info.mode & 0o777);
            try {
                await handle.writeFile(data);
                await handle.sync();
            }
            finally {
                await handle.close();
            }
            await check();
            // Same-directory rename is atomic on supported local filesystems. A busy
            // Windows destination fails without destroying either the editor or original.
            await rename(temporary, target);
        }
        finally {
            await unlink(temporary).catch(() => { });
        }
    });
    writes.set(target, write);
    try {
        await write;
    }
    finally {
        if (writes.get(target) === write)
            writes.delete(target);
    }
}
