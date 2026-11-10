import { shellTokenizeWithMetadata } from './shell-tokenize.js';
import { consumeBashExecutionPrefix } from './bash-wrapper-unwrap.js';
/** Decode command words once; callers must never treat these analysis words as executable text. */
export function readBashCommand(command, includePathSyntax = false) {
    const words = shellTokenizeWithMetadata(command, includePathSyntax);
    const tokens = words.map((word) => word.value);
    const start = consumeBashExecutionPrefix(tokens);
    const executable = tokens[start];
    return executable
        ? {
            executable,
            args: tokens.slice(start + 1),
            ...(includePathSyntax ? { argTokens: words.slice(start + 1) } : {}),
        }
        : undefined;
}
/** Git for Windows executable identity, after Bash quote removal and escaping. */
export function gitBashCommandName(executable) {
    return (executable
        .split(/[\\/]/)
        .at(-1)
        ?.replace(/\.exe$/i, '')
        .toLowerCase() ?? '');
}
//# sourceMappingURL=bash-command.js.map