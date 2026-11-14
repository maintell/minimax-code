import { sql } from 'drizzle-orm';
import { check, getTableConfig, index, integer, primaryKey, sqliteTable, text, uniqueIndex, } from 'drizzle-orm/sqlite-core';
/**
 * Bunny 独立库（`<dataDir>/bunny/data/bunny.sqlite`）的表。
 *
 * 表名沿用 `local_runtime_*` 前缀；这些表只在本库，大库里没有同名表。
 */
export const bunnySpaces = sqliteTable('local_runtime_task_spaces', {
    id: text('id').primaryKey().notNull(),
    name: text('name').notNull(),
    color: text('color').notNull(),
    objective: text('objective').notNull().default(''),
    context: text('context_json', { mode: 'json' })
        .$type()
        .notNull()
        .default([]),
    projects: text('projects_json', { mode: 'json' }).$type().notNull().default([]),
    createdAtMs: integer('created_at_ms').notNull(),
    updatedAtMs: integer('updated_at_ms').notNull(),
});
/** 会话归属哪个空间。会话在大库，所以这里不设指向会话的外键，读取时按大库过滤。 */
export const bunnySpaceSessions = sqliteTable('local_runtime_task_space_sessions', {
    sessionId: text('session_id').primaryKey().notNull(),
    spaceId: text('space_id')
        .notNull()
        .references(() => bunnySpaces.id, { onDelete: 'cascade' }),
    createdAtMs: integer('created_at_ms').notNull(),
});
export const bunnyMemoryCursors = sqliteTable('local_runtime_bunny_memory_cursors', {
    sessionId: text('session_id').primaryKey(),
    throughRowId: integer('through_row_id').notNull(),
    updatedAtMs: integer('updated_at_ms').notNull(),
});
/** Bunny 自己的设置项，值是 JSON。 */
export const bunnySettings = sqliteTable('bunny_settings', {
    key: text('key').primaryKey().notNull(),
    valueJson: text('value_json').notNull(),
});
/**
 * One delegated piece of work and the only source of its delegation state.
 *
 * The table stores facts, never a cached run state: whether a task is queued
 * or running still comes from the turn system. Vocabulary that grows with new
 * collaboration shapes (`via`, completion actor, event types) is validated in
 * code so it can widen without rebuilding the table; checks here only keep
 * grouped facts whole. Lives in the Bunny store: Bunny is the only assigner
 * today, but the columns keep assigner identity and depth so other assigners
 * would add rows rather than change the shape.
 */
export const bunnyAssignmentTasks = sqliteTable('local_runtime_assignment_tasks', {
    taskId: text('task_id').primaryKey().notNull(),
    /** 会话在大库，这里不设外键；会话删除时由删除流程清理（C1），启动时清理孤儿（C13）。 */
    sessionId: text('session_id').notNull(),
    assignerSessionId: text('assigner_session_id').notNull(),
    assignerAgentName: text('assigner_agent_name').notNull(),
    /** Null keeps "never recorded" apart from false. */
    assignerWasRoot: integer('assigner_was_root', { mode: 'boolean' }),
    via: text('via').notNull(),
    depth: integer('depth').notNull(),
    reportBack: integer('report_back', { mode: 'boolean' }).notNull(),
    assignedAtMs: integer('assigned_at_ms').notNull(),
    goal: text('goal'),
    doneWhen: text('done_when_json', { mode: 'json' }).$type(),
    /** The user's own words that led to the task (R4.1). */
    userWords: text('user_words'),
    requestId: text('request_id'),
    requestAssignerSessionId: text('request_assigner_session_id'),
    pendingStartContent: text('pending_start_content'),
    pendingStartQueuedAtMs: integer('pending_start_queued_at_ms'),
    completionState: text('completion_state'),
    completionBy: text('completion_by'),
    completionAtMs: integer('completion_at_ms'),
    completionSummary: text('completion_summary'),
    reviewSessionId: text('review_session_id'),
    reviewTurnId: text('review_turn_id'),
    reviewReportKey: text('review_report_key'),
    reviewSummary: text('review_summary'),
    lastReportedKey: text('last_reported_key'),
    /** Optimistic concurrency token; every named write increments it. */
    revision: integer('revision').notNull().default(0),
    createdAtMs: integer('created_at_ms').notNull(),
    updatedAtMs: integer('updated_at_ms').notNull(),
}, (table) => [
    // One task per session today; dropping this index alone allows several later.
    uniqueIndex('idx_assignment_tasks_session').on(table.sessionId),
    index('idx_assignment_tasks_assigner_agent').on(table.assignerAgentName, table.assignedAtMs),
    index('idx_assignment_tasks_assigner_session').on(table.assignerSessionId),
    index('idx_assignment_tasks_review')
        .on(table.reviewSessionId)
        .where(sql `${table.reviewSessionId} IS NOT NULL`),
    index('idx_assignment_tasks_pending')
        .on(table.pendingStartQueuedAtMs)
        .where(sql `${table.pendingStartQueuedAtMs} IS NOT NULL`),
    index('idx_assignment_tasks_request')
        .on(table.requestAssignerSessionId, table.requestId)
        .where(sql `${table.requestId} IS NOT NULL`),
    check('assignment_tasks_identity', sql `length(trim(${table.taskId})) > 0 AND length(trim(${table.sessionId})) > 0`),
    check('assignment_tasks_depth', sql `${table.depth} >= 1`),
    check('assignment_tasks_flags', sql `${table.reportBack} IN (0, 1) AND (${table.assignerWasRoot} IS NULL OR ${table.assignerWasRoot} IN (0, 1))`),
    check('assignment_tasks_done_when', sql `${table.doneWhen} IS NULL OR (json_valid(${table.doneWhen}) AND json_type(${table.doneWhen}) = 'array')`),
    check('assignment_tasks_pending_start', sql `(${table.pendingStartContent} IS NULL) = (${table.pendingStartQueuedAtMs} IS NULL)`),
    check('assignment_tasks_completion', sql `(${table.completionState} IS NULL AND ${table.completionBy} IS NULL AND ${table.completionAtMs} IS NULL AND ${table.completionSummary} IS NULL)
        OR (${table.completionState} IS NOT NULL AND ${table.completionBy} IS NOT NULL AND ${table.completionAtMs} IS NOT NULL)`),
    check('assignment_tasks_review', sql `(${table.reviewSessionId} IS NULL AND ${table.reviewTurnId} IS NULL AND ${table.reviewReportKey} IS NULL AND ${table.reviewSummary} IS NULL)
        OR (${table.reviewSessionId} IS NOT NULL AND ${table.reviewTurnId} IS NOT NULL AND ${table.reviewReportKey} IS NOT NULL AND ${table.reviewSummary} IS NOT NULL)`),
    check('assignment_tasks_timestamps', sql `${table.revision} >= 0 AND ${table.createdAtMs} >= 0 AND ${table.updatedAtMs} >= ${table.createdAtMs}`),
]);
/**
 * Append-only history of one task. Counters such as review redeliveries are
 * projections of these rows, so they survive restarts by construction. A
 * dedupe key makes a replayed write a no-op.
 */
export const bunnyAssignmentTaskEvents = sqliteTable('local_runtime_assignment_task_events', {
    seq: integer('seq').primaryKey({ autoIncrement: true }),
    taskId: text('task_id')
        .notNull()
        .references(() => bunnyAssignmentTasks.taskId, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    payload: text('payload_json', { mode: 'json' }).$type().notNull(),
    dedupeKey: text('dedupe_key'),
    createdAtMs: integer('created_at_ms').notNull(),
}, (table) => [
    index('idx_assignment_task_events_task').on(table.taskId, table.seq),
    uniqueIndex('idx_assignment_task_events_dedupe')
        .on(table.dedupeKey)
        .where(sql `${table.dedupeKey} IS NOT NULL`),
    check('assignment_task_events_identity', sql `length(trim(${table.taskId})) > 0 AND length(trim(${table.type})) > 0
        AND (${table.dedupeKey} IS NULL OR length(trim(${table.dedupeKey})) > 0)`),
    check('assignment_task_events_payload', sql `json_valid(${table.payload}) AND json_type(${table.payload}) = 'object'`),
    check('assignment_task_events_timestamp', sql `${table.createdAtMs} >= 0`),
]);
/**
 * Bunny's working-state ledger ("近期约定"): cross-space corrections, constraints, open
 * questions and decisions not yet in a space context.md. Rows are never deleted except by Bunny
 * initialization; closing or replacing an entry changes its status.
 */
export const bunnyWorkingStateEntries = sqliteTable('local_runtime_working_state_entries', {
    id: text('id').primaryKey().notNull(),
    kind: text('kind', {
        enum: ['correction', 'constraint', 'open_question', 'context_gap'],
    }).notNull(),
    scope: text('scope').notNull(),
    text: text('text').notNull(),
    replaces: text('replaces'),
    expiresAtMs: integer('expires_at_ms'),
    supersedes: text('supersedes'),
    status: text('status', { enum: ['active', 'superseded', 'done'] }).notNull(),
    closeReason: text('close_reason', { enum: ['done', 'answered', 'withdrawn', 'expired'] }),
    /** Why it was closed, in words: the user's answer, or why a rule no longer applies. */
    closeNote: text('close_note'),
    sourceSessionId: text('source_session_id'),
    sourceMessageId: text('source_message_id'),
    sourceAtMs: integer('source_at_ms'),
    author: text('author', { enum: ['front', 'compactor', 'user'] }).notNull(),
    inferred: integer('inferred', { mode: 'boolean' }).notNull().default(false),
    /** Who made the latest change; the delta block reports changes Bunny did not make. */
    updatedBy: text('updated_by', { enum: ['front', 'compactor', 'user', 'system'] }).notNull(),
    /** When a handoff header first carried this entry; compactor entries wait for it. */
    handoffAtMs: integer('handoff_at_ms'),
    createdAtMs: integer('created_at_ms').notNull(),
    updatedAtMs: integer('updated_at_ms').notNull(),
    closedAtMs: integer('closed_at_ms'),
}, (table) => [
    index('idx_working_state_entries_status_updated').on(table.status, table.updatedAtMs),
    index('idx_working_state_entries_source').on(table.sourceMessageId, table.kind),
    check('working_state_entries_kind', sql `${table.kind} IN ('correction', 'constraint', 'open_question', 'context_gap')`),
    check('working_state_entries_scope', sql `${table.scope} = 'global' OR (${table.kind} = 'context_gap' AND ${table.scope} LIKE 'space:_%')`),
    check('working_state_entries_status', sql `${table.status} IN ('active', 'superseded', 'done')`),
    check('working_state_entries_close_reason', sql `${table.closeReason} IS NULL OR ${table.closeReason} IN ('done', 'answered', 'withdrawn', 'expired')`),
    check('working_state_entries_author', sql `${table.author} IN ('front', 'compactor', 'user')`),
    check('working_state_entries_updated_by', sql `${table.updatedBy} IN ('front', 'compactor', 'user', 'system')`),
]);
/**
 * One row per ledger change. The largest `seq` is the ledger revision; an operation ID
 * (batch ID + sequence) makes a replayed compactor write a no-op.
 */
export const bunnyWorkingStateEvents = sqliteTable('local_runtime_working_state_events', {
    seq: integer('seq').primaryKey({ autoIncrement: true }),
    entryId: text('entry_id').notNull(),
    action: text('action', {
        enum: ['add', 'supersede', 'close', 'expire', 'confirm'],
    }).notNull(),
    actor: text('actor', { enum: ['front', 'compactor', 'user', 'system'] }).notNull(),
    operationId: text('operation_id'),
    createdAtMs: integer('created_at_ms').notNull(),
}, (table) => [
    index('idx_working_state_events_entry').on(table.entryId, table.seq),
    uniqueIndex('idx_working_state_events_operation')
        .on(table.operationId)
        .where(sql `${table.operationId} IS NOT NULL`),
    check('working_state_events_action', sql `${table.action} IN ('add', 'supersede', 'close', 'expire', 'confirm')`),
    check('working_state_events_actor', sql `${table.actor} IN ('front', 'compactor', 'user', 'system')`),
]);
/**
 * What the last delta block delivered to each Bunny main conversation (spec 9.4):
 * one row per task, ledger entry, space context.md and the UI space, plus the
 * reserved `baseline` row. Cleared on a segment rebuild, a rewind and Bunny
 * initialization; the next delta block then sends the full state.
 */
export const bunnyDeliveryBaseline = sqliteTable('local_runtime_bunny_delivery_baseline', {
    sessionId: text('session_id').notNull(),
    entryKey: text('entry_key').notNull(),
    deliveredState: text('delivered_state').notNull(),
    updatedAtMs: integer('updated_at_ms').notNull(),
}, (table) => [primaryKey({ columns: [table.sessionId, table.entryKey] })]);
/**
 * Files the user imported into a space. They belong to no session, so the artifact catalog
 * lists them next to session deliveries; `space_id` is cleared when the space is deleted.
 */
export const bunnyArtifactLibrary = sqliteTable('local_runtime_artifact_library', {
    id: text('id').primaryKey().notNull(),
    assetKey: text('asset_key').notNull(),
    name: text('name').notNull(),
    path: text('path').notNull(),
    category: text('category').notNull(),
    workspaceDir: text('workspace_dir').notNull(),
    spaceId: text('space_id'),
    importedAtMs: integer('imported_at_ms').notNull(),
    updatedAtMs: integer('updated_at_ms').notNull(),
}, (table) => [index('idx_artifact_library_space').on(table.spaceId)]);
/**
 * Attachment descriptions a segment compaction committed (spec 12.6), keyed by
 * (session, message ID, asset ID). The conversation search index appends one to the
 * attachment's file-name line.
 */
export const bunnyMediaDescriptions = sqliteTable('local_runtime_bunny_media_descriptions', {
    sessionId: text('session_id').notNull(),
    messageId: text('message_id').notNull(),
    assetId: text('asset_id').notNull(),
    description: text('description').notNull(),
    seen: integer('seen', { mode: 'boolean' }).notNull(),
    compactionId: text('compaction_id').notNull(),
    createdAtMs: integer('created_at_ms').notNull(),
    updatedAtMs: integer('updated_at_ms').notNull(),
}, (table) => [primaryKey({ columns: [table.sessionId, table.messageId, table.assetId] })]);
/** Desktop task facts awaiting SDK acceptance; event IDs stay stable across retries. */
export const bunnyTaskTelemetry = sqliteTable('local_runtime_bunny_task_telemetry', {
    eventId: text('event_id').primaryKey().notNull(),
    event: text('event').notNull(),
    sessionId: text('session_id').notNull(),
    seq: integer('seq').notNull(),
    occurredAtMs: integer('occurred_at_ms').notNull(),
    params: text('params_json', { mode: 'json' }).$type().notNull(),
});
const BUNNY_STORE_TABLES = [
    bunnyTaskTelemetry,
    bunnySpaces,
    bunnySpaceSessions,
    bunnyMemoryCursors,
    bunnySettings,
    bunnyAssignmentTasks,
    bunnyAssignmentTaskEvents,
    bunnyWorkingStateEntries,
    bunnyWorkingStateEvents,
    bunnyDeliveryBaseline,
    bunnyArtifactLibrary,
    bunnyMediaDescriptions,
];
/** 启动时的轻量 schema 检查用：每张表应有的列。 */
export const BUNNY_STORE_TABLE_METADATA = BUNNY_STORE_TABLES.map((table) => {
    const config = getTableConfig(table);
    return { name: config.name, columns: config.columns.map((column) => column.name) };
});
//# sourceMappingURL=bunny-store.js.map