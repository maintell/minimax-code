import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
export const backgroundTasks = sqliteTable('local_runtime_background_tasks', {
    taskId: text('task_id').primaryKey(),
    ownerSessionId: text('owner_session_id').notNull(),
    kind: text('kind').notNull(),
    status: text('status').notNull(),
    createdAtMs: integer('created_at_ms').notNull(),
    updatedAtMs: integer('updated_at_ms').notNull(),
    endedAtMs: integer('ended_at_ms'),
    recordJson: text('record_json').notNull(),
    deliveredAtMs: integer('delivered_at_ms'),
    isDeleted: integer('is_deleted', { mode: 'boolean' }).notNull().default(false),
}, (table) => [
    index('idx_local_runtime_background_tasks_owner').on(table.ownerSessionId, table.createdAtMs, table.taskId),
    index('idx_local_runtime_background_tasks_status').on(table.status, table.updatedAtMs, table.taskId),
    index('idx_local_runtime_background_tasks_owner_status_delivery').on(table.ownerSessionId, table.status, table.deliveredAtMs, table.endedAtMs, table.taskId),
]);
//# sourceMappingURL=background-tasks.js.map