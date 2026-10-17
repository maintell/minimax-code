/**
 * `echo [-n] [args...]` — print arguments separated by single spaces.
 *
 * GNU `echo` default does NOT interpret `\n` / `\t` escapes — `-e` is
 * required. This handler rejects `-e` (and `-E`) so we don't have to
 * implement escape-decoding; commands that need them go to the sandbox.
 *
 * `$VAR` expansion is already rejected at the parser level (see
 * `parse.ts`), so argv here is pure literal strings.
 */
import { abortIfCancelled } from './types.js';
export const echoHandler = async (argv, ctx) => {
    abortIfCancelled(ctx);
    // argv[0] === 'echo'
    let trailingNewline = true;
    let i = 1;
    // Only `-n` is supported; `-e` / `-E` / multi-flag combinations go
    // to the sandbox. We deliberately stop flag-parsing at the first
    // non-`-n` arg so `echo -n -foo` prints `-foo` correctly.
    while (i < argv.length) {
        const a = argv[i];
        if (a === '-n') {
            trailingNewline = false;
            i += 1;
            continue;
        }
        if (a === '-e' || a === '-E') {
            return { stdout: '', stderr: `echo: unsupported flag ${a}\n`, exitCode: 1 };
        }
        break;
    }
    const text = argv.slice(i).join(' ');
    return { stdout: text + (trailingNewline ? '\n' : ''), stderr: '', exitCode: 0 };
};
//# sourceMappingURL=echo.js.map