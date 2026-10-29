import { EXPECTED_TABLES, SESSION_QUERY_INDEX_NAMES, AGENT_COLUMN_DEFINITIONS, MEMORY_TABLE_NAMES, MEMORY_COLUMN_DEFINITIONS, MEMORY_CHECKS, } from './schema-consistency.contracts.js';
import { readName, readNullableString, readNumber, readSql, readString, } from './schema-consistency.metadata-rows.js';
import { canonicalizeSqlContract as compactSql, canonicalizeSqlDefault, canonicalizeSqlDefinition as normalizeDefinition, canonicalizeSqlExpression, extractSqlCheckContracts, } from './sql-contract.js';
import { SESSION_STORAGE_RAW_OBJECTS, SESSION_STORAGE_SCHEMA, SESSION_STORAGE_TABLE_METADATA, SESSION_STORAGE_TRANSITIONAL_TABLE_METADATA, SESSION_STORAGE_TRIGGER_METADATA, SESSION_STORAGE_VIRTUAL_TABLE_METADATA, } from './schema/session-storage.js';
import { MINIAPP_STATE_TABLE_METADATA } from './schema/miniapp.js';
import { SESSION_CLIO_INDEX_NAMES, SESSION_CLIO_TABLE_NAMES } from './schema/session-clio.js';
import { LEGACY_HISTORY_NOTICE_REPAIR_CUTOFF_TABLE } from './legacy-history-notice-cutoff.js';
/** Production consumer of the centralized Drizzle contract; migration DDL remains self-contained. */
const SESSION_TABLE_CONFIGS = SESSION_STORAGE_TABLE_METADATA.required;
const OPTIONAL_DIAGNOSTIC_TABLE_CONFIGS = SESSION_STORAGE_TABLE_METADATA.optionalDiagnostic;
const CONDITIONAL_LEGACY_TABLE_CONFIGS = SESSION_STORAGE_TABLE_METADATA.conditionalLegacyInput;
const QUEUE_CONVERGENCE_INDEX_NAMES = new Set([
    'idx_local_runtime_queue_items_session_status_expiry_id',
    'local_runtime_queue_migration_quarantine_source',
]);
const QUEUE_CONVERGENCE_TABLE_NAMES = new Set(['local_runtime_queue_migration_quarantine']);
const FILE_API_TABLE_NAMES = new Set(['local_runtime_file_api_uploads']);
const FILE_API_INDEX_NAMES = new Set(['idx_local_runtime_file_api_uploads_session_expiry']);
const QUERY_COLLAPSE_TABLE_NAMES = new Set(['local_runtime_query_view_states']);
const TASK_SESSION_BINDING_TABLE_NAMES = new Set(['local_runtime_task_session_bindings']);
const QUEUE_PAUSE_TABLE_NAMES = new Set(['local_runtime_queue_pauses']);
const SESSION_AGENT_DEFINITION_TABLE_NAMES = new Set(['local_runtime_session_agent_definitions']);
const QUERY_COLLAPSE_BASE_INDEX_NAMES = new Set(['idx_local_runtime_query_view_states_session']);
const QUERY_COLLAPSE_CURRENT_TURN_INDEX_NAMES = new Set([
    'idx_local_runtime_query_view_states_current_turn',
]);
const SOURCE_RESOURCE_TABLE_NAMES = new Set(['session_resources', 'session_turn_resources']);
const SOURCE_RESOURCE_INDEX_NAMES = new Set([
    'idx_session_resources_source_id',
    'idx_session_resources_identity',
    'idx_session_turn_resources_tool_call',
    'idx_session_turn_resources_turn',
    'idx_session_turn_resources_resource',
]);
const AGENT_INDEX_NAMES = new Set(['idx_agents_source_project', 'idx_agents_process_state']);
const LEGACY_HISTORY_NOTICE_AGENT_COLUMNS = new Set(['legacy_history_session_id']);
const LEGACY_HISTORY_NOTICE_REPAIR_CUTOFF_COLUMNS = [
    { name: 'singleton', type: 'INTEGER', notNull: 0, defaultValue: null, primaryKeyOrdinal: 1 },
    { name: 'cutoff_at_ms', type: 'INTEGER', notNull: 1, defaultValue: null, primaryKeyOrdinal: 0 },
];
const SURFACED_CHANNEL_PROJECT_INDEX_WHERES = new Map([
    [
        'idx_local_runtime_sessions_project_activity_v4',
        canonicalizeSqlExpression("columnar_version = 3 AND archived = 0 AND visibility <> 'hidden' AND session_kind NOT IN ('peek', 'cron')"),
    ],
    [
        'idx_local_runtime_sessions_project_root_recency_v4',
        canonicalizeSqlExpression("columnar_version = 3 AND parent_session_id IS NULL AND visibility <> 'hidden' AND session_kind NOT IN ('peek', 'cron')"),
    ],
    [
        'idx_local_runtime_sessions_project_agent_root_recency_v4',
        canonicalizeSqlExpression("columnar_version = 3 AND parent_session_id IS NULL AND visibility <> 'hidden' AND session_kind NOT IN ('peek', 'cron')"),
    ],
]);
const CHANNEL_PROJECT_INDEX_NAMES = new Set([
    'idx_local_runtime_sessions_project_activity_v6',
    'idx_local_runtime_sessions_project_root_recency_v6',
    'idx_local_runtime_sessions_project_agent_root_recency_v6',
]);
const CRON_EXECUTION_FIELD_COLUMNS = new Set(['manual_request_id']);
const CRON_SESSION_TARGET_MODE_COLUMNS = new Set(['session_target_mode']);
const CRON_EXECUTION_FIELD_INDEX_NAMES = new Set(['idx_v2_cron_runs_manual_request']);
const MEMORY_EXECUTION_INDEX_NAMES = new Set([
    'idx_memory_execution_tasks_started',
    'idx_memory_execution_tasks_source',
    'idx_memory_execution_calls_ordinal',
]);
const MEMORY_INDEX_NAMES = new Set(['idx_local_runtime_v2_memory_session_states_selection']);
const SESSION_QUERY_QUEUE_COLUMNS = new Set([
    'source',
    'client_request_id',
    'dedupe_key',
    'expires_at_ms',
    'claim_id',
    'claim_lease_expires_at_ms',
    'routing_fingerprint',
]);
const SESSION_HISTORY_LOCATION_COLUMNS = new Set(['history_relative_dir']);
const REQUIRED_INDEXES = [
    'idx_v2_cron_definitions_scheduler',
    'idx_v2_cron_definitions_active_name',
    'idx_v2_cron_definitions_page',
    'idx_v2_cron_runs_scheduler_trigger',
    'idx_v2_cron_runs_manual_request',
    'idx_v2_cron_runs_page',
    'idx_agents_source_project',
    'idx_agents_process_state',
    ...MEMORY_INDEX_NAMES,
    ...MEMORY_EXECUTION_INDEX_NAMES,
    ...SESSION_TABLE_CONFIGS.flatMap((table) => table.indexes),
];
const REQUIRED_OBJECTS = [
    ...SESSION_STORAGE_RAW_OBJECTS.virtualTables.map((name) => ({
        type: 'table',
        name,
        sqlPattern: /\bUSING\s+fts5\b/iu,
    })),
    ...SESSION_STORAGE_RAW_OBJECTS.triggers.map((name) => ({
        type: 'trigger',
        name,
    })),
];
const REMOVED_TABLES = [
    'local_runtime_scheduler_jobs',
    'local_runtime_plugin_schema_migrations',
    'local_runtime_v2_scheduler_registrations',
    'local_runtime_v2_scheduler_occurrences',
    'local_runtime_v2_cron_session_deliveries',
    'local_runtime_v2_memory_publications',
    'local_runtime_v2_memory_usage_events',
    'local_runtime_v2_memory_view_states',
    'local_runtime_v2_memory_forget_markers',
];
export function assertDatabaseSchemaConsistent(db) {
    assertSessionMetadataComplete();
    assertRemovedTablesAbsent(db);
    assertRequiredTableColumns(db);
    assertSessionTables(db);
    assertOptionalTables(db, OPTIONAL_DIAGNOSTIC_TABLE_CONFIGS);
    assertOptionalTables(db, CONDITIONAL_LEGACY_TABLE_CONFIGS);
    assertSessionPhysicalTables(db);
    assertSessionChecks(db);
    assertRequiredIndexes(db);
    assertSessionIndexDefinitions(db);
    assertAgentPhysicalTable(db);
    assertAgentIndexDefinitions(db);
    assertLegacyHistoryNoticeRepairCutoff(db);
    assertMemorySchema(db);
    assertMiniAppStateTable(db);
    assertRequiredObjects(db);
    assertTriggerDefinitions(db);
    assertVirtualTableDefinitions(db);
}
function assertSessionMetadataComplete() {
    const ownerCount = SESSION_TABLE_CONFIGS.length + OPTIONAL_DIAGNOSTIC_TABLE_CONFIGS.length;
    const classifiedCount = Object.values(SESSION_STORAGE_SCHEMA).reduce((count, tables) => count + tables.length, 0);
    const inventoryCount = classifiedCount +
        SESSION_STORAGE_RAW_OBJECTS.externalTables.length +
        SESSION_STORAGE_VIRTUAL_TABLE_METADATA.length;
    const complete = ownerCount === 34 &&
        CONDITIONAL_LEGACY_TABLE_CONFIGS.length === 2 &&
        SESSION_STORAGE_RAW_OBJECTS.externalTables.length === 5 &&
        SESSION_STORAGE_VIRTUAL_TABLE_METADATA.length === 1 &&
        inventoryCount === 42;
    if (!complete)
        throw new Error('Session storage schema metadata is incomplete');
}
function assertRemovedTablesAbsent(db) {
    for (const removedTable of REMOVED_TABLES) {
        const found = db
            .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
            .get(removedTable);
        if (found)
            throw new Error(`Database schema contains removed table: ${removedTable}`);
    }
}
function assertRequiredTableColumns(db) {
    for (const [table, expected] of Object.entries(EXPECTED_TABLES)) {
        if (shouldSkipRequiredTableCheck(db, table))
            continue;
        const actual = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(readName));
        const expectedColumns = expectedTableColumnsForDatabase(db, table, expected);
        const missingColumns = expectedColumns.filter((column) => !actual.has(column));
        if (actual.size === 0 || missingColumns.length > 0) {
            throw new Error(`Database schema columns missing: ${table}.${missingColumns.join(`,${table}.`)}`);
        }
    }
}
/** Goal tables, each checked only once the migration that creates it has run. */
const GOAL_TABLE_MIGRATIONS = new Map([
    ['local_runtime_v2_goals', 46],
    ['local_runtime_v2_goal_requests', 47],
    ['local_runtime_v2_goal_token_charges', 48],
]);
/** Tables checked only once the migration that creates them has run. */
const TABLE_MIGRATIONS = new Map([
    ...GOAL_TABLE_MIGRATIONS,
    ['local_runtime_plugin_miniapp_permission', 50],
]);
function shouldSkipRequiredTableCheck(db, table) {
    const tableMigration = TABLE_MIGRATIONS.get(table);
    return ((table === 'agents' && !agentMigrationApplied(db)) ||
        (table === 'local_runtime_background_tasks' && !migrationApplied(db, 45)) ||
        (table.startsWith('local_runtime_v2_memory_') && !memoryMigrationApplied(db)) ||
        (table === MINIAPP_STATE_TABLE_METADATA.name && !miniAppStateContractApplied(db)) ||
        (tableMigration !== undefined && !migrationVersionApplied(db, tableMigration)));
}
function assertMiniAppStateTable(db) {
    if (!miniAppStateContractApplied(db))
        return;
    const table = MINIAPP_STATE_TABLE_METADATA;
    const rows = db.prepare(`PRAGMA table_info(${table.name})`).all();
    const actualByName = new Map(rows.map((row) => [readName(row), row]));
    for (const expected of table.columnDefinitions) {
        const actual = actualByName.get(expected.name);
        if (!actual ||
            readString(actual, 'type').toUpperCase() !== expected.type ||
            readNumber(actual, 'notnull') !== expected.notNull ||
            canonicalizeSqlDefault(readNullableString(actual, 'dflt_value')) !==
                canonicalizeSqlDefault(expected.defaultValue) ||
            readNumber(actual, 'pk') !== expected.primaryKeyOrdinal) {
            throw new Error(`Database schema column mismatch: ${table.name}.${expected.name}`);
        }
    }
    const row = db
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(table.name);
    const actualChecks = extractSqlCheckContracts(readSql(row));
    const expectedChecks = table.checks.map(compactSql).sort();
    if (JSON.stringify(actualChecks) !== JSON.stringify(expectedChecks)) {
        throw new Error(`Database schema constraints mismatch: ${table.name}`);
    }
}
function assertSessionTables(db) {
    for (const table of activeSessionTables(db)) {
        const actual = new Set(db.prepare(`PRAGMA table_info(${table.name})`).all().map(readName));
        const expectedColumns = currentTableColumns(db, table);
        const missingColumns = expectedColumns.filter((column) => !actual.has(column));
        if (actual.size === 0 || missingColumns.length > 0) {
            throw new Error(`Database schema columns missing: ${table.name}.${missingColumns.join(`,${table.name}.`)}`);
        }
    }
}
function assertOptionalTables(db, tables) {
    for (const table of tables) {
        const actual = db.prepare(`PRAGMA table_info(${table.name})`).all().map(readName);
        if (actual.length === 0)
            continue;
        const actualNames = new Set(actual);
        const missingColumns = table.columns.filter((column) => !actualNames.has(column));
        if (missingColumns.length > 0) {
            throw new Error(`Database schema columns missing: ${table.name}.${missingColumns.join(`,${table.name}.`)}`);
        }
    }
}
function assertSessionChecks(db) {
    for (const table of allPresentSessionTables(db)) {
        if (table.name === 'local_runtime_projects' && isTransitionalProjectTable(db))
            continue;
        const row = db
            .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
            .get(table.name);
        const actual = extractSqlCheckContracts(readSql(row));
        const expected = table.checks.map(compactSql).sort();
        if (JSON.stringify(actual) === JSON.stringify(expected))
            continue;
        const missing = expected.some((constraint) => !actual.includes(constraint));
        throw new Error(`Database schema constraints ${missing ? 'missing' : 'mismatch'}: ${table.name}`);
    }
}
function assertSessionPhysicalTables(db) {
    for (const table of activeSessionTables(db)) {
        if (table.name === 'local_runtime_projects' && isTransitionalProjectTable(db))
            continue;
        assertPhysicalTable(db, table);
    }
    for (const table of [...OPTIONAL_DIAGNOSTIC_TABLE_CONFIGS, ...CONDITIONAL_LEGACY_TABLE_CONFIGS]) {
        if (tableExists(db, table.name))
            assertPhysicalTable(db, table);
    }
}
function assertPhysicalTable(db, table) {
    const rows = db.prepare(`PRAGMA table_info(${table.name})`).all();
    const actualByName = new Map(rows.map((row) => [readName(row), row]));
    for (const expected of currentColumnDefinitions(db, table)) {
        const actual = actualByName.get(expected.name);
        if (!actual || !columnDefinitionMatches(actual, expected)) {
            throw new Error(`Database schema column mismatch: ${table.name}.${expected.name}`);
        }
    }
    assertAutoIncrement(db, table);
    assertForeignKeys(db, table);
}
function columnDefinitionMatches(row, expected) {
    return (readString(row, 'type').toUpperCase() === expected.type &&
        readNumber(row, 'notnull') === Number(expected.notNull) &&
        canonicalizeSqlDefault(readNullableString(row, 'dflt_value')) ===
            canonicalizeSqlDefault(expected.defaultValue) &&
        readNumber(row, 'pk') === expected.primaryKeyOrdinal);
}
function assertAutoIncrement(db, table) {
    const row = db
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(table.name);
    const sql = compactSql(readSql(row));
    const expected = table.columnDefinitions.find((column) => column.autoIncrement);
    if (expected && !sql.includes(compactSql(`${expected.name} INTEGER PRIMARY KEY AUTOINCREMENT`))) {
        throw new Error(`Database schema column mismatch: ${table.name}.${expected.name}`);
    }
    if (!expected && sql.includes(compactSql('AUTOINCREMENT'))) {
        throw new Error(`Database schema column mismatch: ${table.name}`);
    }
}
function assertForeignKeys(db, table) {
    const actual = db
        .prepare(`PRAGMA foreign_key_list(${table.name})`)
        .all()
        .map((row) => ({
        from: readString(row, 'from'),
        table: readString(row, 'table'),
        to: readString(row, 'to'),
        onDelete: readString(row, 'on_delete').toLowerCase(),
        onUpdate: readString(row, 'on_update').toLowerCase(),
    }))
        .sort(compareForeignKeys);
    const expected = [...table.foreignKeys].sort(compareForeignKeys);
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`Database schema foreign keys mismatch: ${table.name}`);
    }
}
function isTransitionalProjectTable(db) {
    const transitional = SESSION_STORAGE_TRANSITIONAL_TABLE_METADATA[0];
    const rows = db.prepare(`PRAGMA table_info(${transitional.name})`).all();
    if (rows.map(readName).join(',') !== transitional.columns.join(','))
        return false;
    try {
        assertPhysicalTable(db, transitional);
        const row = db
            .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
            .get(transitional.name);
        return extractSqlCheckContracts(readSql(row)).length === 0;
    }
    catch {
        return false;
    }
}
function compareForeignKeys(left, right) {
    return `${left.from}:${left.table}:${left.to}`.localeCompare(`${right.from}:${right.table}:${right.to}`);
}
function assertRequiredIndexes(db) {
    const indexes = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map(readName));
    const migrationGates = indexMigrationGates(db);
    const conditionalIndexes = CONDITIONAL_LEGACY_TABLE_CONFIGS.filter((table) => tableExists(db, table.name)).flatMap((table) => table.indexes);
    const required = [...REQUIRED_INDEXES, ...conditionalIndexes].filter((name) => (!AGENT_INDEX_NAMES.has(name) || agentMigrationApplied(db)) &&
        isIndexExpected(name, migrationGates));
    const missing = required.filter((index) => !indexes.has(index));
    if (missing.length > 0)
        throw new Error(`Database schema indexes missing: ${missing.join(',')}`);
}
function assertSessionIndexDefinitions(db) {
    const migrationGates = indexMigrationGates(db);
    const expectedIndexes = [
        ...activeSessionTables(db),
        ...CONDITIONAL_LEGACY_TABLE_CONFIGS.filter((table) => tableExists(db, table.name)),
    ]
        .flatMap((table) => table.indexDefinitions)
        .filter(({ name }) => isIndexExpected(name, migrationGates))
        .map((definition) => intermediateChannelProjectSchemaApplied(db)
        ? surfacedChannelProjectIndexDefinition(definition)
        : definition);
    for (const expected of expectedIndexes) {
        if (expected.name === 'idx_session_turn_resources_tool_call' &&
            !sourceToolCallIndexRelaxed(db)) {
            continue;
        }
        const actual = readIndexDefinition(db, expected.name);
        if (JSON.stringify(actual) !== JSON.stringify(expected)) {
            throw new Error(`Database schema index mismatch: ${expected.name}`);
        }
    }
    for (const table of OPTIONAL_DIAGNOSTIC_TABLE_CONFIGS) {
        if (!tableExists(db, table.name))
            continue;
        for (const expected of table.indexDefinitions) {
            if (!hasCompatibleOptionalIndex(db, table.name, expected)) {
                throw new Error(`Database schema index mismatch: ${expected.name}`);
            }
        }
    }
}
function indexMigrationGates(db) {
    return [
        {
            applied: sessionSideChatsSchemaActive(db),
            names: new Set(['idx_local_runtime_session_sidechats_main_created']),
        },
        { applied: sharedProjectSchemaCompatibilityApplied(db), names: CHANNEL_PROJECT_INDEX_NAMES },
        { applied: queryIndexesApplied(db), names: SESSION_QUERY_INDEX_NAMES },
        { applied: queueConvergenceApplied(db), names: QUEUE_CONVERGENCE_INDEX_NAMES },
        { applied: fileApiCacheApplied(db), names: FILE_API_INDEX_NAMES },
        { applied: queryCollapseApplied(db), names: QUERY_COLLAPSE_BASE_INDEX_NAMES },
        { applied: queryCollapseApplied(db), names: QUERY_COLLAPSE_CURRENT_TURN_INDEX_NAMES },
        { applied: cronExecutionFieldsApplied(db), names: CRON_EXECUTION_FIELD_INDEX_NAMES },
        { applied: sourceResourcesApplied(db), names: SOURCE_RESOURCE_INDEX_NAMES },
        { applied: memoryMigrationApplied(db), names: MEMORY_INDEX_NAMES },
        { applied: memoryExecutionsApplied(db), names: MEMORY_EXECUTION_INDEX_NAMES },
        { applied: migrationApplied(db, 41), names: SESSION_CLIO_INDEX_NAMES },
    ];
}
function isIndexExpected(name, gates) {
    return gates.every((gate) => gate.applied || !gate.names.has(name));
}
function assertAgentIndexDefinitions(db) {
    if (!agentMigrationApplied(db))
        return;
    if (!tableExists(db, 'agents')) {
        throw new Error('Database schema mismatch: agents table missing after migration 14');
    }
    const expected = [
        ['idx_agents_source_project', ['source_project']],
        ['idx_agents_process_state', ['framework_type', 'process_alive']],
    ];
    for (const [name, columns] of expected) {
        const actual = readIndexDefinition(db, name);
        if (actual.table !== 'agents' ||
            actual.unique ||
            JSON.stringify(actual.columns) !== JSON.stringify(columns) ||
            actual.where !== null) {
            throw new Error(`Database schema index mismatch: ${name}`);
        }
    }
}
function assertAgentPhysicalTable(db) {
    if (!agentMigrationApplied(db))
        return;
    const rows = db.prepare('PRAGMA table_info(agents)').all();
    if (rows.length === 0)
        return;
    const actualByName = new Map(rows.map((row) => [readName(row), row]));
    for (const expected of agentColumnDefinitionsForDatabase(db)) {
        const actual = actualByName.get(expected.name);
        if (!actual ||
            readString(actual, 'type').toUpperCase() !== expected.type ||
            readNumber(actual, 'notnull') !== expected.notNull ||
            canonicalizeSqlDefault(readNullableString(actual, 'dflt_value')) !==
                canonicalizeSqlDefault(expected.defaultValue) ||
            readNumber(actual, 'pk') !== expected.primaryKeyOrdinal) {
            throw new Error(`Database schema column mismatch: agents.${expected.name}`);
        }
    }
}
function assertLegacyHistoryNoticeRepairCutoff(db) {
    if (!tableExists(db, LEGACY_HISTORY_NOTICE_REPAIR_CUTOFF_TABLE))
        return;
    assertLegacyHistoryNoticeRepairMarker(db);
    assertLegacyHistoryNoticeRepairColumns(db);
    assertLegacyHistoryNoticeRepairMetadata(db);
}
function assertLegacyHistoryNoticeRepairMarker(db) {
    if (legacyHistoryNoticeRepairApplied(db))
        return;
    throw new Error(`Database schema mismatch: ${LEGACY_HISTORY_NOTICE_REPAIR_CUTOFF_TABLE} before migration 32`);
}
function assertLegacyHistoryNoticeRepairColumns(db) {
    const actualByName = new Map(db
        .prepare(`PRAGMA table_info(${LEGACY_HISTORY_NOTICE_REPAIR_CUTOFF_TABLE})`)
        .all()
        .map((row) => [readName(row), row]));
    const mismatch = LEGACY_HISTORY_NOTICE_REPAIR_CUTOFF_COLUMNS.find((column) => !legacyHistoryNoticeRepairColumnMatches(actualByName.get(column.name), column));
    if (mismatch) {
        throw new Error(`Database schema column mismatch: ${LEGACY_HISTORY_NOTICE_REPAIR_CUTOFF_TABLE}.${mismatch.name}`);
    }
}
function legacyHistoryNoticeRepairColumnMatches(actual, expected) {
    return (actual !== undefined &&
        readString(actual, 'type').toUpperCase() === expected.type &&
        readNumber(actual, 'notnull') === expected.notNull &&
        canonicalizeSqlDefault(readNullableString(actual, 'dflt_value')) ===
            canonicalizeSqlDefault(expected.defaultValue) &&
        readNumber(actual, 'pk') === expected.primaryKeyOrdinal);
}
function assertLegacyHistoryNoticeRepairMetadata(db) {
    const rows = db
        .prepare(`SELECT singleton, cutoff_at_ms FROM ${LEGACY_HISTORY_NOTICE_REPAIR_CUTOFF_TABLE}`)
        .all();
    if (rows.length !== 1 ||
        readNumber(rows[0], 'singleton') !== 1 ||
        !Number.isSafeInteger(readNumber(rows[0], 'cutoff_at_ms'))) {
        throw new Error(`Database schema metadata mismatch: ${LEGACY_HISTORY_NOTICE_REPAIR_CUTOFF_TABLE}`);
    }
}
function expectedAgentColumnsForDatabase(db, table, expectedColumns) {
    if (table !== 'agents' || legacyHistoryNoticeMigrationApplied(db))
        return expectedColumns;
    return expectedColumns.filter((column) => !LEGACY_HISTORY_NOTICE_AGENT_COLUMNS.has(column));
}
function agentColumnDefinitionsForDatabase(db) {
    if (legacyHistoryNoticeMigrationApplied(db))
        return AGENT_COLUMN_DEFINITIONS;
    return AGENT_COLUMN_DEFINITIONS.filter((column) => !LEGACY_HISTORY_NOTICE_AGENT_COLUMNS.has(column.name));
}
function assertMemorySchema(db) {
    if (!memoryMigrationApplied(db))
        return;
    const tableNames = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'local_runtime_v2_memory_%' ORDER BY name")
        .all()
        .map(readName);
    const missingTables = memoryTableNames(db).filter((name) => !tableNames.includes(name));
    if (missingTables.length > 0) {
        throw new Error(`Database Memory schema tables missing: ${missingTables.join(',')}`);
    }
    for (const tableName of memoryTableNames(db)) {
        assertMemoryColumns(db, tableName);
        const row = db
            .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
            .get(tableName);
        const actualChecks = extractSqlCheckContracts(readSql(row));
        const expectedChecks = [...MEMORY_CHECKS[tableName]].map(compactSql).sort();
        if (JSON.stringify(actualChecks) !== JSON.stringify(expectedChecks)) {
            throw new Error(`Database schema constraints mismatch: ${tableName}`);
        }
    }
    assertMemoryForeignKeys(db);
    assertMemoryIndexes(db);
}
function assertMemoryColumns(db, tableName) {
    const rows = db.prepare(`PRAGMA table_info(${tableName})`).all();
    const expected = MEMORY_COLUMN_DEFINITIONS[tableName];
    if (rows.length !== expected.length) {
        throw new Error(`Database schema column mismatch: ${tableName}`);
    }
    for (const [index, [name, type, notNull, defaultValue, primaryKeyOrdinal],] of expected.entries()) {
        const row = rows[index];
        if (readName(row) !== name ||
            readString(row, 'type').toUpperCase() !== type ||
            readNumber(row, 'notnull') !== notNull ||
            canonicalizeSqlDefault(readNullableString(row, 'dflt_value')) !==
                canonicalizeSqlDefault(defaultValue) ||
            readNumber(row, 'pk') !== primaryKeyOrdinal) {
            throw new Error(`Database schema column mismatch: ${tableName}.${name}`);
        }
    }
}
function assertMemoryForeignKeys(db) {
    const expected = {
        local_runtime_v2_memory_execution_tasks: [],
        local_runtime_v2_memory_execution_calls: [
            ['task_id', 'local_runtime_v2_memory_execution_tasks', 'task_id', 'no action'],
        ],
        local_runtime_v2_memory_baseline_files: [
            ['scope_key', 'local_runtime_v2_memory_scopes', 'scope_key', 'cascade'],
        ],
        local_runtime_v2_memory_capture_attempts: [
            ['scope_key', 'local_runtime_v2_memory_scopes', 'scope_key', 'cascade'],
        ],
        local_runtime_v2_memory_scopes: [],
        local_runtime_v2_memory_session_states: [
            ['scope_key', 'local_runtime_v2_memory_scopes', 'scope_key', 'cascade'],
        ],
    };
    for (const tableName of memoryTableNames(db)) {
        const actual = db
            .prepare(`PRAGMA foreign_key_list(${tableName})`)
            .all()
            .map((row) => [
            readString(row, 'from'),
            readString(row, 'table'),
            readString(row, 'to'),
            readString(row, 'on_delete').toLowerCase(),
        ])
            .sort(compareStringTuples);
        if (JSON.stringify(actual) !== JSON.stringify([...expected[tableName]].sort(compareStringTuples))) {
            throw new Error(`Database schema foreign keys mismatch: ${tableName}`);
        }
    }
}
function assertMemoryIndexes(db) {
    const expected = [
        ...(memoryExecutionsApplied(db)
            ? [
                {
                    name: 'idx_memory_execution_tasks_started',
                    table: 'local_runtime_v2_memory_execution_tasks',
                    unique: false,
                    columns: ['started_at_ms', 'task_id'],
                },
                {
                    name: 'idx_memory_execution_tasks_source',
                    table: 'local_runtime_v2_memory_execution_tasks',
                    unique: false,
                    columns: ['stage', 'source_ref', 'started_at_ms'],
                },
                {
                    name: 'idx_memory_execution_calls_ordinal',
                    table: 'local_runtime_v2_memory_execution_calls',
                    unique: true,
                    columns: ['task_id', 'ordinal'],
                },
            ]
            : []),
        {
            name: 'idx_local_runtime_v2_memory_session_states_selection',
            table: 'local_runtime_v2_memory_session_states',
            unique: false,
            columns: [
                'scope_key',
                'exclusion_reason',
                'last_used_at_ms desc',
                'captured_at_ms desc',
                'session_id',
            ],
        },
    ];
    for (const contract of expected) {
        const actual = readIndexDefinition(db, contract.name);
        if (actual.table !== contract.table ||
            actual.unique !== contract.unique ||
            JSON.stringify(actual.columns) !== JSON.stringify(contract.columns) ||
            actual.where !== null) {
            throw new Error(`Database schema index mismatch: ${contract.name}`);
        }
    }
}
function compareStringTuples(left, right) {
    return left.join(':').localeCompare(right.join(':'));
}
function hasCompatibleOptionalIndex(db, table, expected) {
    const named = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?")
        .get(expected.name);
    if (named)
        return JSON.stringify(readIndexDefinition(db, expected.name)) === JSON.stringify(expected);
    return db
        .prepare(`PRAGMA index_list(${table})`)
        .all()
        .filter((row) => readNumber(row, 'unique') === Number(expected.unique) &&
        readNumber(row, 'partial') === Number(expected.where !== null))
        .some((row) => {
        const index = readIndexColumns(db, readName(row));
        return (JSON.stringify(index.columns) === JSON.stringify(expected.columns) &&
            JSON.stringify(index.collations) === JSON.stringify(expected.collations) &&
            expected.where === null);
    });
}
function assertRequiredObjects(db) {
    const missingObjects = REQUIRED_OBJECTS.flatMap((required) => {
        const row = db
            .prepare('SELECT type, sql FROM sqlite_master WHERE type = ? AND name = ?')
            .get(required.type, required.name);
        if (!row)
            return [required.name];
        if (required.sqlPattern && !required.sqlPattern.test(readSql(row)))
            return [required.name];
        return [];
    });
    if (missingObjects.length > 0) {
        throw new Error(`Database schema objects missing: ${missingObjects.join(',')}`);
    }
}
function assertTriggerDefinitions(db) {
    if (!projectV5TriggerCompatibilityRestored(db))
        return;
    const expectedTriggers = intermediateChannelProjectSchemaApplied(db)
        ? surfacedChannelProjectTriggerMetadata()
        : SESSION_STORAGE_TRIGGER_METADATA;
    for (const trigger of expectedTriggers) {
        const row = db
            .prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?")
            .get(trigger.name);
        if (normalizeDefinition(readSql(row)) !== normalizeDefinition(trigger.sql)) {
            throw new Error(`Database schema object mismatch: ${trigger.name}`);
        }
    }
}
function assertVirtualTableDefinitions(db) {
    for (const table of SESSION_STORAGE_VIRTUAL_TABLE_METADATA) {
        const columns = db.prepare(`PRAGMA table_info(${table.name})`).all().map(readName);
        const row = db
            .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
            .get(table.name);
        if (JSON.stringify(columns) !== JSON.stringify(table.columns) ||
            normalizeDefinition(readSql(row)) !== normalizeDefinition(table.sql)) {
            throw new Error(`Database schema object mismatch: ${table.name}`);
        }
    }
}
function allPresentSessionTables(db) {
    return [
        ...activeSessionTables(db),
        ...OPTIONAL_DIAGNOSTIC_TABLE_CONFIGS.filter((table) => tableExists(db, table.name)),
        ...CONDITIONAL_LEGACY_TABLE_CONFIGS.filter((table) => tableExists(db, table.name)),
    ];
}
function activeSessionTables(db) {
    return SESSION_TABLE_CONFIGS.filter((table) => baseSessionTableActive(db, table.name) && lateSessionTableActive(db, table.name));
}
function baseSessionTableActive(db, tableName) {
    return ((queueConvergenceApplied(db) || !QUEUE_CONVERGENCE_TABLE_NAMES.has(tableName)) &&
        (fileApiCacheApplied(db) || !FILE_API_TABLE_NAMES.has(tableName)) &&
        (queryCollapseApplied(db) || !QUERY_COLLAPSE_TABLE_NAMES.has(tableName)) &&
        (taskSessionBindingsApplied(db) || !TASK_SESSION_BINDING_TABLE_NAMES.has(tableName)));
}
function lateSessionTableActive(db, tableName) {
    if (tableName === 'local_runtime_session_sidechats')
        return sessionSideChatsSchemaActive(db);
    if (QUEUE_PAUSE_TABLE_NAMES.has(tableName))
        return queuePauseApplied(db);
    if (SOURCE_RESOURCE_TABLE_NAMES.has(tableName))
        return sourceResourcesApplied(db);
    if (SESSION_AGENT_DEFINITION_TABLE_NAMES.has(tableName))
        return sessionAgentDefinitionsApplied(db);
    if (SESSION_CLIO_TABLE_NAMES.has(tableName))
        return migrationApplied(db, 41);
    return true;
}
function sessionSideChatsSchemaActive(db) {
    return migrationApplied(db, 42) || tableExists(db, 'local_runtime_session_sidechats');
}
function tableExists(db, name) {
    return db.prepare(`PRAGMA table_info(${name})`).all().length > 0;
}
function readIndexDefinition(db, name) {
    const row = db
        .prepare("SELECT tbl_name, sql FROM sqlite_master WHERE type = 'index' AND name = ?")
        .get(name);
    const table = readString(row, 'tbl_name');
    const listRow = db
        .prepare(`PRAGMA index_list(${table})`)
        .all()
        .find((candidate) => readName(candidate) === name);
    if (!listRow)
        throw new Error(`Database schema index metadata missing: ${name}`);
    const index = readIndexColumns(db, name);
    const createSql = readSql(row);
    const where = /\bWHERE\b([\s\S]+)$/iu.exec(createSql)?.[1];
    return {
        name,
        table,
        unique: readNumber(listRow, 'unique') === 1,
        columns: index.columns,
        collations: index.collations,
        where: where ? canonicalizeSqlExpression(where, table) : null,
    };
}
function readIndexColumns(db, name) {
    const createRow = db
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?")
        .get(name);
    const declaredColumns = splitIndexColumns(readNullableString(createRow, 'sql') ?? '');
    const rows = db
        .prepare(`PRAGMA index_xinfo(${name})`)
        .all()
        .filter((column) => readNumber(column, 'key') === 1)
        .sort((left, right) => readNumber(left, 'seqno') - readNumber(right, 'seqno'));
    return {
        columns: rows.map((column, index) => {
            const declared = declaredColumns[index];
            const columnName = readNullableString(column, 'name');
            if (columnName === null && declared === undefined) {
                throw new Error(`Database schema expression index metadata missing: ${name}`);
            }
            return normalizeSql(`${columnName ?? declared}${readNumber(column, 'desc') === 1 ? ' desc' : ''}`);
        }),
        collations: rows.map((column) => readString(column, 'coll').toUpperCase()),
    };
}
function splitIndexColumns(createSql) {
    const onIndex = createSql.search(/\bON\b/iu);
    const start = createSql.indexOf('(', onIndex);
    if (onIndex < 0 || start < 0)
        return [];
    const columns = [];
    let depth = 0;
    let segmentStart = start + 1;
    for (let index = start + 1; index < createSql.length; index += 1) {
        const character = createSql[index];
        const step = indexColumnStep(character, depth);
        depth = step.depth;
        if (!step.boundary)
            continue;
        columns.push(createSql.slice(segmentStart, index).trim());
        if (step.complete)
            break;
        segmentStart = index + 1;
    }
    return columns;
}
function indexColumnStep(character, depth) {
    if (character === '(')
        return { depth: depth + 1, boundary: false, complete: false };
    if (character === ')' && depth > 0) {
        return { depth: depth - 1, boundary: false, complete: false };
    }
    if (depth === 0 && character === ',') {
        return { depth, boundary: true, complete: false };
    }
    if (depth === 0 && character === ')') {
        return { depth, boundary: true, complete: true };
    }
    return { depth, boundary: false, complete: false };
}
function currentTableColumns(db, table) {
    if (table.name === 'local_runtime_queue_items' && !queryIndexesApplied(db)) {
        return table.columns.filter((column) => !SESSION_QUERY_QUEUE_COLUMNS.has(column));
    }
    if (table.name === 'local_runtime_sessions' && !sessionHistoryLocationApplied(db)) {
        return table.columns.filter((column) => !SESSION_HISTORY_LOCATION_COLUMNS.has(column));
    }
    return table.columns;
}
function currentColumnDefinitions(db, table) {
    const compatibleDefinitions = table.name === 'local_runtime_sessions'
        ? table.columnDefinitions.filter((column) => !SESSION_HISTORY_LOCATION_COLUMNS.has(column.name))
        : table.columnDefinitions;
    if (table.name === 'local_runtime_queue_items' && !queryIndexesApplied(db)) {
        return compatibleDefinitions.filter((column) => !SESSION_QUERY_QUEUE_COLUMNS.has(column.name));
    }
    return compatibleDefinitions;
}
function queryIndexesApplied(db) {
    return migrationVersionApplied(db, 9);
}
function queueConvergenceApplied(db) {
    return migrationVersionApplied(db, 10);
}
function fileApiCacheApplied(db) {
    return migrationVersionApplied(db, 11);
}
function agentMigrationApplied(db) {
    return migrationVersionApplied(db, 14);
}
function queryCollapseApplied(db) {
    return migrationVersionApplied(db, 16);
}
function projectV5TriggerCompatibilityRestored(db) {
    return migrationVersionApplied(db, 18);
}
// Version 33 reapplies the published Channel schema; versions 34–35 restore its old contract.
function intermediateChannelProjectSchemaApplied(db) {
    if (sharedProjectSchemaCompatibilityApplied(db))
        return false;
    return Boolean(db.prepare('SELECT 1 FROM local_runtime_v2_schema_migrations WHERE version = ?').get(33));
}
function sharedProjectSchemaCompatibilityApplied(db) {
    return migration35ConvergenceApplied(db) || migrationApplied(db, 34);
}
function legacyHistoryNoticeMigrationApplied(db) {
    return (migration35ConvergenceApplied(db) || tableHasColumn(db, 'agents', 'legacy_history_session_id'));
}
function legacyHistoryNoticeRepairApplied(db) {
    return migration35ConvergenceApplied(db) || migrationApplied(db, 32);
}
function surfacedChannelProjectIndexDefinition(definition) {
    const surfacedWhere = SURFACED_CHANNEL_PROJECT_INDEX_WHERES.get(definition.name);
    if (surfacedWhere === undefined || definition.where === null) {
        return definition;
    }
    return {
        ...definition,
        where: surfacedWhere,
    };
}
function surfacedChannelProjectTriggerMetadata() {
    return SESSION_STORAGE_TRIGGER_METADATA.map((trigger) => ({
        ...trigger,
        sql: trigger.sql.replaceAll("NOT IN ('peek', 'channel', 'cron')", "NOT IN ('peek', 'cron')"),
    }));
}
function miniAppStateContractApplied(db) {
    return migration35ConvergenceApplied(db) || tableExists(db, MINIAPP_STATE_TABLE_METADATA.name);
}
function taskSessionBindingsApplied(db) {
    return (migration35ConvergenceApplied(db) || tableExists(db, 'local_runtime_task_session_bindings'));
}
function sessionHistoryLocationApplied(db) {
    return (migration35ConvergenceApplied(db) ||
        tableHasColumn(db, 'local_runtime_sessions', 'history_relative_dir'));
}
function queuePauseApplied(db) {
    return migration35ConvergenceApplied(db) || tableExists(db, 'local_runtime_queue_pauses');
}
function sourceResourcesApplied(db) {
    return (migration35ConvergenceApplied(db) ||
        (tableExists(db, 'session_resources') && tableExists(db, 'session_turn_resources')));
}
function sourceToolCallIndexRelaxed(db) {
    return migration35ConvergenceApplied(db) || migrationApplied(db, 26);
}
function sessionAgentDefinitionsApplied(db) {
    return (migration35ConvergenceApplied(db) || tableExists(db, 'local_runtime_session_agent_definitions'));
}
function cronExecutionFieldsApplied(db) {
    return (migration35ConvergenceApplied(db) ||
        tableHasColumn(db, 'local_runtime_v2_cron_runs', 'manual_request_id'));
}
function cronSessionTargetModeApplied(db) {
    return (migration35ConvergenceApplied(db) ||
        tableHasColumn(db, 'local_runtime_v2_cron_definitions', 'session_target_mode'));
}
function migration35ConvergenceApplied(db) {
    return migrationApplied(db, 35);
}
function migrationApplied(db, version) {
    return Boolean(db.prepare('SELECT 1 FROM local_runtime_v2_schema_migrations WHERE version = ?').get(version));
}
function tableHasColumn(db, tableName, columnName) {
    return (db.prepare(`SELECT name FROM pragma_table_info('${tableName}') WHERE name = ?`).all(columnName)
        .length > 0);
}
function normalizeSql(value) {
    return value.replaceAll('"', '').replace(/\s+/gu, ' ').trim().replace(/;$/u, '').toLowerCase();
}
function expectedTableColumnsForDatabase(db, table, expected) {
    let expectedColumns = expected;
    if (table === 'local_runtime_v2_cron_definitions' && !migration35ConvergenceApplied(db)) {
        expectedColumns = expectedColumns.filter((column) => column !== 'project' && column !== 'model');
    }
    if (table === 'local_runtime_v2_cron_runs' && !cronExecutionFieldsApplied(db)) {
        expectedColumns = expectedColumns.filter((column) => !CRON_EXECUTION_FIELD_COLUMNS.has(column));
    }
    if (table === 'local_runtime_v2_cron_definitions' && !cronSessionTargetModeApplied(db)) {
        expectedColumns = expectedColumns.filter((column) => !CRON_SESSION_TARGET_MODE_COLUMNS.has(column));
    }
    if (table === 'local_runtime_v2_goals') {
        const pending = pendingGoalColumns(db);
        expectedColumns = expectedColumns.filter((column) => !pending.has(column));
    }
    expectedColumns = expectedAgentColumnsForDatabase(db, table, expectedColumns);
    return expectedColumns;
}
/** Goal columns added by migration 48 (full-usage token accounting). */
const GOAL_TOKEN_USAGE_COLUMNS = new Set([
    'token_accounting_version',
    'input_tokens',
    'cache_write_tokens',
    'cache_read_tokens',
    'output_tokens',
]);
/** Goal columns whose migration (48 token usage, 51 cache write unreported) has not run yet. */
function pendingGoalColumns(db) {
    const pending = new Set();
    if (!migrationVersionApplied(db, 48))
        for (const column of GOAL_TOKEN_USAGE_COLUMNS)
            pending.add(column);
    if (!migrationVersionApplied(db, 51))
        pending.add('cache_write_unreported');
    return pending;
}
function migrationVersionApplied(db, version) {
    return Boolean(db.prepare('SELECT 1 FROM local_runtime_v2_schema_migrations WHERE version = ?').get(version));
}
function memoryMigrationApplied(db) {
    return migrationVersionApplied(db, 38);
}
function memoryExecutionsApplied(db) {
    return migrationVersionApplied(db, 40);
}
function memoryTableNames(db) {
    return MEMORY_TABLE_NAMES.filter((name) => memoryExecutionsApplied(db) || !name.includes('_execution_'));
}
//# sourceMappingURL=schema-consistency.js.map