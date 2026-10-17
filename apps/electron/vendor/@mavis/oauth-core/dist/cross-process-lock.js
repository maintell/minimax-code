import { open } from 'node:fs/promises';
import lockfile from 'proper-lockfile';
import { ensurePrivateDirectory } from './fs/atomic-write.js';
import { dirname } from 'node:path';
export class CrossProcessAuthLock {
    lockPath;
    staleMs;
    retries;
    constructor(lockPath, options = {}) {
        this.lockPath = lockPath;
        this.staleMs = options.staleMs ?? 30_000;
        this.retries = options.retries ?? 120;
    }
    async withLock(operation) {
        await ensurePrivateDirectory(dirname(this.lockPath));
        const handle = await open(this.lockPath, 'a', 0o600);
        await handle.close();
        let compromise;
        const release = await lockfile.lock(this.lockPath, {
            realpath: false,
            stale: this.staleMs,
            retries: {
                retries: this.retries,
                factor: 1.15,
                minTimeout: 5,
                maxTimeout: 250,
            },
            onCompromised: (error) => {
                compromise ??= error;
            },
        });
        try {
            return await operation();
        }
        finally {
            try {
                await release();
            }
            catch (error) {
                if (!compromise)
                    throw error;
            }
            if (compromise)
                throw compromise;
        }
    }
}
//# sourceMappingURL=cross-process-lock.js.map