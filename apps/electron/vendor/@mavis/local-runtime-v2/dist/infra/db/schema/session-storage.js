import { getTableConfig, SQLiteSyncDialect } from 'drizzle-orm/sqlite-core';
import { fileHistoryMigrations, legacyMigrations, legacyOwnerMigrations, legacyPiHistoryRowMigrations, legacyPiHistoryRows, } from './legacy-session.js';
import { legacyMessages, messageRowMigrations, messageRows, sessionAssetIndexState, sessionAssets, } from './messages.js';
import { preferences } from './preferences.js';
import { PROJECT_V5_TRIGGERS, PROJECT_V5_TRIGGERS_SQL, projectMigrations, projects, } from './projects.js';
import { legacyQueues, queueItems, queueMigrationQuarantine, queuePauses, queueRowMigrations, } from './queue.js';
import { SESSION_FTS_SQL, SESSION_FTS_TABLE, sessionAgentState, sessionAgentDefinitions, taskSessionBindings, sessionFtsKeys, sessionSchemaMigrations, sessions, } from './sessions.js';
import { sessionLocks, turnIngress, turnIngressClientRequests, turnIngressSequences, } from './turn.js';
import { tokenUsage } from './usage.js';
import { canonicalizeSqlExpression } from '../sql-contract.js';
import { fileApiUploads } from './file-api.js';
import { queryCollapseViewStates } from './query-collapse.js';
import { sessionResources, sessionTurnResources } from './session-resources.js';
import { sessionClioOutbox, sessionClioState } from './session-clio.js';
/**
 * 集中式 Session storage metadata。分类只描述当前读写职责，不形成第二套 migration registry。
 */
export const SESSION_STORAGE_SCHEMA = {
    active: [
        sessions,
        sessionFtsKeys,
        sessionAgentState,
        sessionAgentDefinitions,
        taskSessionBindings,
        projects,
        messageRows,
        sessionAssets,
        sessionAssetIndexState,
        queueItems,
        queuePauses,
        tokenUsage,
        sessionLocks,
        turnIngress,
        turnIngressSequences,
        turnIngressClientRequests,
        fileApiUploads,
        queryCollapseViewStates,
        sessionResources,
        sessionTurnResources,
        sessionClioState,
        sessionClioOutbox,
        preferences,
    ],
    migrationAudit: [fileHistoryMigrations, legacyMigrations, queueMigrationQuarantine],
    legacyRead: [
        legacyMessages,
        legacyQueues,
        sessionSchemaMigrations,
        messageRowMigrations,
        queueRowMigrations,
        projectMigrations,
    ],
    legacyDiagnostic: [legacyOwnerMigrations],
    conditionalLegacyInput: [legacyPiHistoryRows, legacyPiHistoryRowMigrations],
};
export const SESSION_STORAGE_RAW_OBJECTS = {
    virtualTables: [SESSION_FTS_TABLE],
    triggers: PROJECT_V5_TRIGGERS,
    externalTables: [
        'local_runtime_schema_migrations',
        'local_runtime_v2_data_layout_migrations',
        'local_runtime_ledger_watermarks',
        'local_runtime_session_projection_watermarks',
        'local_runtime_agents',
    ],
};
export const SESSION_STORAGE_VIRTUAL_TABLE_METADATA = [
    {
        name: SESSION_FTS_TABLE,
        sql: SESSION_FTS_SQL,
        columns: [
            'session_id',
            'session_id_terms',
            'agent_name_terms',
            'title_terms',
            'workspace_dir_terms',
            'purpose_terms',
            'status_terms',
            'session_type_terms',
        ],
        tokenizer: 'unicode61',
    },
];
export const SESSION_STORAGE_TRIGGER_METADATA = Array.from(PROJECT_V5_TRIGGERS_SQL.matchAll(/CREATE\s+TRIGGER\s+IF\s+NOT\s+EXISTS\s+([a-z0-9_]+)[\s\S]*?\bEND\s*;/giu), (match) => ({
    name: requireMatch(match, 1),
    sql: requireMatch(match, 0),
}));
const dialect = new SQLiteSyncDialect();
/** schema-consistency 等 production consumer 使用的稳定、无 Drizzle 依赖泄漏的 metadata。 */
export const SESSION_STORAGE_TABLE_METADATA = {
    required: [
        ...SESSION_STORAGE_SCHEMA.active,
        ...SESSION_STORAGE_SCHEMA.migrationAudit,
        ...SESSION_STORAGE_SCHEMA.legacyRead,
    ].map(tableMetadata),
    optionalDiagnostic: SESSION_STORAGE_SCHEMA.legacyDiagnostic.map(tableMetadata),
    conditionalLegacyInput: SESSION_STORAGE_SCHEMA.conditionalLegacyInput.map(tableMetadata),
};
const finalProjectMetadata = tableMetadata(projects);
export const SESSION_STORAGE_TRANSITIONAL_TABLE_METADATA = [
    {
        ...finalProjectMetadata,
        columns: [
            'project_id',
            'workspace_dir',
            'pinned',
            'hidden',
            'order_index',
            'recent_at_ms',
            'latest_activity_at_ms',
            'session_count',
            'extra_data_json',
            'created_at_ms',
            'updated_at_ms',
            'project_kind',
        ],
        columnDefinitions: [
            ...finalProjectMetadata.columnDefinitions.filter(({ name }) => name !== 'project_kind'),
            {
                ...requireColumn(finalProjectMetadata.columnDefinitions, 'project_kind'),
                notNull: false,
            },
        ],
        checks: [],
    },
];
function tableMetadata(table) {
    const config = getTableConfig(table);
    const compositePrimaryKey = config.primaryKeys[0]?.columns ?? [];
    return {
        name: config.name,
        columns: config.columns.map((column) => column.name),
        columnDefinitions: config.columns.map((column) => ({
            name: column.name,
            type: column.getSQLType().toUpperCase(),
            notNull: column.primary ? false : column.notNull,
            defaultValue: sqliteDefault(column.default),
            primaryKeyOrdinal: column.primary ? 1 : Math.max(0, compositePrimaryKey.indexOf(column) + 1),
            autoIncrement: 'autoIncrement' in column && column.autoIncrement === true,
        })),
        indexes: config.indexes.map((index) => index.config.name),
        indexDefinitions: config.indexes.map((index) => ({
            name: index.config.name,
            table: config.name,
            unique: index.config.unique,
            columns: index.config.columns.map((column) => normalizeIndexColumnSql(dialect.sqlToQuery(column.getSQL(), 'indexes').sql, config.name)),
            collations: index.config.columns.map(() => 'BINARY'),
            where: index.config.where
                ? canonicalizeSqlExpression(dialect.sqlToQuery(index.config.where, 'indexes').sql, config.name)
                : null,
        })),
        checks: config.checks.map((constraint) => normalizeConstraintSql(dialect.sqlToQuery(constraint.value, 'indexes').sql, config.name)),
        foreignKeys: config.foreignKeys.flatMap((foreignKey) => {
            const reference = foreignKey.reference();
            const foreignTable = getTableConfig(reference.foreignTable).name;
            return reference.columns.map((column, index) => ({
                from: column.name,
                table: foreignTable,
                to: requireColumn(reference.foreignColumns, index).name,
                onDelete: foreignKey.onDelete ?? 'no action',
                onUpdate: foreignKey.onUpdate ?? 'no action',
            }));
        }),
    };
}
function normalizeConstraintSql(value, table) {
    return value
        .replaceAll('"', '')
        .replace(new RegExp(`\\b${table}\\.`, 'giu'), '')
        .replace(/\s+/gu, ' ')
        .trim()
        .toLowerCase();
}
function normalizeIndexColumnSql(value, table) {
    return normalizeConstraintSql(value, table).replace(/\s+asc$/u, '');
}
function sqliteDefault(value) {
    if (value === undefined)
        return null;
    if (typeof value === 'number' || typeof value === 'bigint')
        return String(value);
    if (typeof value === 'string')
        return `'${value.replaceAll("'", "''")}'`;
    throw new Error('Unsupported Session storage SQLite default');
}
function requireMatch(match, index) {
    const value = match[index];
    if (value === undefined)
        throw new Error('Invalid centralized Project trigger metadata');
    return value;
}
function requireColumn(columns, key) {
    const value = typeof key === 'number'
        ? columns[key]
        : columns.find((column) => typeof column === 'object' &&
            column !== null &&
            'name' in column &&
            column.name === key);
    if (!value)
        throw new Error(`Session storage column metadata missing: ${key}`);
    return value;
}
//# sourceMappingURL=session-storage.js.map