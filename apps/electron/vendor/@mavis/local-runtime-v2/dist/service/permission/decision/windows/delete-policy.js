/**
 * Recoverable-delete policy for Windows commands: which surfaces delete, which
 * delete spellings the trash rewrite can reach, and which need the explicit
 * Windows path-safety pass. Native deletion disables only the rewrite.
 */
import path from 'node:path';
import { commandHasExecutedHeredocBody, findHeredocBodies, gitBashCommandName, isRmCommand, matchHardBlockedBash, parseWindowsNativeDelete, readBashCommand, splitCommand, unwrapBashCommandWrappers, unwrapCommandWrappers, } from '@mavis/permission';
import { readBashSubstitutions } from '../bash-substitutions.js';
import { expandWindowsCommandSurfaces, hasWindowsWriteRedirection, parseWindowsShellFamily, splitWindowsCommandSegments, } from './command-surfaces.js';
import { hasWindowsWriteOrDeleteCommand } from './write-targets.js';
const POSIX_DELETE_COMMANDS = new Set([
    'rm',
    'rmdir',
    'rd',
    'del',
    'erase',
    'remove-item',
    'ri',
    'remove',
    'unlink',
    'shred',
    'mavis-trash',
]);
function commandSegments(command, posix) {
    return posix ? splitCommand(command) : splitWindowsCommandSegments(command);
}
function commandSurfaces(command, posix = false) {
    return [
        ...new Set(posix
            ? commandSegments(command, true)
                .flatMap((segment) => [
                ...unwrapCommandWrappers(segment),
                ...unwrapBashCommandWrappers(segment),
            ])
                .flatMap(splitCommand)
            : expandWindowsCommandSurfaces(command)),
    ];
}
export function findWindowsDeleteReason(command, recoverableNativeDelete) {
    if (recoverableNativeDelete)
        return undefined;
    return commandSurfaces(command)
        .map((candidate) => matchHardBlockedBash(candidate))
        .find((hit) => hit?.category === 'windows-delete')?.description;
}
function readLeadingExecutable(command) {
    const program = /^\s*(?:"([^"]*)"|'([^']*)'|(\S+))/.exec(command);
    return program?.[1] ?? program?.[2] ?? program?.[3];
}
export function resolveWindowsShellFamily(command, hostShellFamily) {
    // A wrapper carries explicit provenance for its payload. Bare commands must
    // use the host-provided executor shell; never infer CMD/PowerShell from
    // `del`, `rd`, `Remove-Item`, or any other command name.
    return (parseWindowsShellFamily(command) ??
        (hostShellFamily === 'cmd' || hostShellFamily === 'powershell' ? hostShellFamily : undefined));
}
function isMavisTrashExecutable(command) {
    const executable = readLeadingExecutable(command);
    if (!executable)
        return false;
    return (path.win32
        .basename(executable)
        .replace(/\.(?:cmd|bat|exe)$/i, '')
        .toLowerCase() === 'mavis-trash');
}
export function isRecoverableDeleteInsideWorkspace(targets, workspaceDir) {
    const workspace = path.win32
        .normalize(workspaceDir)
        .toLowerCase()
        .replace(/[\\/]$/, '');
    return targets.every((target) => {
        const normalized = path.win32
            .normalize(target)
            .toLowerCase()
            .replace(/[\\/]$/, '');
        if (/^[a-z]:\\?$/i.test(normalized) ||
            /^[a-z]:\\(?:windows|program files(?: \(x86\))?)(?:\\|$)/i.test(normalized)) {
            return false;
        }
        return normalized === workspace || normalized.startsWith(`${workspace}\\`);
    });
}
/**
 * A single surface (already expanded by `commandSurfaces`) is delete-like
 * if its leading executable would delete files: bash `rm`, PowerShell
 * `Remove-Item` / `ri` / `remove`, Windows CMD `del` / `erase` / `rmdir`
 * / `rd`, POSIX `unlink` / `shred`, or the recoverable `mavis-trash`
 * launcher itself. This is the set the safety net must audit segment by
 * segment — see `everyDeleteSegmentIsSafelyRewritable`.
 */
function isDeleteLikeSegment(surface, posix = false) {
    if (posix) {
        const parsed = readBashCommand(surface);
        return !!parsed && POSIX_DELETE_COMMANDS.has(gitBashCommandName(parsed.executable));
    }
    return (/^\s*(?:rm|rmdir|rd|del|erase|remove-item|ri|remove|unlink|shred)\b/i.test(surface) ||
        isMavisTrashExecutable(surface));
}
export function isDeleteLikeCommand(command, posix = false) {
    return commandSurfaces(command, posix).some((surface) => isDeleteLikeSegment(surface, posix));
}
/** Textual rm rewrites cannot reach inside Bash command/process substitutions. */
function hasNestedPosixDelete(command, nesting = 0) {
    if (nesting > 8)
        return true;
    const bodies = findHeredocBodies(command);
    const substitutions = readBashSubstitutions(command);
    if (substitutions.malformed)
        return true;
    const scripts = [
        ...bodies
            .filter((body) => commandHasExecutedHeredocBody(body.header))
            .map((body) => command.slice(body.start, body.end)),
        ...substitutions.scripts,
    ];
    return scripts.some((payload) => splitCommand(payload).some((part) => isDeleteLikeCommand(part, true)) ||
        hasNestedPosixDelete(payload, nesting + 1));
}
/**
 * A trusted Git Bash script deletes inside a substitution or executed heredoc
 * that the top-level rm rewrite cannot reach. Inspect the complete script
 * before dropping control-flow headers: a `for ... in $(...)` header can
 * execute commands even without a body.
 */
export function hasPosixSubstitutionDelete(command) {
    return (hasNestedPosixDelete(command) ||
        commandSegments(command, true).some((surface) => unwrapBashCommandWrappers(surface).some((script) => hasNestedPosixDelete(script))));
}
export function commandContainsRmSegment(command) {
    return isRmCommand(command) || splitCommand(command).some((segment) => isRmCommand(segment));
}
function normalizeWindowsExecutablePath(executable) {
    return path.win32.normalize(executable.replaceAll('/', '\\')).toLowerCase();
}
export function hasUntrustedMavisTrashExecutable(command, launcherPath, posix = false) {
    const expectedLauncher = normalizeWindowsExecutablePath(launcherPath);
    return commandSurfaces(command, posix).some((surface) => {
        if (!isMavisTrashExecutable(surface))
            return false;
        const executable = readLeadingExecutable(surface);
        return Boolean(executable && normalizeWindowsExecutablePath(executable) !== expectedLauncher);
    });
}
/**
 * Every delete-like segment in a compound Windows command must independently
 * resolve to a safe deletion path — either a bare `rm` that the engine will
 * rewrite into `mavis-trash <path>` further down the pipeline, or the exact
 * canonical `mavis-trash.cmd` absolute path emitted by that rewrite.
 *
 * Without a per-segment audit, a compound command like
 *   "<dataDir>\bin\mavis-trash.cmd" -- .\a && unlink .\b
 * would sneak the `unlink` permanent delete past the boundary because the
 * only trash surface (segment 1) satisfies the trusted-launcher check, and
 * `unlink` is not in the row-anchored windows-delete hard-regex nor the
 * recursive workspace check.
 *
 * The `rm` case is subtle. The engine rewrites `rm ...` at the top of a
 * subcommand — so a top-level `rm ... && ...` still gets rewritten, but
 * `cmd /c "rm ..."` does NOT (the rewrite cannot reach into a wrapper
 * payload). Wrapper unwrap exposes the inner `rm` as an extra surface for
 * the HARD hard-regex scan, but the actual invocation is still `cmd /c "rm
 * ..."` at shell launch — no rewrite happens. So `rm` is only trusted when
 * the surface is itself a top-level segment, not a wrapper-payload surface.
 */
export function everyDeleteSegmentIsSafelyRewritable(command, launcherPath, shellFamily, posix = false) {
    const expectedLauncher = normalizeWindowsExecutablePath(launcherPath);
    const topLevelSegments = new Set(commandSegments(command, posix));
    const surfaces = commandSurfaces(command, posix);
    const deleteSurfaces = surfaces.filter((surface) => isDeleteLikeSegment(surface, posix));
    if (deleteSurfaces.length === 0)
        return true;
    return deleteSurfaces.every((surface) => {
        // Canonical absolute launcher is always safe — the exact executable
        // the rm rewrite emits. Bare `mavis-trash` / any other basename is
        // NOT accepted here (Windows CWD-first resolution risk).
        if (isMavisTrashExecutable(surface)) {
            const executable = readLeadingExecutable(surface);
            return normalizeWindowsExecutablePath(executable) === expectedLauncher;
        }
        // Bare `rm` is safe ONLY when this surface is itself a top-level
        // subcommand segment (the rm rewrite runs on the top-level command;
        // it cannot reach into `cmd /c "rm ..."` or `bash -c "rm ..."`
        // payloads). Wrapper-payload rm surfaces bubbled up by
        // unwrapCommandWrappers are informational for the hard-regex scan
        // and must not be trusted here.
        if (isRmCommand(surface) && topLevelSegments.has(surface))
            return true;
        if (topLevelSegments.size === 1 &&
            topLevelSegments.has(surface) &&
            parseWindowsNativeDelete(surface, shellFamily))
            return true;
        return false;
    });
}
export function needsWindowsPathSafetyCheck(toolName, input, command, shellFamily) {
    if (['read', 'glob', 'grep', 'list'].includes(toolName))
        return false;
    if (command) {
        return (hasWindowsWriteRedirection(command) || hasWindowsWriteOrDeleteCommand(command, shellFamily));
    }
    return [input.path, input.filePath, input.file_path].some((value) => typeof value === 'string');
}
//# sourceMappingURL=delete-policy.js.map