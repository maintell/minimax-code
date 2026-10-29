/**
 * Typed readers for SQLite schema metadata rows (`PRAGMA table_info`,
 * `sqlite_master`): each throws when a row is not the shape the schema
 * consistency check expects.
 */
export function readName(value) {
    if (typeof value !== 'object' || value === null || !('name' in value)) {
        throw new Error('Database schema metadata row is invalid');
    }
    const name = value.name;
    if (typeof name !== 'string')
        throw new Error('Database schema metadata name is invalid');
    return name;
}
export function readSql(value) {
    if (typeof value !== 'object' || value === null || !('sql' in value)) {
        throw new Error('Database schema metadata row is invalid');
    }
    const sql = value.sql;
    if (typeof sql !== 'string')
        throw new Error('Database schema metadata sql is invalid');
    return sql;
}
export function readString(value, key) {
    if (typeof value !== 'object' || value === null || !(key in value)) {
        throw new Error('Database schema metadata row is invalid');
    }
    const result = value[key];
    if (typeof result !== 'string')
        throw new Error(`Database schema metadata ${key} is invalid`);
    return result;
}
export function readNumber(value, key) {
    if (typeof value !== 'object' || value === null || !(key in value)) {
        throw new Error('Database schema metadata row is invalid');
    }
    const result = value[key];
    if (typeof result !== 'number')
        throw new Error(`Database schema metadata ${key} is invalid`);
    return result;
}
export function readNullableString(value, key) {
    if (typeof value !== 'object' || value === null || !(key in value)) {
        throw new Error('Database schema metadata row is invalid');
    }
    const result = value[key];
    if (result !== null && typeof result !== 'string') {
        throw new Error(`Database schema metadata ${key} is invalid`);
    }
    return result;
}
//# sourceMappingURL=schema-consistency.metadata-rows.js.map