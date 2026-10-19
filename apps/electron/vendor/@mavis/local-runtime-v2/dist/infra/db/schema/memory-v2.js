import { asc, desc, sql } from 'drizzle-orm';
import { check, index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';
export const memoryV2Scopes = sqliteTable('local_runtime_v2_memory_scopes', {
    // 恒为 'global'（设计 §2.2）；保留列与主键形态是为将来再分区留出位置。
    scopeKey: text('scope_key').primaryKey(),
    resetEpoch: integer('reset_epoch').notNull().default(0),
    resetAtMs: integer('reset_at_ms').notNull().default(0),
    consolidatedDigest: text('consolidated_digest'),
    lastConsolidatedAtMs: integer('last_consolidated_at_ms'),
    createdAtMs: integer('created_at_ms').notNull(),
    updatedAtMs: integer('updated_at_ms').notNull(),
    governanceRevision: integer('governance_revision').notNull().default(0),
    consolidatedGovernanceRevision: integer('consolidated_governance_revision')
        .notNull()
        .default(0),
}, (table) => [
    check('local_runtime_v2_memory_scopes_reset_epoch_check', sql `${table.resetEpoch} >= 0`),
    check('local_runtime_v2_memory_scopes_reset_at_ms_check', sql `${table.resetAtMs} >= 0`),
]);
export const memoryV2SessionStates = sqliteTable('local_runtime_v2_memory_session_states', {
    scopeKey: text('scope_key')
        .notNull()
        .references(() => memoryV2Scopes.scopeKey, { onDelete: 'cascade' }),
    sessionId: text('session_id').notNull(),
    sessionCreatedAtMs: integer('session_created_at_ms').notNull(),
    sourceRevision: text('source_revision').notNull(),
    sourceDigest: text('source_digest').notNull(),
    captureContractId: text('capture_contract_id').notNull(),
    // 会话记忆文档按 §6.2 物化后的镜像内容指纹，参与 inputDigest 并用于检测镜像待重物化。
    outputDigest: text('output_digest').notNull(),
    // 会话记忆文档正文（§6.2，不含 frontmatter）；NULL 表示合法空结果或已排除，不进入选集。
    content: text('content'),
    // 遗忘规则全文；NULL 表示无规则。只由 Reset 或会话删除清除（§5.8）。
    forgetRules: text('forget_rules'),
    // 标注元数据（§2.2）：写入镜像 frontmatter，供 §6.4 补物化逐字节还原；NULL 表示未标注。
    agentName: text('agent_name'),
    projectName: text('project_name'),
    workspaceDir: text('workspace_dir'),
    capturedAtMs: integer('captured_at_ms').notNull(),
    lastUsedAtMs: integer('last_used_at_ms'),
    exclusionReason: text('exclusion_reason'),
    createdAtMs: integer('created_at_ms').notNull(),
    updatedAtMs: integer('updated_at_ms').notNull(),
}, (table) => [
    primaryKey({ columns: [table.scopeKey, table.sessionId] }),
    check('local_runtime_v2_memory_session_states_last_used_check', sql `${table.lastUsedAtMs} IS NULL OR ${table.lastUsedAtMs} >= 0`),
    index('idx_local_runtime_v2_memory_session_states_selection').on(table.scopeKey, table.exclusionReason, desc(table.lastUsedAtMs), desc(table.capturedAtMs), asc(table.sessionId)),
]);
export const memoryV2CaptureAttempts = sqliteTable('local_runtime_v2_memory_capture_attempts', {
    scopeKey: text('scope_key')
        .notNull()
        .references(() => memoryV2Scopes.scopeKey, { onDelete: 'cascade' }),
    sessionId: text('session_id').notNull(),
    // 记账绑定的来源修订；revision 变化即重置计数（§6.1）。
    sourceRevision: text('source_revision').notNull(),
    attempts: integer('attempts').notNull(),
    lastReason: text('last_reason'),
    // 最早可重试时刻；到期本身不产生唤醒（§2.3）。
    retryAtMs: integer('retry_at_ms').notNull(),
    updatedAtMs: integer('updated_at_ms').notNull(),
}, (table) => [
    primaryKey({ columns: [table.scopeKey, table.sessionId] }),
    check('local_runtime_v2_memory_capture_attempts_attempts_check', sql `${table.attempts} >= 1`),
]);
export const memoryV2BaselineFiles = sqliteTable('local_runtime_v2_memory_baseline_files', {
    scopeKey: text('scope_key')
        .notNull()
        .references(() => memoryV2Scopes.scopeKey, { onDelete: 'cascade' }),
    // 'MEMORY.md'、'memory_summary.md' 或 'sessions/<sessionId>.md'
    fileName: text('file_name').notNull(),
    // 上次成功整理时该文件的完整内容；与完成标记同事务整体替换（§5.6）。
    content: text('content').notNull(),
    updatedAtMs: integer('updated_at_ms').notNull(),
}, (table) => [primaryKey({ columns: [table.scopeKey, table.fileName] })]);
//# sourceMappingURL=memory-v2.js.map