import { createHash } from 'node:crypto';
import { open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { decodeCanonicalHistoryEnvelope } from '../../../../infra/file/canonical-history.js';
import { isCanonicalEnvelopeShape, normalizeLegacyHistoryTimestamp, } from '../../legacy-migration/legacy-history-timestamp.js';
import { createSessionHistoryLocationResolver, } from './session-history-location.js';
export function createReleasedSessionHistoryReader(options) {
    const locations = options.locations ??
        createSessionHistoryLocationResolver({ dataDir: options.dataDir, sessions: options.sessions });
    return {
        readLedgerSnapshot: (sessionId) => readReleasedHistory(locations, sessionId),
    };
}
async function readReleasedHistory(locations, sessionId) {
    const located = await locations.resolveSession(sessionId);
    if (!located)
        throw new Error(`Session not found: ${sessionId}`);
    const paths = located.paths;
    const snapshotPath = join(paths.sessionDir, 'snapshot.json');
    const ledgerPath = join(paths.sessionDir, 'ledger.jsonl');
    let snapshot;
    try {
        snapshot = await readLegacySnapshot(snapshotPath, sessionId);
    }
    catch (error) {
        return recoverFromCompleteLedger(ledgerPath, sessionId, error);
    }
    let events;
    try {
        events =
            (await readLegacyLedgerTail(ledgerPath, sessionId, snapshot?.byteOffset ?? 0, snapshot?.lastSeq ?? 0)) ?? [];
        assertLedgerContinuation(events, snapshot?.lastSeq ?? 0);
    }
    catch (error) {
        return recoverFromCompleteLedger(ledgerPath, sessionId, error);
    }
    if (!isAuthoritative(snapshot, events))
        return undefined;
    return replayHistory(sessionId, snapshot, events);
}
async function recoverFromCompleteLedger(ledgerPath, sessionId, recoveryCause) {
    try {
        const events = await readLegacyLedgerTail(ledgerPath, sessionId, 0, -1);
        if (!events || events.length === 0)
            throw new Error('complete ledger is absent');
        assertLedgerContinuation(events, 0);
        if (!events.some((event) => isPiHistoryFact(event.kind))) {
            throw new Error('complete ledger contains no Pi-history fact');
        }
        return replayHistory(sessionId, undefined, events);
    }
    catch (ledgerError) {
        throw new AggregateError([recoveryCause, ledgerError], `Legacy Session history recovery failed: ${sessionId}: ${errorReason(recoveryCause)}`);
    }
}
async function readLegacySnapshot(filePath, sessionId) {
    let contents;
    try {
        contents = await readFile(filePath, 'utf8');
    }
    catch (error) {
        if (hasCode(error, 'ENOENT'))
            return undefined;
        throw error;
    }
    let value;
    try {
        value = JSON.parse(contents);
    }
    catch (error) {
        throw corruptSnapshot(filePath, error);
    }
    if (!isLegacySnapshot(value, sessionId))
        throw corruptSnapshot(filePath);
    return {
        messages: value['piHistory'],
        createdAtMs: value['createdAtMs'],
        lastSeq: value['watermark']['lastSeq'],
        byteOffset: value['watermark']['byteOffset'] ?? 0,
        piHistoryFacts: value['piHistoryFacts'],
        deleted: value['deleted'],
    };
}
async function readLegacyLedgerTail(filePath, sessionId, byteOffset, lastSeq) {
    let handle;
    try {
        handle = await open(filePath, 'r');
    }
    catch (error) {
        if (hasCode(error, 'ENOENT'))
            return undefined;
        throw error;
    }
    try {
        const info = await handle.stat();
        if (byteOffset > info.size) {
            throw new Error(`Legacy Session ledger watermark exceeds file size: ${filePath}`);
        }
        const bytes = Buffer.alloc(info.size - byteOffset);
        let bytesRead = 0;
        while (bytesRead < bytes.length) {
            const result = await handle.read(bytes, bytesRead, bytes.length - bytesRead, byteOffset + bytesRead);
            if (result.bytesRead === 0) {
                throw new Error(`Legacy Session ledger ended during read: ${filePath}`);
            }
            bytesRead += result.bytesRead;
        }
        return parseLedgerEvents(committedLedgerText(bytes), filePath, sessionId).filter((event) => event.seq > lastSeq);
    }
    finally {
        await handle.close();
    }
}
function parseLedgerEvents(contents, filePath, sessionId) {
    const events = contents
        .split(/\r?\n/u)
        .flatMap((line, index) => {
        if (!line.trim())
            return [];
        let value;
        try {
            value = JSON.parse(line);
        }
        catch (error) {
            throw corruptLedger(filePath, index + 1, error);
        }
        if (!isLegacyLedgerEvent(value, sessionId)) {
            throw corruptLedger(filePath, index + 1);
        }
        return [value];
    })
        .sort((left, right) => left.seq - right.seq || left.eventId.localeCompare(right.eventId));
    return deduplicateLedgerEvents(events);
}
function committedLedgerText(bytes) {
    const contents = bytes.toString('utf8');
    if (!contents || contents.endsWith('\n'))
        return contents;
    const lastBoundary = contents.lastIndexOf('\n');
    return lastBoundary < 0 ? '' : contents.slice(0, lastBoundary + 1);
}
function deduplicateLedgerEvents(events) {
    const bySequence = new Map();
    const byEventId = new Map();
    const unique = [];
    events.forEach((event) => {
        const sequenceMatch = bySequence.get(event.seq);
        const identityMatch = byEventId.get(event.eventId);
        const previous = sequenceMatch ?? identityMatch;
        if (previous) {
            if (sameEvent(previous, event))
                return;
            throw new Error(`Legacy Session ledger has a conflicting duplicate: ${event.sessionId}/${event.eventId}`);
        }
        bySequence.set(event.seq, event);
        byEventId.set(event.eventId, event);
        unique.push(event);
    });
    return unique;
}
function assertLedgerContinuation(events, previousSequence) {
    const gapIndex = events.findIndex((event, index) => event.seq !== previousSequence + index + 1);
    if (gapIndex >= 0) {
        const expected = previousSequence + gapIndex + 1;
        throw new Error(`Legacy Session ledger is incomplete at sequence ${String(expected)}: ${events[gapIndex]?.sessionId ?? 'unknown'}`);
    }
}
function sameEvent(left, right) {
    return stableJson(left) === stableJson(right);
}
function replayHistory(sessionId, snapshot, events) {
    let records = snapshotMessages(sessionId, snapshot?.messages ?? [], snapshot?.createdAtMs);
    events.forEach((event) => {
        if (event.kind === 'message.pi_history_appended') {
            records = [...records, ...eventMessages(event)];
            return;
        }
        if (event.kind === 'message.pi_history_replaced' || event.kind === 'message.turn_retracted') {
            records = eventMessages(event);
            return;
        }
        if (event.kind === 'message.state_deleted' || event.kind === 'session.deleted')
            records = [];
    });
    return records;
}
function snapshotMessages(sessionId, messages, createdAtMs) {
    let turn = 0;
    return messages.map((message, index) => {
        const role = readMessageRole(message);
        if (role === 'user' || turn === 0)
            turn += 1;
        return legacyEnvelope(message, `legacy:${sessionId}:${String(turn)}`, `snapshot:${sessionId}:${String(index)}`, createdAtMs);
    });
}
function eventMessages(event) {
    const messages = event['messages'];
    if (!Array.isArray(messages)) {
        throw new Error(`Legacy Session history event is corrupt: ${event.sessionId}/${event.eventId}`);
    }
    const turnId = nonEmptyString(event.turnId) ?? `legacy-event-${String(event.seq)}`;
    return messages.map((message, index) => legacyEnvelope(message, turnId, `event:${event.eventId}:${String(index)}`, event.createdAtMs));
}
function legacyEnvelope(message, turnId, seed, stableFallback) {
    const normalized = normalizeLegacyHistoryTimestamp(message, stableFallback);
    if (isRecord(normalized) && isCanonicalEnvelopeShape(normalized)) {
        return decodeCanonicalHistoryEnvelope(normalized);
    }
    const explicitId = readMessageIdentity(normalized);
    return decodeCanonicalHistoryEnvelope({
        message_id: explicitId ??
            `msg-legacy-${createHash('sha256')
                .update(`${seed}\u0000${JSON.stringify(normalized)}`)
                .digest('base64url')}`,
        turn_id: turnId,
        message: normalized,
    });
}
function isAuthoritative(snapshot, events) {
    return Boolean(snapshot?.piHistoryFacts ||
        snapshot?.deleted ||
        snapshot?.messages.length ||
        events.some((event) => isPiHistoryFact(event.kind)));
}
function isPiHistoryFact(kind) {
    return [
        'message.pi_history_appended',
        'message.pi_history_replaced',
        'message.turn_retracted',
        'message.state_deleted',
        'session.deleted',
    ].includes(kind);
}
function isLegacySnapshot(value, sessionId) {
    if (!isRecord(value))
        return false;
    const watermark = value['watermark'];
    const messages = value['piHistory'];
    return (hasSnapshotIdentity(value, sessionId) &&
        isSnapshotWatermark(watermark, sessionId) &&
        isSnapshotPayload(value, messages));
}
function hasSnapshotIdentity(value, sessionId) {
    return (value['schemaVersion'] === 1 &&
        value['sessionId'] === sessionId &&
        typeof value['snapshotId'] === 'string' &&
        value['snapshotId'].trim().length > 0 &&
        isFiniteNumber(value['createdAtMs']));
}
function isSnapshotWatermark(watermark, sessionId) {
    if (!isRecord(watermark))
        return false;
    return (watermark['sessionId'] === sessionId &&
        isNonNegativeInteger(watermark['lastSeq']) &&
        typeof watermark['lastEventId'] === 'string' &&
        isFiniteNumber(watermark['updatedAtMs']) &&
        (watermark['byteOffset'] === undefined || isNonNegativeInteger(watermark['byteOffset'])));
}
function isSnapshotPayload(value, messages) {
    const deleted = value['deleted'];
    return (Array.isArray(value['displayMessages']) &&
        Array.isArray(messages) &&
        typeof value['piHistoryFacts'] === 'boolean' &&
        typeof deleted === 'boolean' &&
        (!deleted || messages.length === 0));
}
function isLegacyLedgerEvent(value, sessionId) {
    return (isRecord(value) &&
        value['sessionId'] === sessionId &&
        isNonNegativeInteger(value['seq']) &&
        typeof value['eventId'] === 'string' &&
        value['eventId'].length > 0 &&
        typeof value['kind'] === 'string' &&
        value['kind'].length > 0);
}
function readMessageRole(value) {
    if (!isRecord(value))
        return undefined;
    const message = isCanonicalEnvelopeShape(value) ? value['message'] : value;
    return isRecord(message) ? nonEmptyString(message['role']) : undefined;
}
function readMessageIdentity(value) {
    if (!isRecord(value))
        return undefined;
    const candidate = value['msg_id'] ?? value['id'] ?? value['messageId'];
    return typeof candidate === 'string' && /^(?:msg-.+|\d+)$/u.test(candidate)
        ? candidate
        : undefined;
}
function corruptSnapshot(filePath, cause) {
    return new Error(`Legacy Session snapshot is corrupt: ${filePath}`, { cause });
}
function corruptLedger(filePath, line, cause) {
    return new Error(`Legacy Session ledger event is corrupt: ${filePath}:${String(line)}`, {
        cause,
    });
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isFiniteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value);
}
function isNonNegativeInteger(value) {
    return Number.isSafeInteger(value) && Number(value) >= 0;
}
function nonEmptyString(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
function stableJson(value) {
    return JSON.stringify(sortJson(value));
}
function sortJson(value) {
    if (Array.isArray(value))
        return value.map(sortJson);
    if (!isRecord(value))
        return value;
    return Object.fromEntries(Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, sortJson(entry)]));
}
function hasCode(error, code) {
    return error instanceof Error && 'code' in error && error.code === code;
}
function errorReason(error) {
    return error instanceof Error ? error.message : String(error);
}
//# sourceMappingURL=released-session-history-reader.js.map