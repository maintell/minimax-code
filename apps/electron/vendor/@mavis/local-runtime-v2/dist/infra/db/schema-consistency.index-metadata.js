import { readName, readNullableString, readNumber, readSql, readString, } from './schema-consistency.metadata-rows.js';
import { canonicalizeSqlExpression } from './sql-contract.js';
export function readIndexDefinition(db, name) {
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
export function readIndexColumns(db, name) {
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
function normalizeSql(value) {
    return value.replaceAll('"', '').replace(/\s+/gu, ' ').trim().replace(/;$/u, '').toLowerCase();
}
//# sourceMappingURL=schema-consistency.index-metadata.js.map