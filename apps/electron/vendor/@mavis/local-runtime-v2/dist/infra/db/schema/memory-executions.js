import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
export const memoryExecutionTasks = sqliteTable('local_runtime_v2_memory_execution_tasks', {
    taskId: text('task_id').primaryKey(),
    stage: text('stage').notNull(),
    operation: text('operation').notNull(),
    sourceRef: text('source_ref'),
    sourceRevision: text('source_revision'),
    previewId: text('preview_id'),
    startedAtMs: integer('started_at_ms').notNull(),
    finishedAtMs: integer('finished_at_ms'),
    status: text('status').notNull(),
    reason: text('reason'),
}, (table) => [
    index('idx_memory_execution_tasks_started').on(table.startedAtMs, table.taskId),
    index('idx_memory_execution_tasks_source').on(table.stage, table.sourceRef, table.startedAtMs),
]);
export const memoryExecutionCalls = sqliteTable('local_runtime_v2_memory_execution_calls', {
    callId: text('call_id').primaryKey(),
    taskId: text('task_id')
        .notNull()
        .references(() => memoryExecutionTasks.taskId),
    ordinal: integer('ordinal').notNull(),
    sourceRef: text('source_ref'),
    model: text('model').notNull(),
    reasoningEffort: text('reasoning_effort').notNull(),
    startedAtMs: integer('started_at_ms').notNull(),
    finishedAtMs: integer('finished_at_ms'),
    stopReason: text('stop_reason'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    cacheReadTokens: integer('cache_read_tokens'),
    cacheWriteTokens: integer('cache_write_tokens'),
    totalTokens: integer('total_tokens'),
}, (table) => [uniqueIndex('idx_memory_execution_calls_ordinal').on(table.taskId, table.ordinal)]);
//# sourceMappingURL=memory-executions.js.map