import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
/**
 * The Goal owner's authoritative table. A Session holds at most one current Goal;
 * `updated_at_ms` doubles as the Goal decision epoch that admission, settlement
 * and user writes compare-and-set against. Migration 46 created it from the
 * retired v1 table `local_runtime_thread_goals`, which nothing writes any more.
 */
export const localRuntimeV2Goals = sqliteTable('local_runtime_v2_goals', {
    goalId: text('goal_id').primaryKey(),
    sessionId: text('session_id').notNull(),
    objective: text('objective').notNull(),
    status: text('status').notNull(),
    statusReason: text('status_reason'),
    createdAtMs: integer('created_at_ms').notNull(),
    updatedAtMs: integer('updated_at_ms').notNull(),
    tokensUsed: integer('tokens_used').notNull().default(0),
    turnsUsed: integer('turns_used').notNull().default(0),
    timeUsedSeconds: integer('time_used_seconds').notNull().default(0),
    tokenBudget: integer('token_budget'),
    objectiveResourcesJson: text('objective_resources_json').notNull().default('[]'),
    kickoffAttachmentsJson: text('kickoff_attachments_json').notNull().default('[]'),
    kickoffState: text('kickoff_state').notNull().default('consumed'),
    replyFingerprint: text('reply_fingerprint'),
    noProgressStreak: integer('no_progress_streak').notNull().default(0),
    noToolStreak: integer('no_tool_streak').notNull().default(0),
    lastVerification: text('last_verification'),
    lastWorkerProposal: text('last_worker_proposal'),
    executionWaitReason: text('execution_wait_reason'),
    executionWaitSinceMs: integer('execution_wait_since_ms'),
    executionWaitEpoch: integer('execution_wait_epoch'),
    usageRecoveryAtMs: integer('usage_recovery_at_ms'),
    dismissedAtMs: integer('dismissed_at_ms'),
    /**
     * 1: legacy (input + output of main execution); 2: full usage, the four
     * parts below summed over every attributed request (migration 48).
     */
    tokenAccountingVersion: integer('token_accounting_version').notNull().default(1),
    inputTokens: integer('input_tokens').notNull().default(0),
    cacheWriteTokens: integer('cache_write_tokens').notNull().default(0),
    cacheReadTokens: integer('cache_read_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    /**
     * Some charged request came back through a route that does not report
     * cache writes, so `cacheWriteTokens` is not a measurement (migration 51).
     */
    cacheWriteUnreported: integer('cache_write_unreported', { mode: 'boolean' })
        .notNull()
        .default(false),
}, (table) => [
    uniqueIndex('idx_local_runtime_v2_goals_session').on(table.sessionId),
    index('idx_local_runtime_v2_goals_kickoff_state').on(table.kickoffState, table.sessionId),
]);
/** `token_accounting_version` of a Goal metered under full-usage accounting. */
export const FULL_USAGE_TOKEN_ACCOUNTING = 2;
/**
 * One row per logical LLM request of Goal main execution (migration 47). The
 * row is reserved before the request is sent, marked `dispatching` when its
 * first attempt is handed to the transport, and settled with every attempt's
 * known usage; a row left `dispatching` by a crash is settled when every
 * attempt handed to the transport has a receipt (`outcome` set) and otherwise
 * becomes `unresolved`, keeping its occupancy. Usage writes never touch the
 * Goal decision epoch.
 */
export const localRuntimeV2GoalRequests = sqliteTable('local_runtime_v2_goal_requests', {
    requestId: text('request_id').primaryKey(),
    goalId: text('goal_id').notNull(),
    sessionId: text('session_id').notNull(),
    turnId: text('turn_id').notNull(),
    /** `work` counts toward the request cap; `grace` is a tool-less wrap-up. */
    kind: text('kind').notNull(),
    /** reserved | dispatching | settled | voided | unresolved | discarded */
    phase: text('phase').notNull(),
    attempts: integer('attempts').notNull().default(0),
    outcome: text('outcome'),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    cacheReadTokens: integer('cache_read_tokens').notNull().default(0),
    cacheWriteTokens: integer('cache_write_tokens').notNull().default(0),
    usageIncomplete: integer('usage_incomplete', { mode: 'boolean' }).notNull().default(false),
    /** Why a settled request was not applied to its Goal (for example `goal_deleted`). */
    discardReason: text('discard_reason'),
    createdAtMs: integer('created_at_ms').notNull(),
    updatedAtMs: integer('updated_at_ms').notNull(),
}, (table) => [
    index('idx_local_runtime_v2_goal_requests_goal').on(table.goalId, table.kind, table.phase),
    index('idx_local_runtime_v2_goal_requests_turn').on(table.turnId, table.kind),
    index('idx_local_runtime_v2_goal_requests_session').on(table.sessionId),
    index('idx_local_runtime_v2_goal_requests_updated').on(table.updatedAtMs),
]);
/**
 * One row per logical LLM request charged to a full-usage Goal outside the
 * request ledger (migration 48): automatic compaction in a Goal Turn, a
 * sub-session round the Goal Turn started, the subagent verifier. These
 * requests count tokens only; they are not Goal requests and never pass the
 * ledger's admission. The token columns are the applied watermark, as on the
 * ledger: each write charges the Goal only their growth.
 */
export const localRuntimeV2GoalTokenCharges = sqliteTable('local_runtime_v2_goal_token_charges', {
    requestId: text('request_id').primaryKey(),
    goalId: text('goal_id').notNull(),
    sessionId: text('session_id').notNull(),
    turnId: text('turn_id').notNull(),
    /** compaction (in a Goal Turn) | sub_session (any request of an attributed round) */
    source: text('source').notNull(),
    /** open | settled | unresolved | discarded */
    phase: text('phase').notNull(),
    attempts: integer('attempts').notNull().default(0),
    outcome: text('outcome'),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    cacheReadTokens: integer('cache_read_tokens').notNull().default(0),
    cacheWriteTokens: integer('cache_write_tokens').notNull().default(0),
    usageIncomplete: integer('usage_incomplete', { mode: 'boolean' }).notNull().default(false),
    discardReason: text('discard_reason'),
    createdAtMs: integer('created_at_ms').notNull(),
    updatedAtMs: integer('updated_at_ms').notNull(),
}, (table) => [
    index('idx_local_runtime_v2_goal_token_charges_goal').on(table.goalId, table.phase),
    index('idx_local_runtime_v2_goal_token_charges_session').on(table.sessionId),
    index('idx_local_runtime_v2_goal_token_charges_updated').on(table.updatedAtMs),
]);
//# sourceMappingURL=goal.js.map