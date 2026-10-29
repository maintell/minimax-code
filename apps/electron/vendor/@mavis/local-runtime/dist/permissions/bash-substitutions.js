import { findHeredocBodies, findShellCommentLineEnd, isShellCommentStart, readBashExpansion, } from '@mavis/permission';
/** Executed Bash expansions, excluding escaped text and literal heredoc bodies. */
export function readBashSubstitutions(command) {
    const scripts = [];
    const bodies = findHeredocBodies(command);
    // Quoted bodies never expand in the outer shell. Executable heredocs are
    // inspected separately as scripts, with their own Bash quoting context.
    const literalBodies = bodies.filter((body) => body.quoted);
    let quote;
    let previousExpansionEnd = -1;
    for (let i = 0; i < command.length; i++) {
        const literalBody = literalBodies.find((range) => i >= range.start && i < range.end);
        if (literalBody) {
            i = literalBody.end - 1;
            continue;
        }
        const inBody = bodies.some((range) => i >= range.start && i < range.end);
        // Comments do not affect quote state. In an unquoted heredoc, '#' is
        // data during outer-shell expansion; executed bodies are checked again
        // as scripts by the caller. A top-level comment may legally end at EOF.
        if (!inBody &&
            isShellCommentStart(command, i, quote === "'", quote === '"', previousExpansionEnd)) {
            const lineEnd = findShellCommentLineEnd(command, i);
            i = lineEnd;
            continue;
        }
        const char = command[i];
        if (char === '\\' && quote !== "'") {
            i++;
            continue;
        }
        if (!inBody && char === "'" && quote !== '"') {
            quote = quote ? undefined : "'";
            continue;
        }
        if (quote === "'")
            continue;
        if (!inBody && char === '"') {
            quote = quote ? undefined : '"';
            continue;
        }
        const expansion = readBashExpansion(command, i, !inBody && !quote);
        if (!expansion)
            continue;
        if (expansion.malformed)
            return { scripts, malformed: true };
        if (expansion.kind === 'arithmetic') {
            // Arithmetic is not a shell script, but it can execute nested substitutions.
            const nested = readBashSubstitutions(expansion.script);
            if (nested.malformed)
                return { scripts, malformed: true };
            scripts.push(...nested.scripts);
        }
        else {
            scripts.push(expansion.script);
        }
        previousExpansionEnd = expansion.end;
        i = expansion.end - 1;
    }
    return { scripts, malformed: false };
}
//# sourceMappingURL=bash-substitutions.js.map