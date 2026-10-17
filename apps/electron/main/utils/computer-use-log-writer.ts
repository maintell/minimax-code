import * as fs from "node:fs/promises";
/** Called by the existing per-file serial write chain; never affects other categories. */
export function createComputerUseLogWriter(maxBytes = 5 * 1024 * 1024) {
    const sizes = new Map();
    return async (file, content) => {
        try {
            let size = sizes.get(file);
            if (size === undefined) {
                try {
                    size = (await fs.stat(file)).size;
                }
                catch (error) {
                    if (error.code !== 'ENOENT')
                        throw error;
                    size = 0;
                }
            }
            // Normal CUA records are already bounded; cap exceptional direct callers too.
            let bytes = Buffer.from(content + '\n');
            if (bytes.length > maxBytes) {
                const suffix = Buffer.from(' [truncated]\n');
                bytes = Buffer.concat([bytes.subarray(0, Math.max(0, maxBytes - suffix.length)), suffix]);
            }
            const backup = (index) => file.replace(/\.log$/, `.${index}.log`);
            if (size > 0 && size + bytes.length > maxBytes) {
                await fs.rm(backup(3), { force: true });
                for (let index = 2; index >= 0; index--) {
                    try {
                        await fs.rename(index ? backup(index) : file, backup(index + 1));
                    }
                    catch (error) {
                        if (error.code !== 'ENOENT')
                            throw error;
                    }
                }
                size = 0;
            }
            await fs.appendFile(file, bytes);
            sizes.set(file, size + bytes.length);
            const oldest = sizes.keys().next().value;
            if (sizes.size > 32 && oldest !== undefined)
                sizes.delete(oldest);
        }
        catch {
            // Do not recursively log I/O failures or keep appending after a failed rotation.
            sizes.delete(file);
        }
    };
}
export function isComputerUseLog(category, prefix) {
    return (category === 'main' &&
        !!prefix &&
        ['computer-use', 'computer-use-preview', 'computer-use-permission-guide'].includes(prefix));
}
