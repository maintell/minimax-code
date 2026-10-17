export function shellTokenize(input) {
    return shellTokenizeWithMetadata(input).map((token) => token.value);
}
export function shellTokenizeWithMetadata(input) {
    const tokens = [];
    let current = '';
    let currentStart;
    let currentQuoted = false;
    let inSingleQuote = false;
    let inDoubleQuote = false;
    let escaped = false;
    const startCurrent = (index) => {
        currentStart ??= index;
    };
    const flushCurrent = (end) => {
        if (current.length > 0) {
            tokens.push({
                value: current,
                start: currentStart ?? end,
                end,
                quoted: currentQuoted,
            });
        }
        current = '';
        currentStart = undefined;
        currentQuoted = false;
    };
    for (let i = 0; i < input.length; i++) {
        const ch = input[i];
        if (escaped) {
            startCurrent(i - 1);
            current += ch;
            currentQuoted = true;
            escaped = false;
            continue;
        }
        if (ch === '\\' && !inSingleQuote) {
            const next = input[i + 1];
            if (next === '\n') {
                i += 1;
                continue;
            }
            if (next === '\r' && input[i + 2] === '\n') {
                i += 2;
                continue;
            }
            startCurrent(i);
            currentQuoted = true;
            escaped = true;
            continue;
        }
        if (ch === "'" && !inDoubleQuote) {
            startCurrent(i);
            currentQuoted = true;
            inSingleQuote = !inSingleQuote;
            continue;
        }
        if (ch === '"' && !inSingleQuote) {
            startCurrent(i);
            currentQuoted = true;
            inDoubleQuote = !inDoubleQuote;
            continue;
        }
        if (isShellWhitespace(ch) && !inSingleQuote && !inDoubleQuote) {
            flushCurrent(i);
            continue;
        }
        startCurrent(i);
        current += ch;
    }
    flushCurrent(input.length);
    return tokens;
}
function isShellWhitespace(ch) {
    const code = ch.charCodeAt(0);
    return code === 32 || (code >= 9 && code <= 13);
}
//# sourceMappingURL=shell-tokenize.js.map