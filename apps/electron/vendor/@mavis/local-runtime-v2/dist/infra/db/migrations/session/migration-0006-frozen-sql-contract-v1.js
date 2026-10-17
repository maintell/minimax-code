/**
 * m0005 冻结的 SQLite SQL contract tokenizer。历史 migration 不得依赖 production helper。
 */
const IDENTIFIER_PATTERN = /^[\p{L}_$][\p{L}\p{N}_$]*/u;
const NUMBER_PATTERN = /^(?:0[xX][\dA-Fa-f]+|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)/u;
const MULTI_CHARACTER_OPERATORS = ['->>', '!=', '<>', '<=', '>=', '==', '||', '<<', '>>', '->'];
const QUOTED_IDENTIFIER_CLOSINGS = {
    '"': '"',
    '`': '`',
    '[': ']',
};
export function canonicalizeSqlContract(sql) {
    return serializeTokens(readCanonicalTokens(sql));
}
export function canonicalizeSqlDefault(value) {
    if (value === null)
        return null;
    const tokens = readCanonicalTokens(value);
    while (hasRedundantOuterParentheses(tokens)) {
        tokens.shift();
        tokens.pop();
    }
    return serializeTokens(tokens);
}
export function canonicalizeSqlDefinition(sql) {
    const tokens = readCanonicalTokens(sql);
    const objectKindIndex = tokens.findIndex((candidate, index) => introducesIfNotExists(tokens, candidate, index));
    if (objectKindIndex >= 0)
        tokens.splice(objectKindIndex + 1, 3);
    return serializeTokens(tokens);
}
export function extractSqlCheckContracts(sql) {
    const tokens = readCanonicalTokens(sql);
    const contracts = [];
    for (let index = 0; index < tokens.length; index += 1) {
        if (!isWord(tokens[index], 'check') || !isPunctuation(tokens[index + 1], '('))
            continue;
        const closing = findClosingParenthesis(tokens, index + 1);
        if (closing === -1)
            continue;
        contracts.push(serializeTokens(tokens.slice(index + 2, closing)));
        index = closing;
    }
    return contracts.sort();
}
function readCanonicalTokens(sql) {
    const tokens = [];
    let index = 0;
    while (index < sql.length) {
        const token = readCanonicalToken(sql, index);
        if (token.kind !== null)
            tokens.push(token);
        index = token.next;
    }
    if (tokens.at(-1)?.kind === 'punctuation' && tokens.at(-1)?.value === ';')
        tokens.pop();
    return tokens;
}
function hasRedundantOuterParentheses(tokens) {
    if (!isPunctuation(tokens[0], '(') || !isPunctuation(tokens.at(-1), ')'))
        return false;
    let depth = 0;
    for (const [index, token] of tokens.entries()) {
        if (isPunctuation(token, '('))
            depth += 1;
        if (isPunctuation(token, ')'))
            depth -= 1;
        if (depth === 0 && index < tokens.length - 1)
            return false;
        if (depth < 0)
            return false;
    }
    return depth === 0;
}
function findClosingParenthesis(tokens, opening) {
    let depth = 0;
    for (let index = opening; index < tokens.length; index += 1) {
        if (isPunctuation(tokens[index], '('))
            depth += 1;
        if (isPunctuation(tokens[index], ')'))
            depth -= 1;
        if (depth === 0)
            return index;
    }
    return -1;
}
function introducesIfNotExists(tokens, candidate, index) {
    return (index > 0 &&
        index <= 2 &&
        isWord(tokens[0], 'create') &&
        ['index', 'table', 'trigger', 'view'].includes(candidate.value) &&
        candidate.kind === 'word' &&
        isWord(tokens[index + 1], 'if') &&
        isWord(tokens[index + 2], 'not') &&
        isWord(tokens[index + 3], 'exists'));
}
function isWord(token, value) {
    return token?.kind === 'word' && token.value === value;
}
function isPunctuation(token, value) {
    return token?.kind === 'punctuation' && token.value === value;
}
function serializeTokens(tokens) {
    return tokens.map(({ kind, value }) => `${kind}:${hexEncode(value)};`).join('');
}
function hexEncode(value) {
    let encoded = '';
    for (let index = 0; index < value.length; index += 1) {
        encoded += value.charCodeAt(index).toString(16).padStart(4, '0');
    }
    return encoded;
}
function readCanonicalToken(sql, index) {
    const current = sql[index] ?? '';
    if (isSqliteWhitespace(current))
        return { kind: null, value: '', next: index + 1 };
    const commentEnd = readCommentEnd(sql, index);
    if (commentEnd !== null)
        return { kind: null, value: '', next: commentEnd };
    if (current === "'")
        return readStringLiteral(sql, index);
    const identifierClosing = QUOTED_IDENTIFIER_CLOSINGS[current];
    if (identifierClosing)
        return readQuotedIdentifier(sql, index, identifierClosing);
    return readUnquotedToken(sql, index);
}
function readUnquotedToken(sql, index) {
    const remaining = sql.slice(index);
    const identifier = IDENTIFIER_PATTERN.exec(remaining)?.[0];
    if (identifier)
        return createToken('word', asciiCaseFold(identifier), index);
    const number = NUMBER_PATTERN.exec(remaining)?.[0];
    if (number)
        return createToken('number', number.toLowerCase(), index);
    const operator = MULTI_CHARACTER_OPERATORS.find((candidate) => remaining.startsWith(candidate));
    if (operator)
        return createToken('operator', operator, index);
    return createToken('punctuation', sql[index] ?? '', index);
}
function createToken(kind, value, start) {
    return { kind, value, next: start + value.length };
}
function isSqliteWhitespace(value) {
    const code = value.charCodeAt(0);
    return code === 0x20 || (code >= 0x09 && code <= 0x0d);
}
function asciiCaseFold(value) {
    return value.replace(/[A-Z]/gu, (character) => character.toLowerCase());
}
function readCommentEnd(sql, start) {
    if (sql.startsWith('--', start))
        return skipLineComment(sql, start + 2);
    if (sql.startsWith('/*', start))
        return skipBlockComment(sql, start + 2);
    return null;
}
function skipLineComment(sql, start) {
    const lineFeed = sql.indexOf('\n', start);
    return lineFeed === -1 ? sql.length : lineFeed + 1;
}
function skipBlockComment(sql, start) {
    const closing = sql.indexOf('*/', start);
    return closing === -1 ? sql.length : closing + 2;
}
function readStringLiteral(sql, start) {
    let value = "'";
    let index = start + 1;
    while (index < sql.length) {
        const current = sql[index] ?? '';
        value += current;
        if (current !== "'") {
            index += 1;
            continue;
        }
        if (sql[index + 1] === "'") {
            value += "'";
            index += 2;
            continue;
        }
        return { kind: 'literal', value, next: index + 1 };
    }
    return { kind: 'literal', value, next: index };
}
function readQuotedIdentifier(sql, start, closing) {
    let value = '';
    let index = start + 1;
    while (index < sql.length) {
        const current = sql[index] ?? '';
        if (current !== closing) {
            value += asciiCaseFold(current);
            index += 1;
            continue;
        }
        if (sql[index + 1] === closing) {
            value += closing;
            index += 2;
            continue;
        }
        return { kind: 'quotedIdentifier', value, next: index + 1 };
    }
    return { kind: 'quotedIdentifier', value, next: index };
}
//# sourceMappingURL=migration-0006-frozen-sql-contract-v1.js.map