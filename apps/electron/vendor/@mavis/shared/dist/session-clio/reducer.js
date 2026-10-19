/**
 * The Session Clio source lifecycle reducer.
 *
 * Pure and total: no clock, no I/O, no randomness, no mutation of the state it
 * is given. Everything it needs about time arrives on the event. The caller
 * commits `state` and `steps` together in one transaction, so a crash between
 * emitting and committing is recoverable by replaying the same event — which
 * yields byte-identical output.
 */
import { SESSION_CLIO_INPUT_VERSION, sessionClioDeadlineMs } from './state.js';
import { EvalQueryTrigger, EvalStepType, EvalTurnStatus } from './wire.js';
/**
 * Five MiB leaves one MiB for the desktop batch envelope and two MiB below the
 * gateway/server request gates. Text is the only unbounded QaTurn member.
 */
const SESSION_CLIO_MAX_QA_TURN_PAYLOAD_BYTES = 5 << 20;
const SESSION_CLIO_TRUNCATION_MARKER = '\n[SESSION_CLIO_TRUNCATED]';
const UTF8_ENCODER = new TextEncoder();
/** Identity prefix for a Query that was admitted but never started a turn. */
export const SESSION_CLIO_ADMISSION_TURN_PREFIX = 'admission:';
/**
 * An event that contradicts already-committed, immutable capture.
 *
 * Thrown rather than returned: the adapter must roll its transaction back and
 * surface the conflict, never silently drop or overwrite a captured record.
 */
export class SessionClioContradictionError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.name = 'SessionClioContradictionError';
        this.code = code;
    }
}
/**
 * Advance capture by one event.
 *
 * Expiry is checked before anything else, so a Session freezes at its boundary
 * even when the only thing that ever arrives is a late Query or a late answer.
 * Once sealed, nothing is ever emitted again.
 */
export function applySessionClioEvent(state, event) {
    if (state.seal !== null)
        return { state, steps: [] };
    const observedAtMs = event.kind === 'tick' ? event.now_ms : event.occurred_at_ms;
    const deadlineMs = sessionClioDeadlineMs(state);
    if (deadlineMs !== null && observedAtMs > deadlineMs) {
        return freezeSession(state, deadlineMs, observedAtMs);
    }
    switch (event.kind) {
        case 'query':
            return admitQuery(state, event);
        case 'turn':
            return bindTurn(state, event);
        case 'terminal':
            return finalizeTurn(state, event);
        case 'tick':
            return { state, steps: [] };
    }
}
/**
 * Admit a Query and emit its metadata-only activity.
 *
 * The clock only moves forward: an out-of-order manual Query can never shorten
 * a Session's life by pulling the anchor backwards.
 */
function admitQuery(state, event) {
    const existing = state.queries.find((query) => query.query_id === event.query_id);
    if (existing !== undefined) {
        if (existing.text !== event.text ||
            existing.occurred_at_ms !== event.occurred_at_ms ||
            existing.trigger !== event.trigger) {
            throw new SessionClioContradictionError('query_conflict', `query ${event.query_id} was already admitted with different content`);
        }
        return { state, steps: [] };
    }
    const queryIndex = state.next_query_index;
    const record = {
        query_id: event.query_id,
        query_index: queryIndex,
        text: event.text,
        occurred_at_ms: event.occurred_at_ms,
        trigger: event.trigger,
        consumed_by_turn_id: null,
    };
    const lastManualAtMs = event.trigger === EvalQueryTrigger.Manual
        ? state.last_manual_query_at_ms === null
            ? event.occurred_at_ms
            : Math.max(state.last_manual_query_at_ms, event.occurred_at_ms)
        : state.last_manual_query_at_ms;
    const step = {
        seq: state.next_seq,
        step_type: EvalStepType.QueryActivity,
        client_produced_ts: event.occurred_at_ms,
        clio_payload: {
            query_activity: {
                query_id: record.query_id,
                query_index: record.query_index,
                occurred_at_ms: record.occurred_at_ms,
                trigger: record.trigger,
                input_version: SESSION_CLIO_INPUT_VERSION,
            },
        },
    };
    return {
        state: {
            ...state,
            first_query_at_ms: state.first_query_at_ms ?? event.occurred_at_ms,
            last_manual_query_at_ms: lastManualAtMs,
            next_seq: state.next_seq + 1,
            next_query_index: queryIndex + 1,
            queries: [...state.queries, record],
        },
        steps: [step],
    };
}
/**
 * Start a turn, or append steering queries to one already running.
 *
 * Emits nothing: a QA turn is uploaded whole, exactly once, when it ends. That
 * is what keeps the record immutable and free of partial question/answer state.
 */
function bindTurn(state, event) {
    const existing = state.turns.find((turn) => turn.turn_id === event.turn_id);
    const alreadyBound = existing?.query_ids ?? [];
    const appended = [];
    for (const queryId of event.query_ids) {
        if (alreadyBound.includes(queryId) || appended.includes(queryId))
            continue;
        const query = state.queries.find((candidate) => candidate.query_id === queryId);
        if (query === undefined) {
            throw new SessionClioContradictionError('unknown_query', `turn ${event.turn_id} consumed query ${queryId}, which was never admitted`);
        }
        if (query.consumed_by_turn_id !== null) {
            throw new SessionClioContradictionError('query_already_bound', `query ${queryId} is already consumed by turn ${query.consumed_by_turn_id}`);
        }
        appended.push(queryId);
    }
    if (appended.length === 0 && existing !== undefined)
        return { state, steps: [] };
    if (existing !== undefined && existing.turn_status !== null) {
        throw new SessionClioContradictionError('turn_finalized', `turn ${event.turn_id} is already finalized and cannot consume new queries`);
    }
    const queries = state.queries.map((query) => appended.includes(query.query_id) ? { ...query, consumed_by_turn_id: event.turn_id } : query);
    if (existing === undefined) {
        const record = {
            turn_id: event.turn_id,
            turn_index: state.next_turn_index,
            query_ids: appended,
            occurred_at_ms: event.occurred_at_ms,
            turn_status: null,
            final_response: null,
            final_message_ids: null,
        };
        return {
            state: {
                ...state,
                next_turn_index: state.next_turn_index + 1,
                queries,
                turns: [...state.turns, record],
            },
            steps: [],
        };
    }
    const turns = state.turns.map((turn) => turn.turn_id === event.turn_id
        ? { ...turn, query_ids: [...turn.query_ids, ...appended] }
        : turn);
    return { state: { ...state, queries, turns }, steps: [] };
}
/**
 * Finalize a turn and emit its complete record.
 *
 * A failed or cancelled turn keeps every query it consumed and simply carries
 * no answer; the reducer never substitutes process output for a real reply.
 */
function finalizeTurn(state, event) {
    const reported = event.turn_status;
    if (reported !== EvalTurnStatus.Completed &&
        reported !== EvalTurnStatus.Failed &&
        reported !== EvalTurnStatus.Canceled) {
        throw new SessionClioContradictionError('invalid_turn_status', `terminal for turn ${event.turn_id} reported status ${String(reported)}; a source may only report Completed, Failed or Canceled`);
    }
    const turn = state.turns.find((candidate) => candidate.turn_id === event.turn_id);
    if (turn === undefined) {
        throw new SessionClioContradictionError('unknown_turn', `terminal for turn ${event.turn_id}, which never started`);
    }
    const finalResponse = event.final_response ?? null;
    const finalMessageIds = event.final_message_ids ?? null;
    if (turn.turn_status !== null) {
        const sameMessageIds = turn.final_message_ids === null || finalMessageIds === null
            ? turn.final_message_ids === finalMessageIds
            : turn.final_message_ids.length === finalMessageIds.length &&
                turn.final_message_ids.every((id, index) => id === finalMessageIds[index]);
        if (turn.turn_status !== event.turn_status ||
            turn.final_response !== finalResponse ||
            !sameMessageIds) {
            throw new SessionClioContradictionError('terminal_conflict', `turn ${event.turn_id} is already finalized with a different outcome`);
        }
        return { state, steps: [] };
    }
    const finalized = {
        ...turn,
        turn_status: event.turn_status,
        final_response: finalResponse,
        final_message_ids: finalMessageIds === null ? null : [...finalMessageIds],
    };
    const step = {
        seq: state.next_seq,
        step_type: EvalStepType.QaTurn,
        client_produced_ts: event.occurred_at_ms,
        clio_payload: { turn: buildQaTurnPayload(finalized, indexQueries(state.queries)) },
    };
    return {
        state: {
            ...state,
            next_seq: state.next_seq + 1,
            turns: state.turns.map((candidate) => candidate.turn_id === event.turn_id ? finalized : candidate),
        },
        steps: [step],
    };
}
/**
 * Freeze the Session at its first inactivity boundary.
 *
 * Everything still open is materialized once, at the boundary, as `Unfinished`:
 * turns that were running, and Queries that were admitted but never started a
 * turn. Then exactly one manifest is emitted. Answers that arrive later can
 * never backfill, because the state is sealed and emits nothing again.
 */
function freezeSession(state, deadlineMs, observedAtMs) {
    const sealedAtMs = deadlineMs + 1;
    const byQueryId = indexQueries(state.queries);
    const turns = [];
    const materialized = [];
    for (const turn of state.turns) {
        if (turn.turn_status === null) {
            const frozen = { ...turn, turn_status: EvalTurnStatus.Unfinished };
            turns.push(frozen);
            materialized.push(frozen);
            continue;
        }
        turns.push(turn);
    }
    const queries = [];
    let nextTurnIndex = state.next_turn_index;
    for (const query of state.queries) {
        if (query.consumed_by_turn_id !== null) {
            queries.push(query);
            continue;
        }
        const turnId = `${SESSION_CLIO_ADMISSION_TURN_PREFIX}${query.query_index}`;
        const record = {
            turn_id: turnId,
            turn_index: nextTurnIndex,
            query_ids: [query.query_id],
            occurred_at_ms: query.occurred_at_ms,
            turn_status: EvalTurnStatus.Unfinished,
            final_response: null,
            final_message_ids: null,
        };
        nextTurnIndex += 1;
        turns.push(record);
        materialized.push(record);
        queries.push({ ...query, consumed_by_turn_id: turnId });
    }
    let seq = state.next_seq;
    const steps = [];
    for (const turn of materialized) {
        steps.push({
            seq,
            step_type: EvalStepType.QaTurn,
            client_produced_ts: sealedAtMs,
            clio_payload: { turn: buildQaTurnPayload(turn, byQueryId) },
        });
        seq += 1;
    }
    const seal = {
        sealed_at_ms: sealedAtMs,
        confirmed_at_ms: Math.max(sealedAtMs, observedAtMs),
        query_count: queries.length,
        turn_count: turns.length,
    };
    steps.push({
        seq,
        step_type: EvalStepType.SessionSeal,
        client_produced_ts: sealedAtMs,
        clio_payload: {
            session_seal: {
                sealed_at_ms: seal.sealed_at_ms,
                confirmed_at_ms: seal.confirmed_at_ms,
                query_count: seal.query_count,
                turn_count: seal.turn_count,
                input_version: SESSION_CLIO_INPUT_VERSION,
            },
        },
    });
    seq += 1;
    return {
        state: { ...state, next_seq: seq, next_turn_index: nextTurnIndex, queries, turns, seal },
        steps,
    };
}
function indexQueries(queries) {
    const byQueryId = new Map();
    for (const query of queries)
        byQueryId.set(query.query_id, query);
    return byQueryId;
}
/** Build the wire record; absent optional members are omitted, never `undefined`. */
function buildQaTurnPayload(turn, byQueryId) {
    const userQueries = turn.query_ids.map((queryId) => {
        const query = byQueryId.get(queryId);
        if (query === undefined) {
            throw new SessionClioContradictionError('unknown_query', `turn ${turn.turn_id} consumed query ${queryId}, which was never admitted`);
        }
        return {
            query_id: query.query_id,
            query_index: query.query_index,
            text: query.text,
            occurred_at_ms: query.occurred_at_ms,
            trigger: query.trigger,
        };
    });
    return boundQaTurnPayload({
        turn_id: turn.turn_id,
        turn_index: turn.turn_index,
        user_queries: userQueries,
        turn_status: turn.turn_status ?? EvalTurnStatus.Unfinished,
        ...(turn.final_response === null ? {} : { final_response: turn.final_response }),
        ...(turn.final_message_ids === null ? {} : { final_message_ids: [...turn.final_message_ids] }),
        occurred_at_ms: turn.occurred_at_ms,
        input_version: SESSION_CLIO_INPUT_VERSION,
    });
}
/**
 * Keeps the immutable record inside its transport contract while preserving a
 * prefix of every genuine Query and final answer. Truncation is always declared
 * in-band; normal records are returned byte-for-byte unchanged.
 */
function boundQaTurnPayload(payload) {
    const originalQueries = payload.user_queries;
    const boundedQueries = originalQueries.map((query) => ({
        ...query,
        text: SESSION_CLIO_TRUNCATION_MARKER,
    }));
    const originalFinalResponse = payload.final_response;
    let boundedFinalResponse = originalFinalResponse === undefined ? undefined : SESSION_CLIO_TRUNCATION_MARKER;
    let bounded = replaceQaTurnTexts(payload, boundedQueries, boundedFinalResponse);
    const markerBytes = jsonStringUtf8Bytes(SESSION_CLIO_TRUNCATION_MARKER);
    const baseBytes = jsonUtf8Bytes({ turn: bounded });
    const fullBytes = baseBytes +
        originalQueries.reduce((total, query) => total + jsonStringUtf8Bytes(query.text) - markerBytes, 0) +
        (originalFinalResponse === undefined
            ? 0
            : jsonStringUtf8Bytes(originalFinalResponse) - markerBytes);
    if (fullBytes <= SESSION_CLIO_MAX_QA_TURN_PAYLOAD_BYTES)
        return payload;
    let remainingBytes = SESSION_CLIO_MAX_QA_TURN_PAYLOAD_BYTES - baseBytes;
    let remainingFields = originalQueries.length + (originalFinalResponse === undefined ? 0 : 1);
    for (let index = 0; index < originalQueries.length; index += 1) {
        const original = originalQueries[index];
        if (!original)
            continue;
        const fieldBudget = markerBytes + Math.max(0, Math.floor(remainingBytes / remainingFields));
        const text = boundTextToJsonBytes(original.text, fieldBudget);
        boundedQueries[index] = { ...original, text };
        remainingBytes -= jsonStringUtf8Bytes(text) - markerBytes;
        remainingFields -= 1;
    }
    if (originalFinalResponse !== undefined) {
        const fieldBudget = markerBytes + Math.max(0, remainingBytes);
        boundedFinalResponse = boundTextToJsonBytes(originalFinalResponse, fieldBudget);
    }
    bounded = replaceQaTurnTexts(payload, boundedQueries, boundedFinalResponse);
    return bounded;
}
function replaceQaTurnTexts(payload, userQueries, finalResponse) {
    const next = { ...payload, user_queries: userQueries };
    if (finalResponse === undefined) {
        delete next.final_response;
    }
    else {
        next.final_response = finalResponse;
    }
    return next;
}
/** Bounds the JSON-encoded UTF-8 bytes without splitting a surrogate pair. */
function boundTextToJsonBytes(text, maxBytes) {
    if (jsonStringUtf8Bytes(text) <= maxBytes)
        return text;
    const prefixBudget = Math.max(0, maxBytes - jsonStringUtf8Bytes(SESSION_CLIO_TRUNCATION_MARKER));
    let prefixBytes = 0;
    let end = 0;
    while (end < text.length) {
        const width = jsonStringUnitWidth(text, end);
        const bytes = jsonStringUnitBytes(text.charCodeAt(end), width);
        if (prefixBytes + bytes > prefixBudget)
            break;
        prefixBytes += bytes;
        end += width;
    }
    return `${text.slice(0, end)}${SESSION_CLIO_TRUNCATION_MARKER}`;
}
function jsonStringUtf8Bytes(text) {
    let bytes = 2;
    for (let index = 0; index < text.length;) {
        const width = jsonStringUnitWidth(text, index);
        bytes += jsonStringUnitBytes(text.charCodeAt(index), width);
        index += width;
    }
    return bytes;
}
function jsonStringUnitWidth(text, index) {
    return isHighSurrogate(text.charCodeAt(index)) &&
        index + 1 < text.length &&
        isLowSurrogate(text.charCodeAt(index + 1))
        ? 2
        : 1;
}
function jsonStringUnitBytes(codeUnit, width) {
    if (codeUnit === 0x22 || codeUnit === 0x5c)
        return 2;
    if (codeUnit <= 0x1f) {
        return codeUnit === 0x08 ||
            codeUnit === 0x09 ||
            codeUnit === 0x0a ||
            codeUnit === 0x0c ||
            codeUnit === 0x0d
            ? 2
            : 6;
    }
    if (codeUnit <= 0x7f)
        return 1;
    if (codeUnit <= 0x7ff)
        return 2;
    if (isHighSurrogate(codeUnit) || isLowSurrogate(codeUnit))
        return width === 2 ? 4 : 6;
    return 3;
}
function isHighSurrogate(codeUnit) {
    return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}
function isLowSurrogate(codeUnit) {
    return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}
function jsonUtf8Bytes(value) {
    const json = JSON.stringify(value);
    return json === undefined ? 0 : UTF8_ENCODER.encode(json).byteLength;
}
//# sourceMappingURL=reducer.js.map