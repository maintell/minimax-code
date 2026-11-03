import { findHeredocBodies, findShellCommentLineEnd, isShellCommentStart, readBashExpansion, } from '@mavis/permission';
/** Executed Bash expansions, excluding escaped text and literal heredoc bodies. */
export function readBashSubstitutions(command) {
    const bodies = findHeredocBodies(command);
    // Quoted bodies never expand in the outer shell. Executable heredocs are
    // inspected separately as scripts, with their own Bash quoting context.
    const scan = {
        command,
        bodies,
        literalBodies: bodies.filter((body) => body.quoted),
        scripts: [],
        quote: undefined,
        previousExpansionEnd: -1,
        malformed: false,
    };
    for (let i = 0; i < command.length && !scan.malformed; i++) {
        i = scanSubstitutionAt(scan, i);
    }
    return { scripts: scan.scripts, malformed: scan.malformed };
}
/** Advances over one source position and returns the last index it consumed. */
function scanSubstitutionAt(scan, i) {
    const literalBody = scan.literalBodies.find((range) => i >= range.start && i < range.end);
    if (literalBody)
        return literalBody.end - 1;
    const inBody = scan.bodies.some((range) => i >= range.start && i < range.end);
    // Comments do not affect quote state. In an unquoted heredoc, '#' is
    // data during outer-shell expansion; executed bodies are checked again
    // as scripts by the caller. A top-level comment may legally end at EOF.
    if (!inBody &&
        isShellCommentStart(scan.command, i, scan.quote === "'", scan.quote === '"', scan.previousExpansionEnd)) {
        return findShellCommentLineEnd(scan.command, i);
    }
    return scanSubstitutionQuote(scan, i, inBody) ?? readSubstitutionExpansion(scan, i, inBody);
}
/** Consumes an escape or quote transition; returns undefined when the character may expand. */
function scanSubstitutionQuote(scan, i, inBody) {
    const char = scan.command[i];
    if (char === '\\' && scan.quote !== "'")
        return i + 1;
    if (!inBody && toggleBashQuote(scan, char))
        return i;
    return scan.quote === "'" ? i : undefined;
}
/** Single quotes toggle outside double quotes; double quotes toggle outside single quotes. */
function toggleBashQuote(scan, char) {
    if (char === "'" && scan.quote !== '"') {
        scan.quote = scan.quote ? undefined : "'";
        return true;
    }
    if (char === '"' && scan.quote !== "'") {
        scan.quote = scan.quote ? undefined : '"';
        return true;
    }
    return false;
}
function readSubstitutionExpansion(scan, i, inBody) {
    const expansion = readBashExpansion(scan.command, i, !inBody && !scan.quote);
    if (!expansion)
        return i;
    if (expansion.malformed) {
        scan.malformed = true;
        return i;
    }
    if (expansion.kind === 'arithmetic') {
        // Arithmetic is not a shell script, but it can execute nested substitutions.
        const nested = readBashSubstitutions(expansion.script);
        if (nested.malformed) {
            scan.malformed = true;
            return i;
        }
        scan.scripts.push(...nested.scripts);
    }
    else {
        scan.scripts.push(expansion.script);
    }
    scan.previousExpansionEnd = expansion.end;
    return expansion.end - 1;
}
//# sourceMappingURL=bash-substitutions.js.map