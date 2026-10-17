import { sql } from 'drizzle-orm';
import { check, index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';
/**
 * Durable Session Clio source state, partitioned by the identity that produced it.
 *
 * `identity_key` is the raw desktop identity string (never parsed to a number: archon user ids
 * are i64 snowflakes). Switching users therefore selects a different partition instead of
 * re-attributing an existing Session's records.
 *
 * A row exists for every Session the capture has ever *decided about*. `eligibility = 'excluded'`
 * is a durable tombstone for Sessions that already had history when capture first observed them,
 * so a pre-existing Session can never opt in mid-history on a later query.
 */
export const sessionClioState = sqliteTable('local_runtime_session_clio_state', {
    identityKey: text('identity_key').notNull(),
    sessionId: text('session_id').notNull(),
    trajectoryId: text('trajectory_id').notNull(),
    captureOrigin: integer('capture_origin').notNull(),
    bizId: text('biz_id').notNull(),
    inputVersion: integer('input_version').notNull(),
    eligibility: text('eligibility').notNull(),
    /** Serialized `SessionClioState`; empty string for excluded Sessions. */
    stateJson: text('state_json').notNull(),
    /** First source inactivity boundary; 0 when excluded. */
    deadlineMs: integer('deadline_ms').notNull(),
    sealedAtMs: integer('sealed_at_ms').notNull().default(0),
    createdAtMs: integer('created_at_ms').notNull(),
    updatedAtMs: integer('updated_at_ms').notNull(),
}, (table) => [
    primaryKey({ columns: [table.identityKey, table.sessionId] }),
    check('local_runtime_session_clio_state_eligibility_check', sql `${table.eligibility} IN ('enrolled', 'excluded')`),
    /**
     * Drives the source inactivity tick. Excluded rows keep `deadline_ms = 0` and are skipped by
     * the `deadline_ms > 0` predicate, so no partial index is required.
     */
    index('idx_local_runtime_session_clio_state_due').on(table.sealedAtMs, table.deadlineMs),
]);
/**
 * Exact-record upload outbox. Rows are inserted in the same transaction as the state advance that
 * produced them, and are deleted only for the exact `seq` set a successful report carried. There is
 * deliberately no acked-watermark deletion: a hole must survive its neighbours being acknowledged.
 */
export const sessionClioOutbox = sqliteTable('local_runtime_session_clio_outbox', {
    identityKey: text('identity_key').notNull(),
    sessionId: text('session_id').notNull(),
    seq: integer('seq').notNull(),
    trajectoryId: text('trajectory_id').notNull(),
    captureOrigin: integer('capture_origin').notNull(),
    bizId: text('biz_id').notNull(),
    inputVersion: integer('input_version').notNull(),
    stepType: integer('step_type').notNull(),
    clientProducedTs: integer('client_produced_ts').notNull(),
    /** Serialized `EvalClioPayload`; retained verbatim so every retry resends byte-identical content. */
    payloadJson: text('payload_json').notNull(),
    createdAtMs: integer('created_at_ms').notNull(),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAtMs: integer('next_attempt_at_ms').notNull().default(0),
    lastError: text('last_error'),
}, (table) => [
    primaryKey({ columns: [table.identityKey, table.sessionId, table.seq] }),
    check('local_runtime_session_clio_outbox_step_type_check', sql `${table.stepType} IN (6, 7, 8)`),
    index('idx_local_runtime_session_clio_outbox_ready').on(table.identityKey, table.nextAttemptAtMs, table.sessionId, table.seq),
]);
/** Gate metadata consumed by `schema-consistency.ts`, kept beside the DDL above. */
export const SESSION_CLIO_TABLE_NAMES = new Set([
    'local_runtime_session_clio_state',
    'local_runtime_session_clio_outbox',
]);
export const SESSION_CLIO_INDEX_NAMES = new Set([
    'idx_local_runtime_session_clio_state_due',
    'idx_local_runtime_session_clio_outbox_ready',
]);
//# sourceMappingURL=session-clio.js.map