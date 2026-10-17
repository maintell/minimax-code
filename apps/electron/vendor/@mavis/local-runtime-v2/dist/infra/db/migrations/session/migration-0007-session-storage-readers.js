export function readCount(database, sql) {
    const row = database.prepare(sql).all()[0];
    if (!row)
        throw new Error('SQLite count query returned no row');
    return readInteger(row, 'count', 'SQLite count query');
}
export function parseJsonObject(raw, field) {
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch (error) {
        throw new Error(`${field} is not valid JSON`, { cause: error });
    }
    if (!isPlainObject(parsed))
        throw new Error(`${field} must be an object`);
    return parsed;
}
export function readOptionalString(record, key, field) {
    const value = record[key];
    if (value === undefined || value === null)
        return undefined;
    if (typeof value !== 'string')
        throw new Error(`${field}.${key} must be a string`);
    return value;
}
export function readOptionalNullableString(record, key, field) {
    const value = record[key];
    if (value === undefined || value === null)
        return value;
    if (typeof value !== 'string')
        throw new Error(`${field}.${key} must be a string or null`);
    return value;
}
export function readOptionalBoolean(record, key, field) {
    const value = record[key];
    if (value === undefined || value === null)
        return undefined;
    if (typeof value !== 'boolean')
        throw new Error(`${field}.${key} must be a boolean`);
    return value;
}
export function readOptionalSafeInteger(record, key, field) {
    const value = record[key];
    if (value === undefined || value === null)
        return undefined;
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
        throw new Error(`${field}.${key} must be a safe integer`);
    }
    return value;
}
export function readOptionalObject(record, key, field) {
    const value = record[key];
    if (value === undefined || value === null)
        return undefined;
    if (!isPlainObject(value))
        throw new Error(`${field}.${key} must be an object`);
    return value;
}
export function readOptionalEnum(record, key, allowed, field) {
    const value = readOptionalString(record, key, field);
    if (value === undefined)
        return undefined;
    return requireEnum(value, allowed, `${field}.${key}`);
}
export function readLegacySessionType(record) {
    const value = readOptionalString(record, 'sessionType', 'record_json');
    if (value === undefined)
        return undefined;
    return requireCompatibleSessionType(value, 'record_json.sessionType');
}
export function requireCompatibleSessionType(value, field) {
    const compatible = requireEnum(value, ['root', 'branch', 'task'], field);
    return compatible === 'task' ? 'branch' : compatible;
}
export function requireEnum(value, allowed, field) {
    const result = allowed.find((candidate) => candidate === value);
    if (result === undefined)
        throw new Error(`${field} must be one of: ${allowed.join(', ')}`);
    return result;
}
export function requireNullableEnum(value, allowed, field) {
    return value === null ? null : requireEnum(value, allowed, field);
}
export function requireBit(value, field) {
    if (value !== 0 && value !== 1)
        throw new Error(`${field} must be 0 or 1`);
    return value;
}
export function readString(value, key, field) {
    const result = readField(value, key, field);
    if (typeof result !== 'string')
        throw new Error(`${field}.${key} must be a string`);
    return result;
}
export function readNullableString(value, key, field) {
    const result = readField(value, key, field);
    if (result === null)
        return null;
    if (typeof result !== 'string')
        throw new Error(`${field}.${key} must be a string or null`);
    return result;
}
export function readInteger(value, key, field) {
    const result = readField(value, key, field);
    if (typeof result !== 'number' || !Number.isSafeInteger(result)) {
        throw new Error(`${field}.${key} must be a safe integer`);
    }
    return result;
}
export function readPositiveSafeInteger(value, key, field) {
    const result = readInteger(value, key, field);
    if (result <= 0)
        throw new Error(`${field}.${key} must be a positive safe integer`);
    return result;
}
export function readNullableInteger(value, key, field) {
    const result = readField(value, key, field);
    if (result === null)
        return null;
    if (typeof result !== 'number' || !Number.isSafeInteger(result)) {
        throw new Error(`${field}.${key} must be a safe integer or null`);
    }
    return result;
}
export function readField(value, key, field) {
    if (!isPlainObject(value) || !Object.hasOwn(value, key)) {
        throw new Error(`${field} is missing ${key}`);
    }
    return value[key];
}
export function requireItem(values, index, field) {
    const value = values[index];
    if (value === undefined)
        throw new Error(`${field} is missing item ${String(index)}`);
    return value;
}
export function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=migration-0007-session-storage-readers.js.map