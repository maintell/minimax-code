import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, open, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { decodeCanonicalHistoryEnvelope } from '../../../../../infra/file/canonical-history.js';
import { publishFileIfAbsent } from '../../../../../infra/file/jsonl.js';
import { canonicalHistoryRevision, } from '../../../sessions/representation/canonical-history-contract.js';
import { isUserMessageId } from '../../../shared/user-message-id.js';
import { repairCanonicalHistory } from '../canonical-history-recovery.js';
import { listSnapshotNames } from './canonical-history-scanner.js';
/** Line-level strict read failure; the path is captured so it can be checked and removed. */
const MALFORMED_LINE = /^Malformed JSONL in ([\s\S]+?) at line (\d+: [\s\S]*)$/u;
const SEQUENCE_ERROR = /^Canonical history sequence is invalid at record (\d+): /u;
/**
 * The strict read rejected the history as corrupted, so a repair was due, but
 * it did not complete. `messages.jsonl` keeps the bytes it had unless the
 * failure came from reading back the history the repair had already written.
 */
export class CanonicalHistoryRepairError extends Error {
    reason;
    name = 'CanonicalHistoryRepairError';
    constructor(
    /** The strict read's error, without local paths. */
    reason, cause) {
        super(`Canonical history repair failed: ${reason}`, { cause });
        this.reason = reason;
    }
}
/**
 * Repairs an active history the Turn's read rejects as malformed or out of
 * sequence (Bunny emergency rebuild spec 6.2 steps 1-3, 10). Runs in the
 * Session's history I/O lane. A readable history returns undefined and other
 * read errors are rethrown unchanged, so IO failures never start a repair.
 */
export async function repairCorruptedCanonicalHistory(dependencies, options = {}) {
    const paths = await dependencies.paths();
    const reason = await readCorruption(dependencies.read, paths.messages);
    if (reason === undefined)
        return undefined;
    try {
        return await repair(dependencies, paths, reason, options);
    }
    catch (error) {
        throw new CanonicalHistoryRepairError(reason, error);
    }
}
async function readCorruption(read, messagesPath) {
    try {
        await read();
        return undefined;
    }
    catch (error) {
        const reason = corruptionReason(error, messagesPath);
        if (reason === undefined)
            throw error;
        return reason;
    }
}
async function repair(dependencies, paths, reason, options) {
    const { files } = dependencies;
    const raw = await readRegularFileBytes(paths.messages);
    const backupFile = `messages.corrupted.${createHash('sha256').update(raw).digest('hex')}.raw`;
    await publishVerifiedBackup(join(dirname(paths.messages), backupFile), raw);
    const corrupted = decodeLongestPrefix(raw);
    const plan = await planReplacement(files, paths.snapshots, corrupted.prefix);
    const recalled = await recallUserMessages(plan.records, options.recall);
    if (!(await readRegularFileBytes(paths.messages)).equals(raw)) {
        throw new Error('Canonical history changed while it was being repaired.');
    }
    await files.replace(paths.messages, [...plan.records, ...recalled]);
    files.forget?.(paths.messages);
    dependencies.notify();
    await dependencies.read();
    return {
        backupFile,
        kind: plan.kind,
        keptCount: plan.records.length,
        removedCount: plan.kind === 'prefix' ? corrupted.lineCount - plan.records.length : corrupted.lineCount,
        recalledCount: recalled.length,
        ...(plan.snapshot ? { snapshot: plan.snapshot } : {}),
        reason,
    };
}
/** The strict read's corruption error without the local path, or undefined for other errors. */
function corruptionReason(error, path) {
    if (!(error instanceof Error))
        return undefined;
    if (SEQUENCE_ERROR.test(error.message))
        return error.message;
    const malformed = MALFORMED_LINE.exec(error.message);
    return malformed?.[1] === path ? `Malformed JSONL at line ${malformed[2]}` : undefined;
}
/**
 * The records of a history file's raw bytes that read as a valid history:
 * its longest decodable prefix, cut and settled by the read path's sequence
 * rules, the first record's generation marker kept.
 */
export function readableCanonicalPrefix(raw) {
    return settledPrefix(decodeLongestPrefix(raw).prefix);
}
/** Reads raw bytes without following a link out of the Session directory. */
export async function readRegularFileBytes(filePath) {
    // O_NOFOLLOW is undefined on Windows, where only this check refuses a link.
    if ((await lstat(filePath)).isSymbolicLink()) {
        throw new Error('Canonical history must be a regular file.');
    }
    const handle = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
        if (!(await handle.stat()).isFile()) {
            throw new Error('Canonical history must be a regular file.');
        }
        return await handle.readFile();
    }
    finally {
        await handle.close();
    }
}
/** The history is rewritten only once this exact copy of its bytes is readable from disk. */
export async function publishVerifiedBackup(backupPath, raw) {
    await publishFileIfAbsent(backupPath, raw);
    const metadata = await lstat(backupPath);
    if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size !== raw.length) {
        throw new Error('Canonical history backup is not the expected regular file.');
    }
    if (!(await readFile(backupPath)).equals(raw)) {
        throw new Error('Canonical history backup does not match the history bytes.');
    }
}
/**
 * Decodes envelopes from the start and stops at the first line that is blank,
 * is not JSON, is not a valid envelope, or ends the file without a newline.
 * `lineCount` counts every non-empty line of the file, the last one included.
 */
function decodeLongestPrefix(raw) {
    const prefix = [];
    let lineCount = 0;
    let decoding = true;
    let offset = 0;
    while (offset < raw.length) {
        const newline = raw.indexOf(10, offset);
        const end = newline === -1 ? raw.length : newline;
        if (!isBlankLine(raw, offset, end))
            lineCount += 1;
        if (decoding) {
            // Each line is decoded on its own so records never retain whole-file strings.
            const record = newline === -1 ? undefined : decodeLine(raw.toString('utf8', offset, end));
            if (record)
                prefix.push(record);
            else
                decoding = false;
        }
        offset = end + 1;
    }
    return { prefix, lineCount };
}
function decodeLine(line) {
    if (line.trim().length === 0)
        return undefined;
    try {
        return decodeCanonicalHistoryEnvelope(JSON.parse(line));
    }
    catch {
        return undefined;
    }
}
function isBlankLine(raw, start, end) {
    for (let index = start; index < end; index += 1) {
        const byte = raw[index];
        if (byte !== 0x20 && byte !== 0x09 && byte !== 0x0b && byte !== 0x0c && byte !== 0x0d) {
            return false;
        }
    }
    return true;
}
async function planReplacement(files, snapshotsPath, prefix) {
    const kept = settledPrefix(prefix);
    if (kept.some(({ message }) => message.role === 'user'))
        return { kind: 'prefix', records: kept };
    const snapshot = await newestReadableSnapshot(files, snapshotsPath);
    if (!snapshot)
        return { kind: 'empty', records: [] };
    return {
        kind: 'snapshot',
        records: rolledBackRecords(snapshot),
        snapshot: { generation: snapshot.generation, fileName: snapshot.fileName },
    };
}
/**
 * Applies the read path's sequence rules: a violation cuts the prefix before
 * the reported record, then tool rounds settle as on every execution read.
 * The first record's generation marker stays, so the generation is unchanged.
 */
function settledPrefix(prefix) {
    const marker = prefix[0]?.history_artifact;
    let candidate = prefix;
    while (candidate.length > 0) {
        try {
            const { records } = repairCanonicalHistory(candidate, { allowPendingToolCallTail: false });
            return withFirstRecordMarker(records, marker);
        }
        catch (error) {
            const recordNumber = sequenceErrorRecord(error);
            if (recordNumber === undefined)
                throw error;
            candidate = candidate.slice(0, Math.min(recordNumber - 1, candidate.length - 1));
        }
    }
    return [];
}
function sequenceErrorRecord(error) {
    if (!(error instanceof Error))
        return undefined;
    const match = SEQUENCE_ERROR.exec(error.message);
    return match ? Number(match[1]) : undefined;
}
/** A tool-protocol repair may drop the record that carried the marker. */
function withFirstRecordMarker(records, marker) {
    const [first, ...rest] = records;
    if (!first || !marker || first.history_artifact)
        return [...records];
    return [{ ...first, history_artifact: marker }, ...rest];
}
/**
 * The highest generation snapshot (same generation: newest mtime) that is a
 * regular file and reads strictly. Corrupted snapshots are passed over; IO
 * errors fail the repair instead of rolling back further than needed.
 */
async function newestReadableSnapshot(files, snapshotsPath) {
    const candidates = [];
    for (const entry of await listSnapshotNames(snapshotsPath)) {
        if (!entry.regular)
            continue;
        const info = await lstatIfPresent(entry.path);
        if (info?.isFile() && !info.isSymbolicLink())
            candidates.push({ ...entry, mtimeMs: info.mtimeMs });
    }
    candidates.sort((left, right) => right.generation - left.generation || right.mtimeMs - left.mtimeMs);
    for (const candidate of candidates) {
        const records = await readSnapshotRecords(files, candidate.path);
        if (records && records.length > 0) {
            return {
                generation: candidate.generation,
                compactionId: candidate.compactionId,
                fileName: candidate.fileName,
                records,
            };
        }
    }
    return undefined;
}
async function lstatIfPresent(path) {
    try {
        return await lstat(path);
    }
    catch (error) {
        if (error instanceof Error && Reflect.get(error, 'code') === 'ENOENT')
            return undefined;
        throw error;
    }
}
async function readSnapshotRecords(files, path) {
    try {
        return await files.readStrict(path);
    }
    catch (error) {
        if (corruptionReason(error, path) !== undefined)
            return undefined;
        throw error;
    }
    finally {
        files.forget?.(path);
    }
}
/**
 * The snapshot's records as the next generation, built like a compaction:
 * the marker names the snapshot and its revision, so the lineage chain stays
 * closed and the generation does not go back. The snapshot file is not touched.
 */
function rolledBackRecords(snapshot) {
    const marker = {
        schemaVersion: 1,
        generation: snapshot.generation + 1,
        producedBy: 'llm_checkpoint',
        parentSnapshot: {
            generation: snapshot.generation,
            compactionId: snapshot.compactionId,
            revision: canonicalHistoryRevision(snapshot.records),
        },
    };
    return snapshot.records.map((record, index) => {
        const semanticEnvelope = {
            message_id: record.message_id,
            turn_id: record.turn_id,
            message: record.message,
            ...(record.turn_config ? { turn_config: record.turn_config } : {}),
        };
        return index === 0 ? { ...semanticEnvelope, history_artifact: marker } : semanticEnvelope;
    });
}
async function recallUserMessages(records, recall) {
    if (!recall)
        return [];
    const messageIds = records.map(({ message_id }) => message_id);
    const present = new Set(messageIds);
    const recalled = [];
    for (const entry of await recall({ messageIds })) {
        const envelope = recalledUserEnvelope(entry);
        if (present.has(envelope.message_id))
            continue;
        present.add(envelope.message_id);
        recalled.push(envelope);
    }
    return recalled;
}
function recalledUserEnvelope(entry) {
    if (!isUserMessageId(entry.messageId)) {
        throw new TypeError('Recalled user message id is invalid.');
    }
    const envelope = decodeCanonicalHistoryEnvelope({
        message_id: entry.messageId,
        turn_id: entry.turnId,
        message: entry.message,
    });
    if (envelope.message.role !== 'user') {
        throw new TypeError(`Recalled message is not a user message: ${entry.messageId}`);
    }
    return envelope;
}
//# sourceMappingURL=canonical-history-repair.js.map