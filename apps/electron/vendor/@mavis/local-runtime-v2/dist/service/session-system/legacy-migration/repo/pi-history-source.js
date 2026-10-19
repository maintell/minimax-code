import { asc, eq } from 'drizzle-orm';
import { decodeCanonicalHistoryEnvelope } from '../../../../infra/file/canonical-history.js';
import { legacyPiHistoryRows } from '../../../../infra/db/schema/legacy-session.js';
import { legacyMessages } from '../../../../infra/db/schema/messages.js';
import { isCanonicalEnvelopeShape, normalizeLegacyHistoryTimestamp, } from '../legacy-history-timestamp.js';
export function createLegacyHistorySourceReader(options) {
    return new DrizzleLegacyHistorySourceReader(options);
}
class DrizzleLegacyHistorySourceReader {
    options;
    constructor(options) {
        this.options = options;
    }
    async readLedgerSnapshot(sessionId) {
        return this.options.readLedgerSnapshot(sessionId);
    }
    async readSqliteRows(sessionId) {
        let rows;
        try {
            rows = this.options.db
                .select()
                .from(legacyPiHistoryRows)
                .where(eq(legacyPiHistoryRows.sessionId, sessionId))
                .orderBy(asc(legacyPiHistoryRows.id))
                .all();
        }
        catch (error) {
            if (missingTable(error, 'local_runtime_pi_history_rows'))
                return [];
            throw error;
        }
        return rows.map((row) => parseLegacyValue(row.dataJson, String(row.id), `legacy-row-${String(row.id)}`, row.createdAtMs));
    }
    async readSqliteBlob(sessionId) {
        const row = this.options.db
            .select()
            .from(legacyMessages)
            .where(eq(legacyMessages.sessionId, sessionId))
            .get();
        if (!row)
            return [];
        let parsed;
        try {
            parsed = JSON.parse(row.piHistoryJson);
        }
        catch {
            throw new Error(`Legacy Pi History blob is corrupt: ${sessionId}`);
        }
        if (!Array.isArray(parsed))
            throw new Error(`Legacy Pi History blob is corrupt: ${sessionId}`);
        return parsed.map((value, index) => decodeLegacyValue(value, `msg-legacy-blob-${String(index + 1)}`, `legacy-blob-${String(index + 1)}`));
    }
}
function parseLegacyValue(raw, messageId, turnId, stableFallback) {
    try {
        return decodeLegacyValue(JSON.parse(raw), messageId, turnId, stableFallback);
    }
    catch (error) {
        throw new Error('Legacy Pi History row is corrupt', { cause: error });
    }
}
function decodeLegacyValue(value, fallbackMessageId, fallbackTurnId, stableFallback) {
    const normalized = normalizeLegacyHistoryTimestamp(value, stableFallback);
    try {
        return decodeCanonicalHistoryEnvelope(normalized);
    }
    catch (envelopeError) {
        return decodeWrappedLegacyValue(normalized, fallbackMessageId, fallbackTurnId, envelopeError);
    }
}
function decodeWrappedLegacyValue(value, fallbackMessageId, fallbackTurnId, envelopeError) {
    const record = isRecord(value) ? value : {};
    try {
        return decodeCanonicalHistoryEnvelope({
            message_id: legacyMessageId(record, fallbackMessageId),
            turn_id: nonEmptyString(record.turn_id ?? record.turnId) ?? fallbackTurnId,
            message: value,
        });
    }
    catch (wrappedError) {
        throw isCanonicalEnvelopeShape(record) ? envelopeError : wrappedError;
    }
}
function legacyMessageId(record, fallback) {
    const candidate = record.message_id ?? record.messageId ?? record.id;
    return validMessageId(candidate) ? candidate : fallback;
}
function missingTable(error, table) {
    return error instanceof Error && error.message === `no such table: ${table}`;
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function validMessageId(value) {
    return typeof value === 'string' && /^(?:msg-.+|\d+)$/u.test(value);
}
function nonEmptyString(value) {
    return typeof value === 'string' && value.trim() ? value : undefined;
}
//# sourceMappingURL=pi-history-source.js.map