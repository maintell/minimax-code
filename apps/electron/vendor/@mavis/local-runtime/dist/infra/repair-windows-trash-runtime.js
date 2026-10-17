import { randomUUID } from 'node:crypto';
import { closeSync, lstatSync, openSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { logger } from '../common/logger.js';
import { clearTrashRuntimeCache, inspectTrashRuntime, } from './ensure-trash-script.js';
import { TRASH_CMD_LAUNCHER_CONTENT, TRASH_SCRIPT_WIN_CONTENT } from './trash-script-win.js';
const REPAIR_COOLDOWN_MS = 60_000;
const lastRepairAttempts = new Map();
/**
 * Repair only a verified content mismatch, using trusted bundled bytes. The
 * synchronous critical section serializes callers in this runtime. A second
 * process can still replace either file: never treat writing as proof of health.
 */
export function inspectAndRepairWindowsTrashRuntime(dataDir, probe) {
    const status = inspectTrashRuntime(dataDir, 'win32', probe);
    if (status.available || status.diagnostics?.failure !== 'content-mismatch')
        return status;
    const key = path.resolve(dataDir).toLowerCase();
    const now = Date.now();
    for (const [directory, attemptedAt] of lastRepairAttempts) {
        if (now - attemptedAt >= REPAIR_COOLDOWN_MS)
            lastRepairAttempts.delete(directory);
    }
    if (lastRepairAttempts.has(key)) {
        return {
            ...status,
            reason: 'mavis-trash files are stale; automatic repair is cooling down. Close other app versions sharing this data directory and restart the app.',
        };
    }
    // Record before writing, including failed attempts. Repeated deletes must not
    // hammer an unwritable directory or fight another version sharing the profile.
    lastRepairAttempts.set(key, now);
    let repaired;
    try {
        replaceWindowsTrashFiles(dataDir);
        clearTrashRuntimeCache(dataDir, 'win32');
        repaired = inspectTrashRuntime(dataDir, 'win32', probe);
    }
    catch (error) {
        clearTrashRuntimeCache(dataDir, 'win32');
        logger.warn({ ...status.diagnostics, error_code: error?.code }, 'local_runtime.trash_repair_failed');
        return {
            ...status,
            reason: 'mavis-trash files are stale and automatic repair failed. Check that the runtime data directory is writable, close other app versions and restart the app.',
        };
    }
    logger.info({
        ...status.diagnostics,
        repaired: repaired.available,
        ...(repaired.available ? {} : { repair_diagnostics: repaired.diagnostics }),
    }, 'local_runtime.trash_repair');
    return repaired;
}
function replaceWindowsTrashFiles(dataDir) {
    const binDir = path.join(dataDir, 'bin');
    // Do not repair through a redirected bin directory or non-regular targets.
    const binStat = lstatSync(binDir);
    if (!binStat.isDirectory() || binStat.isSymbolicLink()) {
        throw new Error('Refusing to repair a redirected trash directory');
    }
    const files = [
        { name: 'mavis-trash.js', content: TRASH_SCRIPT_WIN_CONTENT },
        { name: 'mavis-trash.cmd', content: TRASH_CMD_LAUNCHER_CONTENT },
    ];
    for (const file of files) {
        if (!lstatSync(path.join(binDir, file.name)).isFile()) {
            throw new Error('Refusing to repair a non-regular trash file');
        }
    }
    const staged = [];
    try {
        // Stage both complete files before publishing either. Each rename is atomic;
        // the pair is not a transaction, so the caller must verify and probe again.
        for (const file of files) {
            const target = path.join(binDir, file.name);
            const temporary = `${target}.${randomUUID()}.tmp`;
            const descriptor = openSync(temporary, 'wx');
            staged.push({ temporary, target });
            try {
                writeFileSync(descriptor, file.content, 'utf8');
            }
            finally {
                closeSync(descriptor);
            }
        }
        for (const file of staged)
            renameSync(file.temporary, file.target);
    }
    finally {
        for (const file of staged) {
            try {
                unlinkSync(file.temporary);
            }
            catch {
                // Already renamed or cleanup denied. Neither permits a delete fallback.
            }
        }
    }
}
//# sourceMappingURL=repair-windows-trash-runtime.js.map