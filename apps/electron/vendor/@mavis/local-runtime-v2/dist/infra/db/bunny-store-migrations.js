/** Bunny 独立库的迁移历史表，与大库的 `local_runtime_v2_schema_migrations` 分开。 */
export const BUNNY_STORE_MIGRATION_HISTORY_TABLE = 'bunny_schema_migrations';
/** Bunny 独立库 v1：空间、空间会话、记忆游标、设置。 */
const createBunnyStore = {
    version: 1,
    name: 'create_bunny_store',
    up: `
    CREATE TABLE IF NOT EXISTS local_runtime_task_spaces (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      color TEXT NOT NULL,
      objective TEXT NOT NULL DEFAULT '',
      context_json TEXT NOT NULL DEFAULT '[]',
      projects_json TEXT NOT NULL DEFAULT '[]',
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS local_runtime_task_space_sessions (
      session_id TEXT PRIMARY KEY NOT NULL,
      space_id TEXT NOT NULL REFERENCES local_runtime_task_spaces(id) ON DELETE CASCADE,
      created_at_ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_task_space_sessions_space
      ON local_runtime_task_space_sessions(space_id);
    CREATE TABLE IF NOT EXISTS local_runtime_bunny_memory_cursors (
      session_id TEXT PRIMARY KEY NOT NULL,
      through_row_id INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS bunny_settings (
      key TEXT PRIMARY KEY NOT NULL,
      value_json TEXT NOT NULL
    );
  `,
};
/**
 * Bunny 独立库 v2：派活任务与事件。会话在大库，所以不设指向会话的外键；事件对任务的外键
 * 同库，保留级联删除。
 */
const createAssignmentTasks = {
    version: 2,
    name: 'create_assignment_tasks',
    up: `
    CREATE TABLE IF NOT EXISTS local_runtime_assignment_tasks (
      task_id TEXT PRIMARY KEY NOT NULL,
      session_id TEXT NOT NULL,
      assigner_session_id TEXT NOT NULL,
      assigner_agent_name TEXT NOT NULL,
      assigner_was_root INTEGER,
      via TEXT NOT NULL,
      depth INTEGER NOT NULL,
      report_back INTEGER NOT NULL,
      assigned_at_ms INTEGER NOT NULL,
      goal TEXT,
      done_when_json TEXT,
      user_words TEXT,
      request_id TEXT,
      request_assigner_session_id TEXT,
      pending_start_content TEXT,
      pending_start_queued_at_ms INTEGER,
      completion_state TEXT,
      completion_by TEXT,
      completion_at_ms INTEGER,
      completion_summary TEXT,
      review_session_id TEXT,
      review_turn_id TEXT,
      review_report_key TEXT,
      review_summary TEXT,
      last_reported_key TEXT,
      revision INTEGER NOT NULL DEFAULT 0,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      CONSTRAINT assignment_tasks_identity CHECK (
        length(trim(task_id)) > 0 AND length(trim(session_id)) > 0
      ),
      CONSTRAINT assignment_tasks_depth CHECK (depth >= 1),
      CONSTRAINT assignment_tasks_flags CHECK (
        report_back IN (0, 1) AND (assigner_was_root IS NULL OR assigner_was_root IN (0, 1))
      ),
      CONSTRAINT assignment_tasks_done_when CHECK (
        done_when_json IS NULL OR (json_valid(done_when_json) AND json_type(done_when_json) = 'array')
      ),
      CONSTRAINT assignment_tasks_pending_start CHECK (
        (pending_start_content IS NULL) = (pending_start_queued_at_ms IS NULL)
      ),
      CONSTRAINT assignment_tasks_completion CHECK (
        (completion_state IS NULL AND completion_by IS NULL AND completion_at_ms IS NULL AND completion_summary IS NULL)
        OR (completion_state IS NOT NULL AND completion_by IS NOT NULL AND completion_at_ms IS NOT NULL)
      ),
      CONSTRAINT assignment_tasks_review CHECK (
        (review_session_id IS NULL AND review_turn_id IS NULL AND review_report_key IS NULL AND review_summary IS NULL)
        OR (review_session_id IS NOT NULL AND review_turn_id IS NOT NULL AND review_report_key IS NOT NULL AND review_summary IS NOT NULL)
      ),
      CONSTRAINT assignment_tasks_timestamps CHECK (
        revision >= 0 AND created_at_ms >= 0 AND updated_at_ms >= created_at_ms
      )
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_assignment_tasks_session
      ON local_runtime_assignment_tasks(session_id);
    CREATE INDEX IF NOT EXISTS idx_assignment_tasks_assigner_agent
      ON local_runtime_assignment_tasks(assigner_agent_name, assigned_at_ms);
    CREATE INDEX IF NOT EXISTS idx_assignment_tasks_assigner_session
      ON local_runtime_assignment_tasks(assigner_session_id);
    CREATE INDEX IF NOT EXISTS idx_assignment_tasks_review
      ON local_runtime_assignment_tasks(review_session_id) WHERE review_session_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_assignment_tasks_pending
      ON local_runtime_assignment_tasks(pending_start_queued_at_ms)
      WHERE pending_start_queued_at_ms IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_assignment_tasks_request
      ON local_runtime_assignment_tasks(request_assigner_session_id, request_id)
      WHERE request_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS local_runtime_assignment_task_events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL REFERENCES local_runtime_assignment_tasks(task_id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      dedupe_key TEXT,
      created_at_ms INTEGER NOT NULL,
      CONSTRAINT assignment_task_events_identity CHECK (
        length(trim(task_id)) > 0 AND length(trim(type)) > 0
        AND (dedupe_key IS NULL OR length(trim(dedupe_key)) > 0)
      ),
      CONSTRAINT assignment_task_events_payload CHECK (
        json_valid(payload_json) AND json_type(payload_json) = 'object'
      ),
      CONSTRAINT assignment_task_events_timestamp CHECK (created_at_ms >= 0)
    );
    CREATE INDEX IF NOT EXISTS idx_assignment_task_events_task
      ON local_runtime_assignment_task_events(task_id, seq);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_assignment_task_events_dedupe
      ON local_runtime_assignment_task_events(dedupe_key)
      WHERE dedupe_key IS NOT NULL;
  `,
};
/**
 * Bunny 独立库 v3：工作状态台账（近期约定）及其变更事件。条目只在 Bunny 初始化时删除；
 * 事件的最大 `seq` 是台账版本，`operation_id` 让重放的整理写入成为空操作。
 */
const createWorkingState = {
    version: 3,
    name: 'create_working_state',
    up: `
    CREATE TABLE IF NOT EXISTS local_runtime_working_state_entries (
      id TEXT PRIMARY KEY NOT NULL,
      kind TEXT NOT NULL,
      scope TEXT NOT NULL,
      text TEXT NOT NULL,
      replaces TEXT,
      expires_at_ms INTEGER,
      supersedes TEXT,
      status TEXT NOT NULL,
      close_reason TEXT,
      source_session_id TEXT,
      source_message_id TEXT,
      source_at_ms INTEGER,
      author TEXT NOT NULL,
      inferred INTEGER NOT NULL DEFAULT 0,
      updated_by TEXT NOT NULL,
      handoff_at_ms INTEGER,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      closed_at_ms INTEGER,
      CONSTRAINT working_state_entries_kind
        CHECK (kind IN ('correction', 'constraint', 'open_question', 'context_gap')),
      CONSTRAINT working_state_entries_scope
        CHECK (scope = 'global' OR (kind = 'context_gap' AND scope LIKE 'space:_%')),
      CONSTRAINT working_state_entries_status CHECK (status IN ('active', 'superseded', 'done')),
      CONSTRAINT working_state_entries_close_reason
        CHECK (close_reason IS NULL OR close_reason IN ('done', 'answered', 'withdrawn', 'expired')),
      CONSTRAINT working_state_entries_author CHECK (author IN ('front', 'compactor', 'user')),
      CONSTRAINT working_state_entries_updated_by
        CHECK (updated_by IN ('front', 'compactor', 'user', 'system'))
    );
    CREATE INDEX IF NOT EXISTS idx_working_state_entries_status_updated
      ON local_runtime_working_state_entries(status, updated_at_ms);
    CREATE INDEX IF NOT EXISTS idx_working_state_entries_source
      ON local_runtime_working_state_entries(source_message_id, kind);
    CREATE TABLE IF NOT EXISTS local_runtime_working_state_events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      entry_id TEXT NOT NULL,
      action TEXT NOT NULL,
      actor TEXT NOT NULL,
      operation_id TEXT,
      created_at_ms INTEGER NOT NULL,
      CONSTRAINT working_state_events_action
        CHECK (action IN ('add', 'supersede', 'close', 'expire', 'confirm')),
      CONSTRAINT working_state_events_actor
        CHECK (actor IN ('front', 'compactor', 'user', 'system'))
    );
    CREATE INDEX IF NOT EXISTS idx_working_state_events_entry
      ON local_runtime_working_state_events(entry_id, seq);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_working_state_events_operation
      ON local_runtime_working_state_events(operation_id)
      WHERE operation_id IS NOT NULL;
  `,
};
/**
 * Bunny 独立库 v4：投递基线（spec 9.4）。每个主对话记录增量块上次投递的任务、台账条目、
 * 空间 context.md 和 UI 空间状态；保留键 `baseline` 表示该对话已有基线。
 */
const createDeliveryBaseline = {
    version: 4,
    name: 'create_delivery_baseline',
    up: `
    CREATE TABLE IF NOT EXISTS local_runtime_bunny_delivery_baseline (
      session_id TEXT NOT NULL,
      entry_key TEXT NOT NULL,
      delivered_state TEXT NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      PRIMARY KEY (session_id, entry_key)
    );
  `,
};
function hasColumn(database, table, column) {
    return (database.prepare(`SELECT 1 FROM pragma_table_info('${table}') WHERE name = ?`).all(column)
        .length > 0);
}
/**
 * Bunny 独立库 v5：收敛 v1、v2 被原地改写前后的两种表结构。
 *
 * v2 原地加了 `user_words`，v1 原地删了 `local_runtime_task_spaces.status`；早先建的库已记下
 * 1–4，不会再跑新 DDL，打开时缺 `user_words` 被当成损坏改名。这里补齐缺的列：
 * `user_words` 给当前代码用；`status` 当前代码不读不写，留给仍在用同一数据目录的旧版本，
 * 它们缺这一列也会把库改名重建。只补列，可以重复执行。已有版本不要再原地改，追加新版本。
 */
const convergeRewrittenColumns = {
    version: 5,
    name: 'converge_rewritten_columns',
    up: (database) => {
        if (!hasColumn(database, 'local_runtime_assignment_tasks', 'user_words')) {
            database.exec('ALTER TABLE local_runtime_assignment_tasks ADD COLUMN user_words TEXT');
        }
        if (!hasColumn(database, 'local_runtime_task_spaces', 'status')) {
            database.exec("ALTER TABLE local_runtime_task_spaces ADD COLUMN status TEXT NOT NULL DEFAULT 'active'");
        }
    },
};
/**
 * Bunny 独立库 v6：账本条目的关闭说明。`answered` 记用户的回答，`withdrawn` 记规则为什么不再
 * 适用，关闭的条目注入期间连同说明一起列出。只补列，可以重复执行。
 */
const addWorkingStateCloseNote = {
    version: 6,
    name: 'add_working_state_close_note',
    up: (database) => {
        if (!hasColumn(database, 'local_runtime_working_state_entries', 'close_note')) {
            database.exec('ALTER TABLE local_runtime_working_state_entries ADD COLUMN close_note TEXT');
        }
    },
};
/**
 * Bunny 独立库 v7：用户导入空间的文件。它们不属于任何会话，产物目录把它们和会话交付列在一起；
 * 空间被删除时清空 `space_id`。纯建表。
 */
const createArtifactLibrary = {
    version: 7,
    name: 'create_artifact_library',
    up: `
    CREATE TABLE IF NOT EXISTS local_runtime_artifact_library (
      id TEXT PRIMARY KEY NOT NULL,
      asset_key TEXT NOT NULL,
      name TEXT NOT NULL,
      path TEXT NOT NULL,
      category TEXT NOT NULL,
      workspace_dir TEXT NOT NULL,
      space_id TEXT,
      imported_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_artifact_library_space
      ON local_runtime_artifact_library(space_id);
  `,
};
/** Bunny 独立库 v8：分段压缩写下的附件描述（spec 12.6），每个附件一行。纯建表。 */
const createMediaDescriptions = {
    version: 8,
    name: 'create_bunny_media_descriptions',
    up: `
    CREATE TABLE IF NOT EXISTS local_runtime_bunny_media_descriptions (
      session_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      asset_id TEXT NOT NULL,
      description TEXT NOT NULL,
      seen INTEGER NOT NULL CHECK (seen IN (0, 1)),
      compaction_id TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      PRIMARY KEY (session_id, message_id, asset_id)
    );
  `,
};
/**
 * Bunny 独立库 v9：业务埋点的 outbox（默认决定 10）。每行一条待上报事件，渲染进程按 `seq`
 * 拉取、确认后删除。纯建表。
 */
const createTelemetryOutbox = {
    version: 9,
    name: 'create_bunny_telemetry_outbox',
    up: `
    CREATE TABLE IF NOT EXISTS local_runtime_bunny_telemetry_outbox (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      event TEXT NOT NULL,
      session_id TEXT NOT NULL,
      occurred_at_ms INTEGER NOT NULL,
      params_json TEXT NOT NULL,
      CONSTRAINT bunny_telemetry_outbox_params CHECK (
        json_valid(params_json) AND json_type(params_json) = 'object'
      )
    );
  `,
};
/**
 * Bunny 独立库 v10：业务埋点已取消，删掉 v9 的 outbox 表，以及只给埋点用的首次使用、
 * 每日快照两个标记。v9 保留在链上，已经跑过它的库由这一步收掉。
 */
const dropTelemetryOutbox = {
    version: 10,
    name: 'drop_bunny_telemetry_outbox',
    up: `
    DROP TABLE IF EXISTS local_runtime_bunny_telemetry_outbox;
    DELETE FROM bunny_settings
      WHERE key IN ('telemetryFirstUseReported', 'telemetryDailySnapshotDay');
  `,
};
/** v11：只持久化 Desktop 创建和关闭任务的业务埋点，不恢复已退役的事件。 */
const createTaskTelemetry = {
    version: 11,
    name: 'create_bunny_task_telemetry',
    up: `CREATE TABLE local_runtime_bunny_task_telemetry (
    event_id TEXT PRIMARY KEY NOT NULL,
    event TEXT NOT NULL,
    session_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    occurred_at_ms INTEGER NOT NULL,
    params_json TEXT NOT NULL
  );`,
};
/**
 * Bunny 独立库 v12：按核对轮次查已结束核对的索引。每轮收尾只数「本轮核对过几个任务」，
 * 过去要把全库 `review.finished` 事件读进内存再筛；这一步让筛选落到索引上。
 */
const indexReviewFinishedTurn = {
    version: 12,
    name: 'index_review_finished_turn',
    up: `
    CREATE INDEX IF NOT EXISTS idx_assignment_task_events_review_turn
      ON local_runtime_assignment_task_events(json_extract(payload_json, '$.reviewTurnId'))
      WHERE type = 'review.finished';
  `,
};
/** Bunny 独立库的迁移链，版本从 1 开始，与大库版本号无关。 */
export const BUNNY_STORE_MIGRATIONS = [
    createBunnyStore,
    createAssignmentTasks,
    createWorkingState,
    createDeliveryBaseline,
    convergeRewrittenColumns,
    addWorkingStateCloseNote,
    createArtifactLibrary,
    createMediaDescriptions,
    createTelemetryOutbox,
    dropTelemetryOutbox,
    createTaskTelemetry,
    indexReviewFinishedTurn,
];
//# sourceMappingURL=bunny-store-migrations.js.map