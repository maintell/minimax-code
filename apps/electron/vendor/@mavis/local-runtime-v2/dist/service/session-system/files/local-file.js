import { createHash } from 'node:crypto';
import { createReadStream, realpath } from 'node:fs';
import { stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { promisify } from 'node:util';
/**
 * Same JS realpath as `realpathSync` (not `fs.promises.realpath`, which is native realpath(3)),
 * so keys match the `source_path` returned by `space_upload`.
 */
const resolveRealPath = promisify(realpath);
/** Real path and stat of an existing regular file; undefined for relative, missing or non-file paths. */
export async function readLocalFileIdentity(path) {
    if (!isAbsolute(path))
        return undefined;
    try {
        const realPath = await resolveRealPath(path);
        const info = await stat(realPath);
        if (!info.isFile())
            return undefined;
        return { realPath, size: info.size, mtimeMs: Math.floor(info.mtimeMs) };
    }
    catch {
        return undefined;
    }
}
/** Hex sha256 of the file content; undefined when the file can no longer be read. */
export async function sha256File(path) {
    const hash = createHash('sha256');
    try {
        for await (const chunk of createReadStream(path))
            hash.update(chunk);
    }
    catch {
        return undefined;
    }
    return hash.digest('hex');
}
const SHA256_HEX = /^[0-9a-f]{64}$/u;
export function normalizeSha256(value) {
    const normalized = value.trim().toLowerCase();
    return SHA256_HEX.test(normalized) ? normalized : undefined;
}
//# sourceMappingURL=local-file.js.map