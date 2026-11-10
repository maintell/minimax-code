/**
 * Windows command-surface parsing shared by the path-safety and delete
 * boundaries: segment splitting, tokenization, redirect targets and the
 * shell/cwd-aware surface expansion of wrapper payloads.
 */
import path from 'node:path';
import { isRmCommand, parseScriptPlainCommands, splitCommand, splitShellSourceSegments, unwrapCommandWrappers, } from '@mavis/permission';
/**
 * Fully expand a shell surface into the individual executable-command
 * candidates that must each be inspected: split into segments, unwrap
 * transparent shell wrappers (`cmd /c "…"`, `powershell -Command "…"`,
 * `bash -c "…"`, `nohup`, `setsid`, `timeout`, …) at every depth, then
 * split again so a wrapper payload with embedded `&&`/`|`/`;` chains is
 * observed segment-by-segment. Callers filter this list by whatever
 * predicate they need (`isDeleteLikeCommand`, `isWindowsWriteOrDeleteCommand`,
 * `matchHardBlockedBash`, …) without duplicating the traversal.
 */
export function expandWindowsCommandSurfaces(command) {
    return splitWindowsCommandSegments(command).flatMap((segment) => unwrapCommandWrappers(segment).flatMap(splitWindowsCommandSegments));
}
export function parseWindowsShellFamily(command) {
    const [program] = tokenizeWindowsCommand(command);
    if (!program)
        return undefined;
    const name = normalizeWindowsProgramName(program);
    if (name === 'cmd')
        return 'cmd';
    if (name === 'powershell' || name === 'pwsh')
        return 'powershell';
    return undefined;
}
function isWindowsCwdChange(command, shellFamily) {
    const tokens = tokenizeWindowsCommand(command, shellFamily);
    // Unlike process wrappers, POSIX `command cd` runs the builtin in this shell.
    while (tokens[0] === 'command') {
        tokens.shift();
        while (/^(?:-p|--)$/.test(tokens[0] ?? ''))
            tokens.shift();
    }
    return /^(?:(?:cd|chdir)(?:$|[.\\/])|pushd$|popd$|set-location$|sl$|push-location$|pop-location$|[A-Za-z]:$)/i.test(tokens[0] ?? '');
}
/**
 * A loop or jump can execute an earlier write again after a later cd. Scan
 * inside unquoted blocks too, while quoted text and wrapper payloads stay
 * opaque. This only selects a conservative cwd fallback, not an execution AST.
 */
function mayRepeatAfterCwdChange(sourceStages, shellFamily) {
    const controlStages = sourceStages.flatMap((stage) => splitWindowsCommandSource(stage, true, true));
    const mayRepeat = controlStages.some((stage) => /^(?:for|foreach|while|until|do|goto)\b/i.test(stage));
    return mayRepeat && controlStages.some((stage) => isWindowsCwdChange(stage, shellFamily));
}
/**
 * Expand a command into executable surfaces while keeping, for each one, the
 * shell that runs it, whether a top-level rm is rewritten to the trash, the
 * redirect targets of its stage, and whether its entry cwd is still trusted.
 */
export function expandWindowsCommandSurfacesWithShell(command, context = {}) {
    const posix = context.shellFamily === 'posix';
    const sourceStages = posix
        ? splitShellSourceSegments(command)
        : splitWindowsCommandSource(command, true);
    const stages = posix ? splitCommand(command) : sourceStages;
    let previousCwdChange = context.cwdChanged === true || mayRepeatAfterCwdChange(sourceStages, context.shellFamily);
    return stages.flatMap((stage) => {
        const stageCwdChanged = previousCwdChange;
        const segments = posix ? [stage] : splitWindowsCommandSegments(stage);
        // Redirects use the cwd before the command executes. A filename after `>`
        // is not a command and must not itself be interpreted as a location change.
        previousCwdChange ||= isWindowsCwdChange(segments[0] ?? '', context.shellFamily);
        return segments.flatMap((segment, index) => expandSegmentSurfaces({ segment, redirectionStage: index === 0 ? stage : undefined, stageCwdChanged }, context));
    });
}
function expandSegmentSurfaces(input, context) {
    const { segment, redirectionStage, stageCwdChanged } = input;
    const { shellFamily, depth = 0 } = context;
    const rewritableRm = context.recoverableRm === true && isRmCommand(segment);
    const surface = {
        command: segment,
        shellFamily,
        recoverableRm: rewritableRm,
        cwdChanged: stageCwdChanged,
        redirectionTargets: redirectionStage === undefined ? [] : readWindowsRedirectionTargets(redirectionStage),
    };
    // Peel one layer at a time, splitting its payload before the next unwrap.
    // Each alternative payload inherits this stage's entry cwd independently;
    // child-shell location changes never leak into its parent or siblings.
    if (depth >= 8)
        return [surface];
    const innerShell = parseWindowsShellFamily(segment) ?? (isRmCommand(segment) ? shellFamily : 'unknown');
    const surfaces = [surface];
    for (const inner of directWrapperPayloads(segment)) {
        surfaces.push(...expandWindowsCommandSurfacesWithShell(inner, {
            shellFamily: innerShell,
            recoverableRm: rewritableRm,
            depth: depth + 1,
            cwdChanged: stageCwdChanged,
        }));
    }
    return surfaces;
}
/**
 * The existing unwrap also includes descendants and alternative decoded
 * payloads. Visit descendants through their parent so their shell is kept.
 */
function directWrapperPayloads(segment) {
    const candidates = new Set(unwrapCommandWrappers(segment).slice(1));
    const payloads = [];
    for (const inner of candidates) {
        for (const descendant of unwrapCommandWrappers(inner).slice(1)) {
            candidates.delete(descendant);
        }
        payloads.push(inner);
    }
    return payloads;
}
/**
 * Split a shell surface at executable command boundaries before interpreting
 * copy/move arguments. A following `&& echo`, pipeline, or redirection is
 * not an argument of the preceding write command. Quoted separators remain
 * literal so normal quoted paths are preserved.
 */
export function splitWindowsCommandSegments(command) {
    return splitWindowsCommandSource(command, false);
}
/** Keep redirects attached for cwd tracking; optionally expose block control words. */
function splitWindowsCommandSource(command, preserveRedirections, splitBlocks = false) {
    const options = { preserveRedirections, splitBlocks };
    const segments = [];
    let start = 0;
    let quote;
    for (let index = 0; index < command.length; index += 1) {
        const character = command[index];
        if (character === quote) {
            quote = undefined;
            continue;
        }
        if (!quote && isWindowsQuote(character)) {
            quote = character;
            continue;
        }
        if (isWindowsEscape(character)) {
            index += windowsEscapeLength(command, index);
            continue;
        }
        if (quote || !isWindowsSourceBoundary(command, index, options))
            continue;
        pushTrimmedSegment(segments, command.slice(start, index));
        // Treat CRLF as one command boundary. A backtick/caret immediately before
        // the newline was already consumed above, so shell continuations remain
        // part of the same surface.
        start = character === '\r' && command[index + 1] === '\n' ? index + 2 : index + 1;
        index = start - 1;
    }
    pushTrimmedSegment(segments, command.slice(start));
    return segments;
}
function pushTrimmedSegment(segments, value) {
    const segment = value.trim();
    if (segment)
        segments.push(segment);
}
function isWindowsQuote(character) {
    return character === '"' || character === "'";
}
/** CMD's caret and PowerShell's backtick quote the immediately following character. */
function isWindowsEscape(character) {
    return character === '^' || character === '`';
}
/**
 * Consume a complete CRLF continuation so its LF cannot become a separate
 * command boundary and detach the real destination.
 */
function windowsEscapeLength(command, index) {
    return command[index + 1] === '\r' && command[index + 2] === '\n' ? 2 : 1;
}
function isWindowsSourceBoundary(command, index, options) {
    const character = command[index] ?? '';
    if (character === '&')
        return !(options.preserveRedirections && command[index - 1] === '>');
    if (character === '>')
        return !options.preserveRedirections;
    if (options.splitBlocks && /[(){}]/.test(character))
        return true;
    return ['|', ';', '\n', '\r'].includes(character);
}
function scanWindowsCommandCharacter(character, quote) {
    if (character === quote)
        return { quote: undefined, skipNext: false, boundary: false };
    if (!quote && isWindowsQuote(character)) {
        return { quote: character, skipNext: false, boundary: false };
    }
    if (isWindowsEscape(character)) {
        return { quote, skipNext: true, boundary: false };
    }
    const boundary = !quote && ['&', '|', ';', '>'].includes(character ?? '');
    return { quote, skipNext: false, boundary: Boolean(boundary) };
}
/**
 * Reads redirect destinations before command segmentation discards the
 * operator. The caller applies normal protected-path checks to each target.
 */
function readWindowsRedirectionTargets(command) {
    const targets = [];
    let quote;
    for (let index = 0; index < command.length; index += 1) {
        const character = command[index];
        const scan = scanWindowsCommandCharacter(character, quote);
        quote = scan.quote;
        if (scan.skipNext) {
            index += 1;
            continue;
        }
        if (!scan.boundary || character !== '>')
            continue;
        const target = readWindowsRedirectionTargetAt(command, index);
        if (target.value)
            targets.push(target.value);
        index = target.nextIndex;
    }
    return targets;
}
function readWindowsRedirectionTargetAt(command, operatorIndex) {
    let targetStart = operatorIndex + 1;
    if (command[targetStart] === '>')
        targetStart += 1;
    while (/\s/.test(command[targetStart] ?? ''))
        targetStart += 1;
    if (!command[targetStart] || command[targetStart] === '&') {
        return { nextIndex: operatorIndex };
    }
    return readWindowsRedirectionValue(command, targetStart);
}
function readWindowsRedirectionValue(command, start) {
    const targetQuote = command[start];
    const quoted = isWindowsQuote(targetQuote);
    const targetStart = quoted ? start + 1 : start;
    let targetEnd = targetStart;
    if (quoted) {
        while (targetEnd < command.length && command[targetEnd] !== targetQuote)
            targetEnd += 1;
    }
    else {
        while (targetEnd < command.length && !/[\s;&|<>]/.test(command[targetEnd] ?? '')) {
            targetEnd += 1;
        }
    }
    return {
        value: command.slice(targetStart, targetEnd),
        nextIndex: quoted ? targetEnd : targetEnd - 1,
    };
}
export function hasWindowsWriteRedirection(command) {
    // Scan the raw command's wrapper unwraps AND each top-level segment's
    // wrapper unwraps to detect writes hidden inside chained wrappers.
    // Redirect target extraction depends on `>` being present in the surface,
    // so we cannot feed it post-split surfaces (which discard `>`).
    const scanTargets = new Set([
        ...unwrapCommandWrappers(command),
        ...splitWindowsCommandSegments(command).flatMap(unwrapCommandWrappers),
    ]);
    for (const surface of scanTargets) {
        if (readWindowsRedirectionTargets(surface).length > 0)
            return true;
    }
    return false;
}
export function tokenizeWindowsCommand(command, shellFamily) {
    const posixTokens = shellFamily === 'posix' ? tokenizePosixCommand(command) : undefined;
    if (posixTokens)
        return posixTokens;
    const tokens = [];
    const tokenPattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
    for (const match of command.matchAll(tokenPattern)) {
        tokens.push(match[1] ?? match[2] ?? match[3] ?? '');
    }
    return tokens;
}
function tokenizePosixCommand(command) {
    const parsed = parseScriptPlainCommands(command);
    if (parsed?.length === 1)
        return parsed[0] ?? [];
    // Keep an rm with dynamic operands visible to the fail-closed target parser.
    return isRmCommand(command) ? ['rm'] : undefined;
}
export function normalizeWindowsProgramName(program) {
    return path.win32
        .basename(program)
        .replace(/\.(?:exe|cmd|bat)$/i, '')
        .toLowerCase();
}
//# sourceMappingURL=command-surfaces.js.map