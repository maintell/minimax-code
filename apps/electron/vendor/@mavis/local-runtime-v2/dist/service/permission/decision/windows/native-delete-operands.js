/**
 * Best-effort delete operands for positive matching under native deletion.
 * A result is never proof that a command is confined. Parameters follow the
 * executing shell's own binding rules so option values are not read as
 * targets; any shape this reader cannot bind confidently yields `undefined`,
 * which leaves the command to ordinary permissions instead of denying it.
 */
import { normalizeWindowsProgramName, tokenizeWindowsCommand } from './command-surfaces.js';
/** Remove-Item plus common parameters, as bound by PowerShell 5.1 and 7. */
const REMOVE_ITEM_PARAMETERS = [
    { name: 'path', aliases: [], kind: 'target' },
    { name: 'literalpath', aliases: ['pspath', 'lp'], kind: 'target' },
    { name: 'recurse', aliases: [], kind: 'switch' },
    { name: 'force', aliases: [], kind: 'switch' },
    { name: 'whatif', aliases: ['wi'], kind: 'switch' },
    { name: 'confirm', aliases: ['cf'], kind: 'switch' },
    { name: 'verbose', aliases: ['vb'], kind: 'switch' },
    { name: 'debug', aliases: ['db'], kind: 'switch' },
    { name: 'usetransaction', aliases: ['usetx'], kind: 'switch' },
    ...[
        ['filter'],
        ['include'],
        ['exclude'],
        ['credential'],
        ['stream'],
        ['erroraction', 'ea'],
        ['warningaction', 'wa'],
        ['informationaction', 'infa'],
        ['progressaction', 'proga'],
        ['errorvariable', 'ev'],
        ['warningvariable', 'wv'],
        ['informationvariable', 'iv'],
        ['outvariable', 'ov'],
        ['outbuffer', 'ob'],
        ['pipelinevariable', 'pv'],
    ].map(([name = '', ...aliases]) => ({ name, aliases, kind: 'value' })),
];
const POWERSHELL_DELETE_COMMANDS = new Set(['remove-item', 'ri', 'remove']);
const CMD_DELETE_COMMANDS = new Set(['del', 'erase', 'rd', 'rmdir']);
export function readNativeDeleteOperands(surface) {
    const [program] = tokenizeWindowsCommand(surface.command, surface.shellFamily);
    if (!program)
        return undefined;
    const name = normalizeWindowsProgramName(program);
    if (surface.shellFamily === 'posix')
        return readPosixRm(surface.command);
    const powershell = POWERSHELL_DELETE_COMMANDS.has(name) ||
        (surface.shellFamily === 'powershell' && (name === 'rm' || CMD_DELETE_COMMANDS.has(name)));
    if (powershell)
        return readRemoveItem(splitShellWords(surface.command, true).slice(1));
    const words = splitShellWords(surface.command, false).slice(1);
    return name === 'rm' ? readRmWords(words, 'cmd') : readCmdDelete(words);
}
/** PowerShell `~` goes through the provider; variables expand outside single quotes. */
export function isNativeHomeReference(target) {
    const value = target.value.toLowerCase().replace(/[\\/]$/, '');
    if (target.syntax === 'cmd')
        return value === '%userprofile%' || value === '%home%';
    if (target.syntax === 'posix') {
        return /^(?:~|\$home|\$\{home\}|\$userprofile|\$\{userprofile\})$/.test(value);
    }
    if (value === '~')
        return true;
    return (!target.literal &&
        /^(?:\$home|\$\{home\}|\$env:(?:userprofile|home)|\$\{\s*env:\s*(?:userprofile|home)\s*\})$/.test(value));
}
function readRemoveItem(words) {
    if (words.some(isPowerShellExpression))
        return undefined;
    const args = groupPowerShellArguments(words);
    const targets = [];
    let recursive = false;
    for (let index = 0; index < args.length; index += 1) {
        const binding = bindPowerShellArgument(args[index] ?? [], args[index + 1]);
        if (!binding)
            return undefined;
        index += binding.consumed;
        targets.push(...binding.targets);
        if (binding.parameter?.name === 'recurse')
            recursive = binding.enabled === true;
    }
    return { recursive, targets };
}
/** A positional argument is a target; a parameter binds its own value. */
function bindPowerShellArgument(arg, next) {
    const binding = arg[0]?.bare.startsWith('-')
        ? bindPowerShellParameter(arg, next)
        : { consumed: 0, value: arg };
    if (!binding)
        return undefined;
    return { ...binding, targets: binding.value ? powerShellTargets(binding.value) : [] };
}
/** PowerShell joins `a, b` and `a ,b` into one array argument across spaces. */
function groupPowerShellArguments(words) {
    const groups = [];
    for (const word of words) {
        const last = groups[groups.length - 1];
        const previous = last?.[last.length - 1];
        if (last && previous && (previous.trailingComma || word.leadingComma)) {
            last.push(word);
        }
        else {
            groups.push([word]);
        }
    }
    return groups;
}
function bindPowerShellParameter(arg, next) {
    const [word, ...rest] = arg;
    if (!word)
        return undefined;
    const colon = word.text.indexOf(':');
    const rawName = (colon < 0 ? word.text : word.text.slice(0, colon)).slice(1).toLowerCase();
    const parameter = resolvePowerShellParameter(rawName);
    // A parameter name cannot itself start an array.
    if (!parameter || (colon < 0 && rest.length > 0))
        return undefined;
    const first = colon < 0 ? undefined : inlineWord(word, colon);
    const inline = first ? [first, ...rest] : undefined;
    if (parameter.kind === 'switch') {
        return bindSwitch(parameter, colon >= 0, inline ?? next, !inline);
    }
    return bindValue(parameter, inline, next);
}
/** `-Name` enables a switch; `-Name:$true` / `-Name: $false` sets it explicitly. */
function bindSwitch(parameter, explicit, value, separate) {
    if (!explicit)
        return { parameter, consumed: 0, enabled: true };
    const enabled = value?.length === 1 ? readSwitchValue(value[0]?.text) : undefined;
    if (enabled === undefined)
        return undefined;
    return { parameter, consumed: separate ? 1 : 0, enabled };
}
/** Only target parameters report their value; other option values are skipped whole. */
function bindValue(parameter, inline, next) {
    const value = inline ?? next;
    if (!value?.[0] || (!inline && value[0].bare.startsWith('-')))
        return undefined;
    const consumed = inline ? 0 : 1;
    return parameter.kind === 'target' ? { parameter, consumed, value } : { parameter, consumed };
}
/** Exact names and aliases win; otherwise a prefix must select one parameter. */
function resolvePowerShellParameter(rawName) {
    if (!rawName)
        return undefined;
    const exact = REMOVE_ITEM_PARAMETERS.find((parameter) => parameter.name === rawName || parameter.aliases.includes(rawName));
    if (exact)
        return exact;
    const matches = REMOVE_ITEM_PARAMETERS.filter((parameter) => [parameter.name, ...parameter.aliases].some((candidate) => candidate.startsWith(rawName)));
    return matches.length === 1 ? matches[0] : undefined;
}
function readSwitchValue(text) {
    const value = text?.toLowerCase();
    if (value === '$true')
        return true;
    if (value === '$false')
        return false;
    return undefined;
}
/** The value after `-Name:`; the parameter name itself is always unquoted text. */
function inlineWord(word, colon) {
    const text = word.text.slice(colon + 1);
    if (!text)
        return undefined;
    const bareColon = word.bare.indexOf(':');
    const bare = bareColon < 0 ? '' : word.bare.slice(bareColon + 1);
    const [first, ...rest] = word.elements;
    if (!first)
        return undefined;
    const value = {
        ...first,
        value: first.value.slice(colon + 1),
        bare: first.bare.slice(colon + 1),
    };
    return {
        ...word,
        text,
        bare,
        elements: [value, ...rest],
        leadingComma: value.value === '' && rest.length > 0,
    };
}
/** Unquoted commas separate array elements; a quoted comma is part of one path. */
function powerShellTargets(arg) {
    return arg.flatMap((word) => word.elements
        .filter((element) => element.value.trim() !== '')
        .map((element) => ({
        value: element.value.trim(),
        syntax: 'powershell',
        // Wholly single-quoted: PowerShell does not expand `$HOME` there.
        literal: element.singleQuoted && !element.doubleQuoted && element.bare === '',
    })));
}
const PROTECTED_VARIABLES = String.raw `systemroot|windir|programfiles(?:\(x86\))?|programw6432|commonprogramfiles(?:\(x86\))?`;
const PROTECTED_DIRECTORIES = String.raw `windows|program files(?: \(x86\))?`;
const POWERSHELL_PROTECTED_REFERENCE = new RegExp(String.raw `^(?:\$env:(?:${PROTECTED_VARIABLES})|\$\{\s*env:\s*(?:${PROTECTED_VARIABLES})\s*\}|(?:\$env:systemdrive|\$\{\s*env:\s*systemdrive\s*\})[\\/](?:${PROTECTED_DIRECTORIES}))(?:[\\/]|$)`, 'i');
const CMD_PROTECTED_REFERENCE = new RegExp(String.raw `^(?:%(?:${PROTECTED_VARIABLES})%|%systemdrive%[\\/](?:${PROTECTED_DIRECTORIES}))(?:[\\/]|$)`, 'i');
/**
 * A protected-directory variable in the executing shell's own syntax. Other
 * spellings, such as `%SystemRoot%` in PowerShell, are ordinary file names.
 */
export function isNativeProtectedReference(target) {
    if (target.syntax === 'cmd')
        return CMD_PROTECTED_REFERENCE.test(target.value);
    return (target.syntax === 'powershell' &&
        !target.literal &&
        POWERSHELL_PROTECTED_REFERENCE.test(target.value));
}
/** Subexpressions, script blocks and calls build a target this reader cannot evaluate. */
function isPowerShellExpression(word) {
    return /[(){}@`]/.test(word.bare.replace(/\$\{[^}]*\}/g, '')) || word.text === '--%';
}
function readCmdDelete(words) {
    const targets = [];
    let recursive = false;
    for (const word of words) {
        if (/^\/s$/i.test(word.bare))
            recursive = true;
        else if (!/^\/[a-z?](?::\S*)?$/i.test(word.bare)) {
            targets.push({ value: word.text, syntax: 'cmd', literal: false });
        }
    }
    return { recursive, targets };
}
function readPosixRm(command) {
    const words = tokenizeWindowsCommand(command, 'posix')
        .slice(1)
        .map((text) => plainWord(text));
    return readRmWords(words, 'posix');
}
function readRmWords(words, syntax) {
    const targets = [];
    let recursive = false;
    let operandsOnly = false;
    for (const word of words) {
        if (!operandsOnly && word.bare === '--')
            operandsOnly = true;
        else if (!operandsOnly && word.bare.startsWith('-') && word.bare.length > 1) {
            recursive ||= /^-[a-z]*r/i.test(word.bare) || word.bare === '--recursive';
        }
        else
            targets.push({ value: word.text, syntax, literal: false });
    }
    return { recursive, targets };
}
/**
 * Split shell words while remembering which characters were quoted. CMD has
 * no single-quote syntax, so a `'` is an ordinary path character there.
 */
function splitShellWords(command, singleQuotes) {
    const words = [];
    let word = emptyWordState();
    let quote;
    for (const char of command) {
        if (quote) {
            if (char === quote)
                quote = undefined;
            else
                appendChar(word, char, quote);
        }
        else if (char === '"' || (singleQuotes && char === "'")) {
            quote = char;
            markQuote(word, char);
        }
        else if (/\s/.test(char)) {
            if (word.started)
                words.push(finishWord(word));
            word = emptyWordState();
        }
        else {
            appendChar(word, char, undefined);
        }
    }
    if (word.started)
        words.push(finishWord(word));
    return words;
}
function emptyElement() {
    return { value: '', bare: '', doubleQuoted: false, singleQuoted: false };
}
function emptyWordState() {
    return {
        text: '',
        bare: '',
        started: false,
        elements: [emptyElement()],
        leadingComma: undefined,
        trailingComma: false,
    };
}
function currentElement(word) {
    const element = word.elements[word.elements.length - 1];
    if (element)
        return element;
    const created = emptyElement();
    word.elements.push(created);
    return created;
}
function markQuote(word, quote) {
    word.started = true;
    word.leadingComma ??= false;
    word.trailingComma = false;
    const element = currentElement(word);
    if (quote === "'")
        element.singleQuoted = true;
    else
        element.doubleQuoted = true;
}
/** Only an unquoted comma separates PowerShell array elements. */
function appendChar(word, char, quote) {
    word.started = true;
    word.text += char;
    const arrayComma = quote === undefined && char === ',';
    word.leadingComma ??= arrayComma;
    word.trailingComma = arrayComma;
    if (quote === undefined)
        word.bare += char;
    if (arrayComma) {
        word.elements.push(emptyElement());
        return;
    }
    const element = currentElement(word);
    element.value += char;
    if (quote === undefined)
        element.bare += char;
}
function finishWord(word) {
    return {
        text: word.text,
        bare: word.bare,
        elements: word.elements,
        leadingComma: word.leadingComma === true,
        trailingComma: word.trailingComma,
    };
}
function plainWord(text) {
    return {
        text,
        bare: text,
        elements: [{ value: text, bare: text, singleQuoted: false, doubleQuoted: false }],
        leadingComma: false,
        trailingComma: false,
    };
}
//# sourceMappingURL=native-delete-operands.js.map