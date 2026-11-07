/**
 * Windows protected-path and workspace-boundary policy for write/delete
 * commands and file tools. Denials are bypass-immune: no permission mode,
 * persisted rule or approval may authorize them.
 */
import { homedir } from 'node:os';
import path from 'node:path';
import { isRmCommand, parseScriptPlainCommands, unwrapBashCommandWrappers, } from '@mavis/permission';
import { readPermissionCommand, } from '../checker-input.js';
import { gitBashPathSafetyReason } from '../git-bash-path-safety.js';
import { expandWindowsCommandSurfaces, expandWindowsCommandSurfacesWithShell, normalizeWindowsProgramName, tokenizeWindowsCommand, } from './command-surfaces.js';
import { isNativeDeleteSurface, isRecursiveWindowsWriteCommand, isWindowsCopyOption, isWindowsWriteOrDeleteCommand, parseWindowsDeleteTargets, readWindowsPathSafetyTargets, readWindowsWriteTargets, resolveWindowsTargets, } from './write-targets.js';
import { isNativeHomeReference, isNativeProtectedReference, readNativeDeleteOperands, } from './native-delete-operands.js';
const READ_ONLY_TOOLS = new Set(['read', 'glob', 'grep', 'list']);
const HOME_DELETE_REASON = 'Refused: recursive deletion targets a root or home directory. This can cause unrecoverable data loss; choose a specific sub-path instead.';
/**
 * Detect protected Windows directories directly from the command surface.
 *
 * Do not rely solely on the generic absolute-path collector below: it may
 * start at an absolute source and consume the whitespace plus a later
 * absolute destination. That would make `copy C:\\source C:\\Windows\\...`
 * look like one ordinary source path. This matcher starts at every command
 * boundary, so every protected destination is independently visible even
 * when a preceding source is absolute or the target contains spaces.
 */
function findProtectedWindowsPath(value) {
    // `path.win32.normalize` is required before matching a protected root:
    // `C:\\project\\..\\..\\Windows` is an absolute Windows path even though it
    // does not lexically start with `C:\\Windows`. Scan both the complete value
    // (for a direct target) and absolute path fragments (for a command surface).
    const absolutePathFragments = value.match(/(?:\\\\\?\\)?[A-Za-z]:[\\/][^\s"';&|<>]*/gi) ?? [];
    for (const candidate of [value, ...absolutePathFragments]) {
        const normalizedCandidate = canonicalizeWindowsAbsolutePath(candidate);
        const match = /(?:^|[\s"';&|<>])((?:\\\\\?\\)?[A-Za-z]:[\\/](?:windows|program files(?: \(x86\))?)(?:[\\/]|$))/i.exec(normalizedCandidate);
        if (match)
            return match[1];
    }
    // Environment-variable and drive-relative spellings can resolve to a
    // protected directory without containing a literal absolute drive path.
    // Fail closed on these known protected roots rather than relying on CMD's
    // per-drive current-directory semantics.
    //
    // Recognized forms (all case-insensitive):
    //   CMD:         %SystemRoot%, %windir%, %ProgramFiles%,
    //                %ProgramFiles(x86)%, %ProgramW6432%,
    //                %CommonProgramFiles%, %CommonProgramFiles(x86)%,
    //                %SystemDrive%\Windows, %SystemDrive%\Program Files,
    //                %SystemDrive%\Program Files (x86)
    //   PowerShell:  $env:SystemRoot, $env:windir, $env:ProgramFiles,
    //                $env:ProgramW6432, $env:CommonProgramFiles,
    //                $env:SystemDrive\Windows / Program Files
    //   PowerShell braced: ${env:SystemRoot}, ${env:windir}, ${env:ProgramFiles},
    //                ${env:ProgramFiles(x86)}, ${env:ProgramW6432},
    //                ${env:CommonProgramFiles}, ${env:CommonProgramFiles(x86)},
    //                ${env:SystemDrive}\Windows / Program Files
    //     — PowerShell requires braces for identifiers containing `(` `)`;
    //       ${env:ProgramFiles(x86)} was the concrete gap Codex Review flagged.
    //   Drive-relative literal: C:Windows, C:Program Files (drive-current-dir),
    //     which CMD resolves against the drive's per-process working directory —
    //     we cannot reconstruct that safely, so any of those spellings is
    //     rejected up-front.
    const protectedNames = String.raw `systemroot|windir|programfiles(?:\(x86\))?|programw6432|commonprogramfiles(?:\(x86\))?`;
    const symbolicPath = new RegExp(
    // group 1 = the offending path fragment
    String.raw `(?:^|[\s"';&|<>])(` +
        // %CMD_ENV%
        String.raw `(?:%(?:${protectedNames})%` +
        // %SystemDrive%\Windows or %SystemDrive%\Program Files ...
        String.raw `|%systemdrive%[\\/](?:windows|program files(?: \(x86\))?)` +
        // $env:VAR  (unbraced PowerShell env var — cannot express names with `(`)
        String.raw `|\$env:(?:${protectedNames})` +
        // $env:SystemDrive\Windows or Program Files ...
        String.raw `|\$env:systemdrive[\\/](?:windows|program files(?: \(x86\))?)` +
        // ${env:VAR}  (braced PowerShell env var — the ONLY form that can
        // express ProgramFiles(x86); allow leading/trailing whitespace inside
        // the braces because PowerShell tolerates it)
        String.raw `|\$\{\s*env:\s*(?:${protectedNames})\s*\}` +
        // ${env:SystemDrive}\Windows or Program Files ...
        String.raw `|\$\{\s*env:\s*systemdrive\s*\}[\\/](?:windows|program files(?: \(x86\))?)` +
        // Drive-relative literal `C:Windows` / `C:Program Files ...`
        String.raw `|[A-Za-z]:(?:windows|program files(?: \(x86\))?)` +
        String.raw `)(?:[\\/]|$))`, 'i');
    return symbolicPath.exec(value)?.[1];
}
function findAmbiguousProgramFilesWriteTarget(command) {
    const [program, ...args] = tokenizeWindowsCommand(command);
    if (!program ||
        !['copy', 'cp', 'xcopy', 'robocopy', 'move', 'mv'].includes(normalizeWindowsProgramName(program))) {
        return undefined;
    }
    // An unquoted `C:\\Program Files\\...` destination is split by CMD into
    // `C:\\Program` and `Files\\...`. When it follows at least one source it
    // cannot be recovered as the parsed final positional target, so retain a
    // narrow fail-closed check for that unsafe spelling. A protected source in
    // the first positional slot remains a read and is not blocked here.
    let positionalCount = 0;
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        if (isWindowsCopyOption(arg))
            continue;
        if (positionalCount > 0 &&
            /^[A-Za-z]:\\program$/i.test(arg) &&
            /^files(?:\\|$)/i.test(args[index + 1] ?? '')) {
            return `${arg} ${args[index + 1]}`;
        }
        positionalCount += 1;
    }
    return undefined;
}
function findDriveRelativeWindowsPath(value) {
    // `C:foo` and `C:..\\Windows` resolve against CMD's per-drive current
    // directory, which this permission boundary cannot reconstruct safely.
    // A recursive delete/write must never rely on that ambient state, so deny
    // every drive-relative spelling rather than trying to infer its target.
    const match = /(?:^|[\s"';&|<>])([A-Za-z]:(?![\\/])[^\s"';&|<>]*)/.exec(value);
    return match?.[1];
}
function buildWindowsPathSafetyDenyReason(input) {
    if (isOutsideWindowsPathPolicy(input))
        return undefined;
    const rawCommand = readPermissionCommand(input.input);
    if (input.trustedShellFamily === 'posix' && rawCommand) {
        return buildGitBashPathSafetyDenyReason(input, rawCommand);
    }
    const scan = collectWindowsPathSafetyScan(input);
    const nativeDeleteReason = checkNativeDeleteTargets(input, scan.nativeDeleteSurfaces);
    if (nativeDeleteReason)
        return nativeDeleteReason;
    if (hasNoWindowsWrite(scan))
        return undefined;
    return (checkScriptContext(input, scan) ??
        checkWindowsPathSpellings(input.toolName, scan) ??
        checkResolvedWindowsPaths(input, scan));
}
function isOutsideWindowsPathPolicy(input) {
    return (input.platform ?? process.platform) !== 'win32' || READ_ONLY_TOOLS.has(input.toolName);
}
function hasNoWindowsWrite(scan) {
    return (scan.command !== undefined &&
        scan.writeSurfaces.length === 0 &&
        scan.redirectionTargets.length === 0);
}
/**
 * A trusted Git Bash session owns POSIX decoding and MSYS path mapping.
 * Native wrapper payloads are delegated with their own shell syntax.
 * trustedShellFamily is only set from the session snapshot / resolver path,
 * never from tool input, OS detection or fresh preference reads.
 */
function buildGitBashPathSafetyDenyReason(input, rawCommand) {
    const checkNative = (surface, nesting, uncertainCwd) => {
        // Only the native invocation belongs to the Windows parser. Re-tokenizing
        // the surrounding Bash script would discard /c/... operands as switches.
        const nativeReason = buildWindowsPathSafetyDenyReason({
            ...input,
            input: { ...input.input, command: surface },
            trustedShellFamily: undefined,
            uncertainWorkingDirectory: uncertainCwd,
        });
        if (nativeReason)
            return nativeReason;
        return findNestedGitBashReason(surface, {
            workspaceDir: input.workspaceDir,
            nesting,
            checkNative,
            uncertainCwd,
            nativeDelete: input.nativeDelete === true,
        });
    };
    const reason = gitBashPathSafetyReason(rawCommand, input.workspaceDir, undefined, {
        nesting: 0,
        checkNative,
        nativeDelete: input.nativeDelete === true,
    });
    // This parser owns the complete Bash script, including redirects and native
    // wrapper callbacks. Re-parsing that script as Windows argv would discard
    // MSYS operands and reject safe mixed-shell commands.
    return reason ? `Local hard safety policy blocked ${input.toolName}: ${reason}` : undefined;
}
function findNestedGitBashReason(surface, context) {
    for (const nested of expandWindowsCommandSurfaces(surface)) {
        if (unwrapBashCommandWrappers(nested).length <= 1)
            continue;
        const reason = gitBashPathSafetyReason(nested, context.workspaceDir, undefined, {
            nesting: context.nesting + 1,
            checkNative: context.checkNative,
            uncertainCwd: context.uncertainCwd,
            nativeDelete: context.nativeDelete,
        });
        if (reason)
            return reason;
    }
    return undefined;
}
function collectWindowsPathSafetyScan(input) {
    const command = readPermissionCommand(input.input);
    const directPath = input.input.path ?? input.input.filePath ?? input.input.file_path;
    // Native-delete aware surface expansion: pass shellFamily and recoverableRm so
    // each surface carries enough metadata for the dynamic-POSIX checks below.
    const surfaces = command
        ? expandWindowsCommandSurfacesWithShell(command, {
            shellFamily: input.shellFamily,
            recoverableRm: input.recoverableRm,
        })
        : [];
    // Expansion extracts redirects before dropping `>`, at every wrapper layer,
    // and keeps the owning stage's entry cwd alongside each destination.
    const redirectionTargets = surfaces.flatMap((surface) => surface.redirectionTargets);
    // Native deletion keeps the shell's own delete syntax. Its operands leave the
    // proof-based write pipeline below; every other write keeps that pipeline.
    const nativeDeleteSurfaces = input.nativeDelete
        ? surfaces.filter((surface) => !surface.recoverableRm && isNativeDeleteSurface(surface))
        : [];
    const writeSurfaces = surfaces.filter((surface) => isWindowsWriteOrDeleteCommand(surface.command, surface.shellFamily) &&
        !nativeDeleteSurfaces.includes(surface));
    const values = command
        ? [...writeSurfaces.flatMap(readSurfacePathValues), ...redirectionTargets]
        : directPathValues(directPath);
    return {
        ...(command ? { command } : {}),
        ...(typeof directPath === 'string' ? { directPath } : {}),
        surfaces,
        nativeDeleteSurfaces,
        writeSurfaces,
        redirectionTargets,
        values,
        recursiveSurfaces: writeSurfaces.filter((surface) => isRecursiveWindowsWriteCommand(surface.command, surface.shellFamily)),
    };
}
function readSurfacePathValues(surface) {
    return (readWindowsPathSafetyTargets(surface.command, surface.shellFamily, surface.recoverableRm) ?? [
        surface.command,
    ]);
}
function directPathValues(directPath) {
    return typeof directPath === 'string' ? [directPath] : [];
}
function checkScriptContext(input, scan) {
    if (scan.command &&
        input.shellFamily === 'posix' &&
        hasDynamicPosixWrite(scan.command, scan.writeSurfaces)) {
        return `Local hard safety policy blocked ${input.toolName}: native delete targets cannot be verified safely in a dynamic POSIX command.`;
    }
    // Distinct guard from the MR (b2) facade: a cd / pushd / source earlier in the
    // same script can shift the entry cwd, in which case non-absolute write
    // targets cannot be resolved safely even when shellFamily metadata is set.
    if (input.uncertainWorkingDirectory &&
        scan.values.some((value) => !/^[A-Za-z]:[\\/]/.test(value))) {
        return 'Native shell write after a directory change cannot be resolved safely; use absolute paths in a separate command.';
    }
    return undefined;
}
/**
 * Check the original POSIX source: both splitters replace line continuations
 * with spaces, while Bash joins the adjacent characters. Once split, target
 * checks cannot detect that loss (even inside a Windows wrapper payload).
 * Keep the whole source for dynamic cwd/assignment/header checks as well.
 */
function hasDynamicPosixWrite(command, writeSurfaces) {
    if (/\\\r?\n/.test(command) && writeSurfaces.some((surface) => !surface.recoverableRm)) {
        return true;
    }
    return (!parseScriptPlainCommands(command) &&
        writeSurfaces.some((surface) => surface.shellFamily === 'posix' && !surface.recoverableRm && isRmCommand(surface.command)));
}
function checkResolvedWindowsPaths(input, scan) {
    const native = collectNativeDeleteTargets(input, scan.writeSurfaces);
    if (native.reason)
        return native.reason;
    const cwdReason = checkCwdChangedTargets(input.toolName, scan);
    if (cwdReason)
        return cwdReason;
    const targets = [...collectWindowsAbsoluteTargets(scan.values), ...native.targets];
    if (scan.recursiveSurfaces.length === 0) {
        return checkProtectedWindowsTargets(input.toolName, targets);
    }
    const workspaceDir = input.workspaceDir;
    if (!workspaceDir) {
        return `Local hard safety policy blocked ${input.toolName}: recursive write/delete target cannot be verified because the workspace is unavailable.`;
    }
    const recursive = scan.recursiveSurfaces.map((surface) => resolveWindowsTargets(readWindowsWriteTargets(surface.command, surface.shellFamily, surface.recoverableRm), surface.cwdChanged ? undefined : workspaceDir));
    const resolvedTargets = recursive.flatMap((result) => result.resolved);
    return (checkProtectedWindowsTargets(input.toolName, [...targets, ...resolvedTargets]) ??
        checkRecursiveWindowsTargets({
            toolName: input.toolName,
            workspaceDir,
            resolvedTargets,
            hasDynamicTarget: recursive.some((result) => result.hasDynamicTarget),
        }));
}
/**
 * Delete operands cannot fall back to copy's last positional destination:
 * a trailing option value (for example `-ErrorAction Stop`) is not a target.
 * Unknown syntax or shell must remain fail-closed even without -Recurse.
 */
function collectNativeDeleteTargets(input, surfaces) {
    const targets = [];
    for (const surface of surfaces) {
        if (surface.recoverableRm || !isNativeDeleteSurface(surface))
            continue;
        const resolved = resolveNativeDeleteSurface(input, surface);
        if (typeof resolved === 'string')
            return { reason: resolved, targets };
        targets.push(...resolved);
    }
    return { targets };
}
function resolveNativeDeleteSurface(input, surface) {
    const nativeDelete = parseWindowsDeleteTargets(surface.command, surface.shellFamily);
    if (!nativeDelete) {
        return `Local hard safety policy blocked ${input.toolName}: native delete targets cannot be verified safely. Use literal targets with supported delete options.`;
    }
    const resolved = resolveWindowsTargets(nativeDelete.targets, surface.cwdChanged ? undefined : input.workspaceDir);
    if (resolved.hasDynamicTarget) {
        return `Local hard safety policy blocked ${input.toolName}: native delete targets cannot be verified safely because the workspace or command working directory is unavailable.`;
    }
    if (nativeDelete.recursive &&
        resolved.resolved.some((target) => normalizeWindowsPath(target) === normalizeWindowsPath(homedir()))) {
        return HOME_DELETE_REASON;
    }
    return resolved.resolved;
}
function checkCwdChangedTargets(toolName, scan) {
    const unresolvedWrite = scan.writeSurfaces.some((surface) => surface.cwdChanged &&
        resolveWindowsTargets(readWindowsPathSafetyTargets(surface.command, surface.shellFamily, surface.recoverableRm), undefined).hasDynamicTarget);
    const unresolvedRedirect = scan.surfaces.some((surface) => surface.cwdChanged &&
        resolveWindowsTargets(surface.redirectionTargets, undefined).hasDynamicTarget);
    return unresolvedWrite || unresolvedRedirect
        ? `Local hard safety policy blocked ${toolName}: write/delete targets cannot be verified safely after a command working directory change.`
        : undefined;
}
function checkWindowsPathSpellings(toolName, scan) {
    const protectedPath = scan.values.map(findProtectedWindowsPath).find(Boolean);
    if (protectedPath)
        return protectedWindowsPathReason(toolName, protectedPath);
    const ambiguous = scan.writeSurfaces
        .map((surface) => findAmbiguousProgramFilesWriteTarget(surface.command))
        .find(Boolean);
    if (ambiguous)
        return protectedWindowsPathReason(toolName, ambiguous);
    const driveRelative = scan.values.map(findDriveRelativeWindowsPath).find(Boolean);
    return driveRelative ? driveRelativePathReason(toolName, driveRelative) : undefined;
}
function collectWindowsAbsoluteTargets(values) {
    return values
        .flatMap((value) => value.match(/(?:\\\\\?\\)?[A-Za-z]:[\\/][^\s"';&|<>]*/gi) ?? [])
        .map(canonicalizeWindowsAbsolutePath);
}
function checkRecursiveWindowsTargets(input) {
    const { workspaceDir, resolvedTargets, hasDynamicTarget } = input;
    if (hasDynamicTarget) {
        return `Local hard safety policy blocked ${input.toolName}: recursive write/delete target cannot be verified inside the workspace "${workspaceDir}".`;
    }
    const workspace = normalizeWindowsPath(workspaceDir);
    const outside = resolvedTargets.find((target) => {
        const normalized = normalizeWindowsPath(target);
        return normalized !== workspace && !normalized.startsWith(`${workspace}/`);
    });
    return outside
        ? `Local hard safety policy blocked ${input.toolName}: recursive write/delete target "${outside.trim()}" is outside the workspace "${workspaceDir}".`
        : undefined;
}
function checkProtectedWindowsTargets(toolName, targets) {
    for (const target of targets) {
        const normalized = normalizeWindowsPath(target);
        if (/^[a-z]:\/?$/i.test(normalized) ||
            /^[a-z]:\/(?:windows|program files(?: \(x86\))?)(?:\/|$)/i.test(normalized)) {
            return protectedWindowsPathReason(toolName, target.trim());
        }
    }
    return undefined;
}
/**
 * Native deletion keeps the shell's own syntax. Deny only operands positively
 * identified as a drive root, a protected Windows directory or, for a recursive
 * delete, the home directory. Unresolved operands, cwd changes and targets
 * outside the workspace are left to ordinary permissions, rules and sandbox.
 */
function checkNativeDeleteTargets(input, surfaces) {
    for (const surface of surfaces) {
        // A shape the reader cannot bind is no verdict, never a denial.
        const operands = readNativeDeleteOperands(surface);
        if (!operands)
            continue;
        // Variables follow the executing shell; literal paths are checked once resolved.
        const protectedSpelling = operands.targets.find(isNativeProtectedReference);
        if (protectedSpelling) {
            return protectedWindowsPathReason(input.toolName, protectedSpelling.value);
        }
        const context = {
            recursive: operands.recursive,
            workspaceDir: surface.cwdChanged ? undefined : input.workspaceDir,
            posix: surface.shellFamily === 'posix',
        };
        for (const target of operands.targets) {
            const reason = checkNativeDeleteOperand(input.toolName, target, context);
            if (reason)
                return reason;
        }
    }
    return undefined;
}
function checkNativeDeleteOperand(toolName, target, context) {
    // `X\*` removes X's contents, which is as destructive as removing X itself.
    const operand = target.value.replace(/([\\/])\*(?:\.\*)?$/, '$1');
    if (context.recursive && isNativeHomeReference({ ...target, value: operand })) {
        return HOME_DELETE_REASON;
    }
    // A drive-relative `C:name` depends on per-drive cwd state; it is not a proven target.
    if (/^[a-z]:(?![\\/])/i.test(operand))
        return undefined;
    const msysDrive = context.posix ? /^\/([a-z])(?=\/|$)/i.exec(operand) : null;
    const windowsOperand = msysDrive ? `${msysDrive[1]}:\\${operand.slice(2)}` : operand;
    const [resolved] = resolveWindowsTargets([windowsOperand], context.workspaceDir).resolved;
    if (!resolved)
        return undefined;
    if (context.recursive && normalizeWindowsPath(resolved) === normalizeWindowsPath(homedir())) {
        return HOME_DELETE_REASON;
    }
    return checkProtectedWindowsTargets(toolName, [resolved]);
}
function protectedWindowsPathReason(toolName, value) {
    return `Local hard safety policy blocked ${toolName}: protected Windows path "${value}" cannot be written or deleted.`;
}
function driveRelativePathReason(toolName, value) {
    return `Local hard safety policy blocked ${toolName}: protected Windows path "${value}" cannot be written or deleted because drive-relative paths cannot be verified safely.`;
}
function normalizeWindowsPath(value) {
    const normalized = canonicalizeWindowsAbsolutePath(value)
        .trim()
        .replaceAll('\\', '/')
        .toLowerCase();
    return normalized.length > 3 ? normalized.replace(/\/$/, '') : normalized;
}
function canonicalizeWindowsAbsolutePath(value) {
    const unquoted = value
        .trim()
        .replace(/^\\?["']|["']$/g, '')
        .replace(/^\\\\\?\\/i, '');
    return path.win32.isAbsolute(unquoted) ? path.win32.normalize(unquoted) : unquoted;
}
export function evaluateWindowsPathSafetyCheck(input) {
    const reason = buildWindowsPathSafetyDenyReason(input);
    return reason ? { behavior: 'deny', reason, denyKind: 'bypass-immune' } : undefined;
}
//# sourceMappingURL=path-safety.js.map