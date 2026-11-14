const QUOTED_OR_WORD = /"([^"]*)"?|(\S+)/gu;
/**
 * Splits a query per spec 15.6: whitespace separates keywords, double quotes keep a
 * keyword together, a bare `OR` between keywords means either. Everything else,
 * including FTS5 operators and punctuation, is plain text.
 */
function parseQuery(query, tokenize) {
    const keywords = [];
    const operators = [];
    let pendingOr = false;
    for (const match of query.matchAll(QUOTED_OR_WORD)) {
        const quoted = match[1];
        const word = match[2];
        if (quoted === undefined && word === 'OR') {
            pendingOr = keywords.length > 0;
            continue;
        }
        const text = (quoted ?? word ?? '').trim();
        const tokens = tokenize(text).map((token) => token.text);
        if (tokens.length === 0)
            continue;
        if (keywords.length > 0)
            operators.push(pendingOr ? 'OR' : 'AND');
        keywords.push({ text, tokens });
        pendingOr = false;
    }
    return { keywords, operators };
}
/** FTS5 expression on one column; every token is letters and digits only, so quoting is safe. */
export function toMatchExpression(column, query, operator) {
    const phrases = query.keywords.map((keyword) => `"${keyword.tokens.join(' ')}"*`);
    const expression = phrases
        .map((phrase, index) => index === 0 ? phrase : `${operator ?? query.operators[index - 1]} ${phrase}`)
        .join(' ');
    return `${column} : (${expression})`;
}
export function hasAndOperator(query) {
    return query.operators.includes('AND');
}
/** Query tokens of a column, for locating the first hit in a document. */
export function queryTokens(column, query, tokenizer) {
    return parseQuery(query, (text) => column === 'words' ? tokenizer.words(text) : tokenizer.chars(text));
}
/** Whether a document token is a hit for any keyword: exact, or prefix on a keyword's last token. */
export function tokenMatcher(query) {
    const exact = new Set();
    const prefixes = [];
    for (const keyword of query.keywords) {
        keyword.tokens.slice(0, -1).forEach((token) => exact.add(token));
        const last = keyword.tokens.at(-1);
        if (last)
            prefixes.push(last);
    }
    return (token) => exact.has(token) || prefixes.some((prefix) => token.startsWith(prefix));
}
//# sourceMappingURL=query.js.map