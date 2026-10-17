import { stat } from "node:fs/promises";
import { homedir } from "node:os";
export async function resolveTerminalCwd(requestedCwd) {
    try {
        if ((await stat(requestedCwd)).isDirectory())
            return { cwd: requestedCwd };
    }
    catch (error) {
        const code = error.code;
        if (code !== 'ENOENT' && code !== 'ENOTDIR')
            throw error;
    }
    const cwd = homedir();
    if (!(await stat(cwd)).isDirectory())
        throw new Error('Terminal home directory is unavailable');
    return { cwd, cwdFallbackFrom: requestedCwd };
}
