import { randomUUID } from "node:crypto";
import { realpath, lstat, readFile, open, link, rm } from "node:fs/promises";
import path from "node:path";
import { commitPptxNotes } from "../pptx-notes-commit";
/** Destination authority comes exclusively from a native Save dialog. */
export async function writePptExport(file, bytes) {
    const directory = await realpath(path.dirname(file));
    const destination = path.join(directory, path.basename(file));
    const assertUnmanagedDestination = async () => {
        try {
            await lstat(`${destination}.asset.json`);
        }
        catch (error) {
            if (error.code === 'ENOENT')
                return;
            throw error;
        }
        // Managed assets must use the registry writer, which journals file and metadata together.
        throw new Error('invalid_request');
    };
    await assertUnmanagedDestination();
    let exists = false;
    try {
        const info = await lstat(destination);
        if (!info.isFile() || info.isSymbolicLink() || (await realpath(destination)) !== destination)
            throw new Error('invalid_request');
        exists = true;
    }
    catch (error) {
        if (error.code !== 'ENOENT')
            throw error;
    }
    if (exists) {
        const original = await readFile(destination);
        await commitPptxNotes({
            file: destination,
            original,
            updated: bytes,
            validate: async () => {
                await assertUnmanagedDestination();
                return (await readFile(destination)).equals(original);
            },
        });
    }
    else {
        const temporary = path.join(directory, `.pptx-export-${randomUUID()}.tmp`);
        try {
            const handle = await open(temporary, 'wx', 0o600);
            try {
                await handle.writeFile(bytes);
                await handle.sync();
            }
            finally {
                await handle.close();
            }
            // Exclusive reservation prevents replacing a file created while the dialog was open.
            await link(temporary, destination);
        }
        finally {
            await rm(temporary, { force: true }).catch(() => undefined);
        }
    }
    return destination;
}
