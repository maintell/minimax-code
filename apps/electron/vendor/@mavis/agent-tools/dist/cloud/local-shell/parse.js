/**
 * Tokenize bash command strings into argv arrays for the local fast-path
 * dispatcher. Any token that signals shell metaprogramming (pipes,
 * redirects, subshells, variable expansion, globs, comments) makes the
 * command ineligible for local handling — dispatcher falls back to the
 * sandbox in those cases so the real shell handles whatever the LLM
 * intended.
 *
 * Uses `shell-quote` as the tokenizer (MIT, ~30KB, battle-tested in
 * npm CLI and many Node tools). Variable expansion is rendered as a
 * sentinel string so a single pass over tokens can spot any `$VAR` usage
 * even when shell-quote returns it as a plain string.
 */
import { parse as shellParse } from 'shell-quote';
const VAR_PLACEHOLDER = '__CLOUD_BASH_VAR__';
/**
 * Parse a bash command. Returns the argv on success, otherwise a
 * structured reject reason consumed by the dispatcher to mark the
 * skip outcome.
 */
export function parseCommand(command) {
    const trimmed = command.trim();
    if (trimmed.length === 0)
        return { reason: 'empty' };
    // shell-quote returns string for plain tokens and an object for any
    // shell-level construct (operators / globs / comments). Variable
    // expansion is collapsed into the sentinel so the post-pass below can
    // spot it inside otherwise-normal-looking strings.
    let tokens;
    try {
        tokens = shellParse(trimmed, () => VAR_PLACEHOLDER);
    }
    catch {
        // shell-quote throws on unterminated quotes etc. Treat as ineligible
        // — the sandbox shell will produce the canonical bash error.
        return { reason: 'unsupported-token' };
    }
    if (tokens.length === 0)
        return { reason: 'empty' };
    const argv = [];
    for (const tok of tokens) {
        if (typeof tok === 'string') {
            if (tok.includes(VAR_PLACEHOLDER))
                return { reason: 'var-expansion' };
            // Backtick command substitution (legacy `cmd` form, equivalent to
            // $(cmd)) is parsed by shell-quote as a plain string token rather
            // than an operator. Reject any argv entry containing a backtick so
            // the sandbox shell handles the substitution — local handlers
            // never spawn a shell, so a backtick reaching a handler would
            // silently lose its substitution semantics. Defense-in-depth even
            // though the path-guard would catch most resulting path values.
            if (tok.includes('`'))
                return { reason: 'subshell' };
            argv.push(tok);
            continue;
        }
        // Object token: classify by shape. shell-quote tags operators with
        // `op`, glob expansions with `pattern` (and `op === 'glob'`), and
        // comments with `comment`.
        if ('comment' in tok)
            return { reason: 'comment' };
        if ('op' in tok) {
            const op = tok.op;
            if (op === 'glob')
                return { reason: 'glob-expansion' };
            if (op === '|' || op === '|&')
                return { reason: 'pipe' };
            if (op === '>' || op === '>>' || op === '<' || op === '>&') {
                return { reason: 'redirect' };
            }
            if (op === '(' || op === ')' || op === '<(')
                return { reason: 'subshell' };
            if (op === '&&' || op === '||' || op === ';' || op === ';;' || op === '&') {
                return { reason: 'unsupported-token' };
            }
            return { reason: 'unsupported-token' };
        }
        // Unknown object shape — be conservative.
        return { reason: 'unsupported-token' };
    }
    if (argv.length === 0)
        return { reason: 'empty' };
    return { argv };
}
//# sourceMappingURL=parse.js.map