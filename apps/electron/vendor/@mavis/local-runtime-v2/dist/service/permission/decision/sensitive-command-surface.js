import { splitShellSourceSegments, stripDataHeredocBodies } from '@mavis/permission';
/**
 * Bash text scanned for sensitive credential paths.
 *
 * Arguments that are data rather than paths are dropped so a search pattern
 * (`grep "api.key" src`), a jq filter (`jq '.data.key' r.json`) or a commit
 * message (`git commit -m "ignore .env"`) does not read as a credential file.
 * Data-only heredoc bodies are removed too. Every other argument, including
 * quoted ones and grep/rg pattern files, is still scanned. Tokens carrying
 * substitutions or redirects are never dropped, and an option this parser
 * cannot classify keeps the whole command in the scan.
 */
export function sensitivePathScanSurface(command) {
    const stripped = stripDataHeredocBodies(command);
    let changed = false;
    const segments = splitShellSourceSegments(stripped).map((segment) => {
        const reduced = dropDataArguments(segment);
        if (reduced === undefined)
            return segment;
        changed = true;
        return reduced;
    });
    return changed ? segments.join('\n') : stripped;
}
const SEARCH_FLAG_LONG = new Set([
    '--recursive',
    '--dereference-recursive',
    '--line-number',
    '--ignore-case',
    '--smart-case',
    '--case-sensitive',
    '--count',
    '--files-with-matches',
    '--files-without-match',
    '--invert-match',
    '--word-regexp',
    '--line-regexp',
    '--fixed-strings',
    '--extended-regexp',
    '--perl-regexp',
    '--only-matching',
    '--no-filename',
    '--with-filename',
    '--quiet',
    '--silent',
    '--hidden',
    '--no-ignore',
    '--no-heading',
    '--heading',
    '--json',
    '--multiline',
    '--follow',
    '--color',
    '--colour',
]);
const JQ_FLAG_LONG = new Set([
    '--raw-output',
    '--raw-output0',
    '--compact-output',
    '--slurp',
    '--null-input',
    '--exit-status',
    '--sort-keys',
    '--tab',
    '--join-output',
    '--ascii-output',
    '--color-output',
    '--monochrome-output',
    '--raw-input',
    '--seq',
    '--stream',
    '--stream-errors',
    '--args',
    '--jsonargs',
]);
const JQ_VALUE_LONG = {
    '--arg': 2,
    '--argjson': 2,
    '--slurpfile': 2,
    '--rawfile': 2,
    '--indent': 1,
};
const DATA_ARGUMENT_READERS = {
    grep: (args) => readSearchDataArguments(args, 'ABCDdefm'),
    rg: (args) => readSearchDataArguments(args, 'ABCEMTefgjmrt'),
    jq: readJqDataArguments,
    git: readGitCommitMessageArguments,
};
function dropDataArguments(segment) {
    const tokens = tokenize(segment);
    const commandIndex = findCommandIndex(tokens);
    const reader = DATA_ARGUMENT_READERS[basename(tokens[commandIndex] ?? '')];
    if (!reader)
        return undefined;
    const drops = reader(tokens.slice(commandIndex + 1));
    if (!drops || drops.size === 0)
        return undefined;
    return tokens.filter((_token, index) => !drops.has(index - commandIndex - 1)).join(' ');
}
/** grep/rg: the first operand is the pattern unless -e/-f supplied one. */
function readSearchDataArguments(args, valueLetters) {
    const cursor = { args, drops: new Set(), index: 0, dataSeen: false };
    for (; cursor.index < args.length; cursor.index += 1) {
        const token = args[cursor.index] ?? '';
        if (token === '--') {
            readFirstOperand(cursor, cursor.index + 1);
            break;
        }
        if (skipRedirect(cursor, token))
            continue;
        if (token.startsWith('--')) {
            if (!readSearchLongOption(cursor, token))
                return undefined;
            continue;
        }
        if (isShortCluster(token)) {
            readSearchShortCluster(cursor, token, valueLetters);
            continue;
        }
        markOperand(cursor, token);
    }
    return cursor.drops;
}
function readSearchLongOption(cursor, token) {
    const [name, hasValue] = splitLongOption(token);
    if (name === '--regexp') {
        cursor.dataSeen = true;
        dropValue(cursor, hasValue);
        return true;
    }
    if (name === '--file') {
        cursor.dataSeen = true;
        if (!hasValue)
            cursor.index += 1;
        return true;
    }
    return hasValue || SEARCH_FLAG_LONG.has(name);
}
function readSearchShortCluster(cursor, token, valueLetters) {
    const option = findValueLetter(token, valueLetters);
    if (!option)
        return;
    if (option.letter === 'e') {
        cursor.dataSeen = true;
        dropValue(cursor, option.attached);
        return;
    }
    // -f names a pattern file, which is a path and stays in the scan.
    if (option.letter === 'f')
        cursor.dataSeen = true;
    if (!option.attached)
        cursor.index += 1;
}
/** jq: the first operand is the filter unless -f/--from-file reads it from a file. */
function readJqDataArguments(args) {
    const cursor = { args, drops: new Set(), index: 0, dataSeen: false };
    for (; cursor.index < args.length; cursor.index += 1) {
        const token = args[cursor.index] ?? '';
        if (skipRedirect(cursor, token))
            continue;
        if (token.startsWith('--')) {
            if (!readJqLongOption(cursor, token))
                return undefined;
            continue;
        }
        if (isShortCluster(token)) {
            if (token.includes('f'))
                return undefined;
            const option = findValueLetter(token, 'L');
            if (option && !option.attached)
                cursor.index += 1;
            continue;
        }
        markOperand(cursor, token);
    }
    return cursor.drops;
}
function readJqLongOption(cursor, token) {
    const [name, hasValue] = splitLongOption(token);
    if (name === '--from-file')
        return false;
    const valueCount = JQ_VALUE_LONG[name];
    if (valueCount !== undefined) {
        cursor.index += hasValue ? valueCount - 1 : valueCount;
        return true;
    }
    return hasValue || JQ_FLAG_LONG.has(name);
}
/** git commit: -m / --message values are commit text, not paths. */
function readGitCommitMessageArguments(args) {
    let index = 0;
    while (args[index] === '-C' || args[index] === '-c')
        index += 2;
    if (args[index] !== 'commit')
        return undefined;
    const cursor = { args, drops: new Set(), index: index + 1, dataSeen: true };
    for (; cursor.index < args.length; cursor.index += 1) {
        const token = args[cursor.index] ?? '';
        if (token === '--')
            break;
        readGitCommitOption(cursor, token);
    }
    return cursor.drops;
}
function readGitCommitOption(cursor, token) {
    if (token.startsWith('--')) {
        const [name, hasValue] = splitLongOption(token);
        if (name === '--message')
            dropValue(cursor, hasValue);
        return;
    }
    if (!isShortCluster(token))
        return;
    const option = findValueLetter(token, 'mFCct');
    if (!option)
        return;
    if (option.letter === 'm')
        dropValue(cursor, option.attached);
    else if (!option.attached)
        cursor.index += 1;
}
/** Drop an option value: the current token when attached, else the next one. */
function dropValue(cursor, attached) {
    if (!attached)
        cursor.index += 1;
    const token = cursor.args[cursor.index];
    if (token !== undefined && isDroppable(token))
        cursor.drops.add(cursor.index);
}
function markOperand(cursor, token) {
    if (cursor.dataSeen)
        return;
    cursor.dataSeen = true;
    if (isDroppable(token))
        cursor.drops.add(cursor.index);
}
function readFirstOperand(cursor, index) {
    const token = cursor.args[index];
    if (token === undefined)
        return;
    cursor.index = index;
    markOperand(cursor, token);
}
/** Redirect targets are paths; never treat them as data operands. */
function skipRedirect(cursor, token) {
    if (!/^(?:\d*|&)[<>]/.test(token))
        return false;
    if (/^(?:\d*|&)[<>]+&?$/.test(token))
        cursor.index += 1;
    return true;
}
function findValueLetter(token, valueLetters) {
    for (let i = 1; i < token.length; i += 1) {
        const letter = token[i] ?? '';
        if (valueLetters.includes(letter))
            return { letter, attached: i < token.length - 1 };
    }
    return undefined;
}
function splitLongOption(token) {
    const eq = token.indexOf('=');
    return eq < 0 ? [token, false] : [token.slice(0, eq), true];
}
function isShortCluster(token) {
    return token.startsWith('-') && token.length > 1;
}
/** Substitutions and redirects can name a path even inside a data argument. */
function isDroppable(token) {
    return !/[$`<>]/.test(token);
}
function findCommandIndex(tokens) {
    let cursor = 0;
    while (cursor < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[cursor] ?? '')) {
        cursor += 1;
    }
    while (['sudo', 'env', 'command', 'exec'].includes(basename(tokens[cursor] ?? ''))) {
        cursor += 1;
    }
    return cursor;
}
/** Shell words, keeping quoted runs such as `--message="a b"` in one token. */
function tokenize(segment) {
    return (segment.match(/(?:[^\s"']|"[^"]*"|'[^']*')+/g) ?? []).map((token) => token.replace(/["']/g, ''));
}
function basename(token) {
    return token.replaceAll('\\', '/').split('/').pop() || token;
}
//# sourceMappingURL=sensitive-command-surface.js.map