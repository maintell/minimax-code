import { chmod, mkdir, open, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { recordAuthWriteRetry } from '../diagnostics.js';
export async function ensurePrivateDirectory(directory) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32')
        await chmod(directory, 0o700);
}
export async function atomicWritePrivateFile(path, content) {
    const directory = dirname(path);
    await ensurePrivateDirectory(directory);
    const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
    const handle = await open(temporaryPath, 'wx', 0o600);
    try {
        try {
            await handle.writeFile(content, { encoding: 'utf8' });
            await handle.sync();
        }
        finally {
            await handle.close();
        }
        if (process.platform !== 'win32')
            await chmod(temporaryPath, 0o600);
        // Windows readers/security scanners may temporarily deny replacement. Retry
        // the same closed, synced file; never unlink/truncate the committed target.
        for (let attempt = 0;; attempt += 1) {
            try {
                await rename(temporaryPath, path);
                break;
            }
            catch (error) {
                const code = error.code;
                if (attempt >= 3 || !['EPERM', 'EACCES', 'EBUSY'].includes(code ?? ''))
                    throw error;
                recordAuthWriteRetry(error, attempt + 1);
                await delay(40 * 2 ** attempt);
            }
        }
    }
    catch (error) {
        await unlink(temporaryPath).catch(() => undefined);
        throw error;
    }
}
//# sourceMappingURL=atomic-write.js.map