/**
 * Static Git Bash working-directory facts for path safety. Nothing here
 * executes or rewrites a command; unsupported shapes return no proof.
 */
import { gitBashCommandName, readBashCommand, splitCommand, unwrapBashCommandWrappers, } from '@mavis/permission';
/**
 * `cd <literal> && rest`: rest runs only after cd succeeded, so its relative
 * paths belong to the new directory. Unquoted words exclude expansions,
 * escapes and option or home spellings; CDPATH is not modelled.
 */
const LEADING_LITERAL_CD = /^\s*cd[ \t]+(?:'([^'\n]+)'|"([^"$`\\\n]+)"|([^\s'"$`\\;&|<>(){}*?[\]#!]+))[ \t]*&&/;
/** More candidate directories than this cannot be checked meaningfully. */
const MAX_CANDIDATE_DIRECTORIES = 32;
/** Reads the one supported leading form: `cd <literal path> && ...`. */
export function readLeadingLiteralCd(command) {
    const match = LEADING_LITERAL_CD.exec(command);
    const directory = match?.[1] ?? match?.[2] ?? match?.[3];
    if (!match || !directory || /^[-~]/.test(directory))
        return undefined;
    const rest = command.slice(match[0].length);
    // `cd x && a; b` runs b even when cd failed, so b has no proven cwd.
    if (!rest.trim() || hasUnconditionalSeparator(rest))
        return undefined;
    return { directory, rest };
}
/** True when a later command may run whether or not the leading cd succeeded. */
function hasUnconditionalSeparator(script) {
    let quote = '';
    for (let index = 0; index < script.length; index += 1) {
        const char = script.charAt(index);
        if (quote) {
            if (char === quote)
                quote = '';
            else if (char === '\\' && quote === '"')
                index += 1;
            continue;
        }
        if (char === '\\') {
            index += 1;
            continue;
        }
        if (char === "'" || char === '"') {
            quote = char;
            continue;
        }
        if (isUnconditionalSeparatorAt(script, index))
            return true;
    }
    return quote !== '';
}
function isUnconditionalSeparatorAt(script, index) {
    const char = script.charAt(index);
    if (char === ';' || char === '\n' || char === '\r')
        return true;
    if (char === '|')
        return script.charAt(index + 1) === '|';
    if (char !== '&')
        return false;
    const previous = script.charAt(index - 1);
    const next = script.charAt(index + 1);
    // `&&`, `|&`, `>&`, `<&` and `&>` keep the command conditional.
    return !['&', '|', '>', '<'].includes(previous) && !['&', '>'].includes(next);
}
/** Literal cd/pushd targets anywhere in a script, including wrapper payloads. */
export function collectLiteralCdTargets(command, nesting = 0) {
    if (nesting > 8)
        return [];
    const targets = [];
    for (const segment of splitCommand(command)) {
        for (const surface of unwrapBashCommandWrappers(segment)) {
            if (surface !== segment)
                targets.push(...collectLiteralCdTargets(surface, nesting + 1));
            else
                targets.push(...readLiteralCdTarget(surface));
        }
    }
    return targets;
}
function readLiteralCdTarget(surface) {
    const parsed = readBashCommand(surface, true);
    if (!parsed || !['cd', 'pushd'].includes(gitBashCommandName(parsed.executable)))
        return [];
    const args = parsed.args[0] === '--' ? parsed.args.slice(1) : parsed.args;
    if (args.length === 0)
        return ['~'];
    const [target] = args;
    const dynamic = parsed.argTokens?.some((token) => token.pathSyntax?.dynamic === true);
    // Dynamic and option forms have no static identity; callers treat them as unknown.
    return args.length === 1 && target && !dynamic && !target.startsWith('-') ? [target] : [];
}
/**
 * Every directory a write may run in after literal cd/pushd commands whose
 * order or success is not proven. Returns undefined when the set is too large.
 */
export function candidateDirectories(start, targets, resolveDirectory) {
    const directories = new Set(start ? [start] : []);
    for (const target of targets) {
        for (const base of [...directories, undefined]) {
            const resolved = resolveDirectory(target, base);
            if (resolved)
                directories.add(resolved);
        }
        if (directories.size > MAX_CANDIDATE_DIRECTORIES)
            return undefined;
    }
    return [...directories];
}
//# sourceMappingURL=git-bash-cwd.js.map