import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
/** Stage renderer-owned bytes in an app-owned directory, never at a caller-selected path. */
export async function stageAttachment(userData, fileName, bytes) {
    if (!(bytes instanceof Uint8Array) ||
        bytes.byteLength === 0 ||
        bytes.byteLength > 100 * 1024 * 1024) {
        throw new Error('Invalid attachment size');
    }
    const safeName = fileName
        .split(/[\\/]/)
        .pop()
        ?.replace(/[<>:"|?*\x00-\x1f]/g, '_')
        .slice(-120);
    if (!safeName || safeName === '.' || safeName === '..')
        throw new Error('Invalid attachment name');
    const root = path.join(userData, 'staged-attachments');
    await mkdir(root, { recursive: true, mode: 0o700 });
    const directory = await mkdtemp(path.join(root, 'attachment-'));
    const target = path.join(directory, `file-${safeName}`);
    await writeFile(target, bytes, { flag: 'wx', mode: 0o600 });
    return target;
}
