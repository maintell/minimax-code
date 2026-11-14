import { createHash } from 'node:crypto';
import { lstat, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { canonicalActiveHistoryRevision, } from '../../../sessions/representation/canonical-history-contract.js';
import { publishVerifiedBackup, readableCanonicalPrefix, readRegularFileBytes, } from './canonical-history-repair.js';
/** The raw-bytes backup a context reset leaves next to the history (Bunny context reset spec 5.1). */
const RESET_BACKUP_FILE = /^messages\.reset\.[a-f0-9]{64}\.raw$/u;
/**
 * Replaces the active history with one handoff header (Bunny context reset
 * spec 4.1, 5). The file's raw bytes are backed up first and never parsed for
 * that, so a corrupt history resets as well (5.1, 5.3). The readable part of
 * the old history becomes the parent snapshot and the header carries the next
 * generation's marker, as a compaction writes it (5.6). The replacement is one
 * atomic write: an exit leaves the old or the new history whole (5.5). Runs
 * in the Session's history I/O lane.
 */
export async function resetCanonicalHistory(dependencies, input) {
    const { files } = dependencies;
    const paths = await dependencies.paths();
    files.forget?.(paths.messages);
    const raw = await readRegularFileBytes(paths.messages);
    const backupFile = `messages.reset.${createHash('sha256').update(raw).digest('hex')}.raw`;
    await publishVerifiedBackup(join(dirname(paths.messages), backupFile), raw);
    const previous = readablePrevious(raw);
    const generation = activeGeneration(previous);
    const marker = {
        schemaVersion: 1,
        generation: generation + 1,
        // The producer releases before segments read (Bunny infinite conversation spec 11.5).
        producedBy: 'llm_checkpoint',
        parentSnapshot: {
            generation,
            compactionId: input.resetId,
            revision: canonicalActiveHistoryRevision(previous),
        },
    };
    await files.publishSnapshot(join(paths.snapshots, `g${String(generation).padStart(12, '0')}--${input.resetId}.jsonl`), previous);
    if (!(await readRegularFileBytes(paths.messages)).equals(raw)) {
        throw new Error('Canonical history changed while it was being reset.');
    }
    await files.replaceActive(paths.messages, [{ ...input.header, history_artifact: marker }]);
    files.forget?.(paths.messages);
    dependencies.notify();
    const committed = await files.readActiveStrict(paths.messages);
    if (committed[0]?.history_artifact?.generation !== generation + 1 || committed.length !== 1) {
        throw new Error('Canonical history reset verification failed.');
    }
    return { backupFile, messagesBefore: previous.length, generation: generation + 1 };
}
/**
 * Puts a context reset's raw-bytes backup back as the active history, after a
 * later step of that reset failed (Bunny context reset spec 5.4); one atomic write.
 */
export async function restoreCanonicalHistoryResetBackup(dependencies, backupFile) {
    if (!RESET_BACKUP_FILE.test(backupFile) || basename(backupFile) !== backupFile) {
        throw new TypeError('Not a context reset backup.');
    }
    const paths = await dependencies.paths();
    const backupPath = join(dirname(paths.messages), backupFile);
    const info = await lstat(backupPath);
    if (!info.isFile() || info.isSymbolicLink()) {
        throw new Error('Canonical history backup is not the expected regular file.');
    }
    const raw = await readFile(backupPath);
    if (`messages.reset.${createHash('sha256').update(raw).digest('hex')}.raw` !== backupFile) {
        throw new Error('Canonical history backup does not match its name.');
    }
    const staged = `${paths.messages}.${String(process.pid)}.reset-restore.tmp`;
    await writeFile(staged, raw, { mode: 0o600 });
    await rename(staged, paths.messages);
    dependencies.files.forget?.(paths.messages);
    dependencies.notify();
}
/** The old history as far as it reads; one that does not read at all leaves an empty parent. */
function readablePrevious(raw) {
    try {
        return readableCanonicalPrefix(raw);
    }
    catch {
        return [];
    }
}
/** The generation the first record's marker names; 0 without one. */
function activeGeneration(records) {
    const artifactGeneration = records[0]?.history_artifact?.generation;
    if (artifactGeneration !== undefined)
        return artifactGeneration;
    const first = records[0]?.message;
    if (!first || first.role !== 'user')
        return 0;
    const marker = Reflect.get(first, 'archonCompaction');
    if (!marker || typeof marker !== 'object' || Array.isArray(marker))
        return 0;
    const generation = Reflect.get(marker, 'generation');
    return typeof generation === 'number' && Number.isSafeInteger(generation) && generation >= 0
        ? generation
        : 0;
}
//# sourceMappingURL=canonical-history-reset.js.map