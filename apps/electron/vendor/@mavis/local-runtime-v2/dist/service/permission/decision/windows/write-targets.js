/**
 * Windows write/delete target readers. Every reader returns `undefined` for a
 * shape it cannot prove, so callers fail closed instead of treating an
 * unrecognized operand as an in-workspace target.
 */
import path from 'node:path';
import { isRmCommand, parseRmTargets, parseScriptPlainCommands, parseWindowsNativeDelete, } from '@mavis/permission';
import { expandWindowsCommandSurfacesWithShell, normalizeWindowsProgramName, tokenizeWindowsCommand, } from './command-surfaces.js';
function matchesAny(...patterns) {
    return (arg) => patterns.some((pattern) => pattern.test(arg));
}
const WINDOWS_NATIVE_DELETE_COMMANDS = new Set([
    'del',
    'erase',
    'rd',
    'rmdir',
    'remove-item',
    'ri',
    'remove',
]);
const WINDOWS_WRITE_OR_DELETE_COMMANDS = new Set([
    ...WINDOWS_NATIVE_DELETE_COMMANDS,
    'ac',
    'add-content',
    'cp',
    'copy',
    'copy-item',
    'mavis-trash',
    'md',
    'move',
    'move-item',
    'mv',
    'mkdir',
    'new-item',
    'ni',
    'out-file',
    'rm',
    'robocopy',
    'sc',
    'set-content',
    'set-item',
    'si',
    'shred',
    'unlink',
    'xcopy',
]);
/** Every resolved shell may run a native rm; only the recoverable rewrite is exempt. */
const NATIVE_RM_SHELL_FAMILIES = new Set([
    'posix',
    'powershell',
    'cmd',
    'unknown',
]);
const WINDOWS_MOVE_COMMANDS = new Set(['move', 'mv', 'move-item']);
const WINDOWS_COPY_OR_MOVE_COMMANDS = new Set([
    'copy',
    'xcopy',
    'robocopy',
    'cp',
    'copy-item',
    'move',
    'mv',
    'move-item',
]);
const RECURSIVE_WRITE_ARGUMENTS = new Map([
    ['rm', matchesAny(/^-\S*r/i)],
    ['rmdir', matchesAny(/^\/s$/i)],
    ['rd', matchesAny(/^\/s$/i)],
    ['remove-item', matchesAny(/^(?:-recurse|-r)$/i)],
    ['ri', matchesAny(/^(?:-recurse|-r)$/i)],
    ['remove', matchesAny(/^(?:-recurse|-r)$/i)],
    ['mavis-trash', matchesAny(/^-\S*r\S*$/i, /^--recursive$/i)],
    ['xcopy', matchesAny(/^\/(?:e|s|t)$/i)],
    ['robocopy', matchesAny(/^\/(?:e|s|mir|purge|move|mov)$/i)],
    ['cp', matchesAny(/^-[A-Za-z]*[rR][A-Za-z]*$/, /^(?:--recursive|-recurse)$/i)],
    ['copy-item', matchesAny(/^-[A-Za-z]*[rR][A-Za-z]*$/, /^(?:--recursive|-recurse)$/i)],
]);
/**
 * PowerShell resolves del/erase/rd/rmdir to Remove-Item, so recursion is
 * -Recurse there; `/s` is kept as a conservative signal.
 */
const POWERSHELL_NATIVE_RECURSIVE_ARGUMENT = matchesAny(/^(?:-recurse|-r|\/s)$/i);
const NATIVE_OPERAND_COMMANDS = new Set(['mkdir', 'md', 'unlink', 'shred']);
const POWERSHELL_WRITE_COMMANDS = new Set([
    'mkdir',
    'md',
    'new-item',
    'ni',
    'set-content',
    'sc',
    'add-content',
    'ac',
    'set-item',
    'si',
    'out-file',
]);
const POWERSHELL_POSITIONAL_VALUE_COMMANDS = new Set([
    'set-content',
    'sc',
    'add-content',
    'ac',
    'set-item',
    'si',
]);
export function isWindowsCopyOption(token) {
    return token.startsWith('/') || token.startsWith('-');
}
export function isRecursiveWindowsWriteCommand(command, shellFamily) {
    const [program, ...args] = tokenizeWindowsCommand(command, shellFamily);
    if (!program)
        return false;
    const name = normalizeWindowsProgramName(program);
    if (WINDOWS_MOVE_COMMANDS.has(name))
        return true;
    const recursiveArgument = shellFamily === 'powershell' && WINDOWS_NATIVE_DELETE_COMMANDS.has(name)
        ? POWERSHELL_NATIVE_RECURSIVE_ARGUMENT
        : RECURSIVE_WRITE_ARGUMENTS.get(name);
    return recursiveArgument !== undefined && args.some(recursiveArgument);
}
export function isWindowsWriteOrDeleteCommand(command, shellFamily) {
    const [program] = tokenizeWindowsCommand(command, shellFamily);
    return !!program && WINDOWS_WRITE_OR_DELETE_COMMANDS.has(normalizeWindowsProgramName(program));
}
export function hasWindowsWriteOrDeleteCommand(command, shellFamily) {
    return expandWindowsCommandSurfacesWithShell(command, { shellFamily }).some((surface) => isWindowsWriteOrDeleteCommand(surface.command, surface.shellFamily));
}
/** A native delete surface needs proven targets; the recoverable rm rewrite is checked elsewhere. */
export function isNativeDeleteSurface(surface) {
    const [program] = tokenizeWindowsCommand(surface.command, surface.shellFamily);
    if (!program)
        return false;
    const name = normalizeWindowsProgramName(program);
    return (WINDOWS_NATIVE_DELETE_COMMANDS.has(name) ||
        (name === 'rm' && NATIVE_RM_SHELL_FAMILIES.has(surface.shellFamily)));
}
export function resolveWindowsTargets(rawTargets, workspaceDir) {
    if (!rawTargets)
        return { resolved: [], hasDynamicTarget: true };
    const resolved = [];
    let hasDynamicTarget = false;
    const workspace = workspaceDir && /^[A-Za-z]:[\\/]/.test(workspaceDir) ? workspaceDir : undefined;
    for (const rawTarget of rawTargets) {
        const target = resolveWindowsTarget(rawTarget, workspace);
        if (target === undefined)
            hasDynamicTarget = true;
        else
            resolved.push(target);
    }
    return { resolved, hasDynamicTarget };
}
function resolveWindowsTarget(rawTarget, workspace) {
    if (/[%$*?`]/.test(rawTarget) || /^~/.test(rawTarget))
        return undefined;
    // A rooted path such as `\Windows` still depends on the current drive.
    // Never let win32.resolve use the host process cwd as an implicit fallback.
    if (/^(?:[A-Za-z]:[\\/]|\\\\)/.test(rawTarget))
        return path.win32.normalize(rawTarget);
    return workspace ? path.win32.resolve(workspace, rawTarget) : undefined;
}
/** Parse deletion using the executing shell, before applying Windows path policy. */
export function parseWindowsDeleteTargets(command, shellFamily) {
    // CMD can execute a native rm.exe from PATH. Reuse the same Windows argv
    // parsing as the write-target check so home protection sees those operands too.
    if (shellFamily === 'cmd' && isRmCommand(command)) {
        const targets = parseRmTargets(command, 'win32');
        return targets.length > 0
            ? { targets, recursive: isRecursiveWindowsWriteCommand(command, shellFamily) }
            : undefined;
    }
    if (shellFamily !== 'posix') {
        return parseWindowsNativeDelete(command, shellFamily === 'cmd' || shellFamily === 'powershell' ? shellFamily : undefined);
    }
    return parsePosixRmTargets(command);
}
function parsePosixRmTargets(command) {
    if (!isRmCommand(command))
        return undefined;
    // The shared rm parser has Windows backslash preservation, and the static
    // tokenizer does not model every double-quoted POSIX escape. Refuse these
    // spellings instead of checking a different target from the executed argv.
    if (command.includes('\\') || parseScriptPlainCommands(command)?.length !== 1)
        return undefined;
    const targets = parseRmTargets(command, 'linux');
    if (targets.length === 0 || targets.some(isUnprovenPosixTarget))
        return undefined;
    return { targets, recursive: isRecursiveWindowsWriteCommand(command, 'posix') };
}
/**
 * Git Bash/MSYS mount roots (/c, /usr, ...) are not current-drive roots.
 * Without the executor's mount mapping, no POSIX absolute path is proven.
 * Residual quotes mean rm's Windows-path preservation kept source text
 * such as C:/Win"dows" instead of the POSIX argv. Do not trust that path.
 */
function isUnprovenPosixTarget(target) {
    return path.posix.isAbsolute(target) || /[[\]{}*?"']/.test(target) || /^~/.test(target);
}
/**
 * Return the targets that a write/delete command mutates.
 * An unrecognized shape deliberately returns undefined so the caller fails
 * closed instead of treating the command as an in-workspace operation.
 */
export function readWindowsWriteTargets(command, shellFamily, recoverableRm) {
    const nativeDelete = parseWindowsDeleteTargets(command, shellFamily);
    if (nativeDelete)
        return nativeDelete.targets;
    const rm = readWindowsRmTargets(command, shellFamily, recoverableRm);
    if (rm.decided)
        return rm.targets;
    const trashTargets = parseDirectTrashTargets(command);
    if (trashTargets.length > 0)
        return trashTargets;
    const [program, ...args] = tokenizeWindowsCommand(command, shellFamily);
    if (!program)
        return undefined;
    const name = normalizeWindowsProgramName(program);
    return WINDOWS_COPY_OR_MOVE_COMMANDS.has(name)
        ? readWindowsCopyTargets(program, args)
        : readWindowsSimpleWriteTargets(name, args, shellFamily);
}
/** Decide rm here unless PowerShell/unknown syntax falls through to the generic readers. */
function readWindowsRmTargets(command, shellFamily, recoverableRm) {
    if (!isRmCommand(command))
        return { decided: false };
    if (shellFamily === 'posix' && !recoverableRm)
        return { decided: true };
    if (recoverableRm || shellFamily === 'cmd' || shellFamily === undefined) {
        return { decided: true, targets: parseRmTargets(command, 'win32') };
    }
    return { decided: false };
}
function parseDirectTrashTargets(command) {
    const [program, ...tokens] = tokenizeWindowsCommand(command);
    if (!program || normalizeWindowsProgramName(program) !== 'mavis-trash')
        return [];
    const targets = [];
    let pastDoubleDash = false;
    for (const token of tokens) {
        if (!pastDoubleDash && token === '--') {
            pastDoubleDash = true;
            continue;
        }
        if (!pastDoubleDash && token.startsWith('-'))
            continue;
        targets.push(token);
    }
    return targets;
}
/** Literal operand forms of directory creation and PowerShell content/item writes. */
function readWindowsSimpleWriteTargets(name, args, shellFamily) {
    // Do not interpret expansions, arrays, escaped/concatenated quotes, or unknown
    // options as a literal path. The caller keeps its existing fail-closed result.
    if (args.length === 0 || args.some((arg) => /[%!$`*?[\]^{}(),"']/.test(arg)))
        return undefined;
    if (NATIVE_OPERAND_COMMANDS.has(name) && shellFamily !== 'powershell') {
        return readNativeOperandTargets(args, shellFamily);
    }
    if (shellFamily !== 'powershell' || !POWERSHELL_WRITE_COMMANDS.has(name))
        return undefined;
    return readPowerShellWriteTargets(name, args);
}
function readNativeOperandTargets(args, shellFamily) {
    if (shellFamily === 'unknown')
        return undefined;
    const delimiter = shellFamily === 'posix' ? args.indexOf('--') : -1;
    const options = delimiter < 0 ? args : args.slice(0, delimiter);
    const targets = [];
    for (const arg of options) {
        if (!/^[-/]/.test(arg)) {
            targets.push(arg);
            continue;
        }
        if (!isSupportedNativeOperandOption(arg, shellFamily))
            return undefined;
    }
    if (delimiter >= 0)
        targets.push(...args.slice(delimiter + 1));
    return targets.length > 0 ? targets : undefined;
}
function isSupportedNativeOperandOption(arg, shellFamily) {
    return shellFamily === 'posix' && /^(?:-[pfuvz]+|--parents|--verbose|--zero|--remove)$/.test(arg);
}
function readPowerShellWriteTargets(name, args) {
    const operands = readPowerShellWriteOperands(args);
    if (!operands || operands.paths.length > 1)
        return undefined;
    const { positional } = operands;
    const target = operands.paths[0] ?? positional.shift();
    if (!target)
        return undefined;
    // Content/item cmdlets can take one positional value after their path. mkdir
    // accepts only paths; keep every one so relative siblings cannot disappear.
    if (name === 'mkdir' || name === 'md')
        return [target, ...positional];
    return positional.length > allowedPositionalValues(name, operands.hasValue)
        ? undefined
        : [target];
}
function allowedPositionalValues(name, hasValue) {
    return !hasValue && POWERSHELL_POSITIONAL_VALUE_COMMANDS.has(name) ? 1 : 0;
}
function readPowerShellWriteOperands(args) {
    const operands = { paths: [], positional: [], hasValue: false };
    for (let index = 0; index < args.length; index += 1) {
        const consumed = readPowerShellArgument(operands, args[index] ?? '', args[index + 1]);
        if (consumed === undefined)
            return undefined;
        index += consumed;
    }
    return operands;
}
/** Returns how many following arguments an option consumed, or undefined for unsupported syntax. */
function readPowerShellArgument(operands, arg, next) {
    const kind = classifyPowerShellArgument(arg);
    if (kind === 'positional') {
        operands.positional.push(arg);
        return 0;
    }
    if (kind === 'switch')
        return 0;
    if (!kind || !next || next.startsWith('-'))
        return undefined;
    if (kind === 'path')
        operands.paths.push(next);
    if (kind === 'value')
        operands.hasValue = true;
    return 1;
}
function classifyPowerShellArgument(arg) {
    if (!arg.startsWith('-'))
        return 'positional';
    if (/^-(?:force|append|noclobber|nonewline|verbose|debug|whatif|confirm)$/i.test(arg)) {
        return 'switch';
    }
    if (/^-(?:path|literalpath|filepath)$/i.test(arg))
        return 'path';
    if (/^-(?:value|inputobject)$/i.test(arg))
        return 'value';
    if (/^-(?:itemtype|encoding|width|erroraction|warningaction)$/i.test(arg))
        return 'other';
    return undefined;
}
function readWindowsCopyTargets(program, args) {
    const name = normalizeWindowsProgramName(program);
    const explicitDestination = readExplicitWindowsDestination(program, args);
    if (explicitDestination.explicit) {
        return explicitDestination.destination ? [explicitDestination.destination] : undefined;
    }
    const positional = args.filter((arg) => !isWindowsCopyOption(arg));
    if (positional.length < 2)
        return undefined;
    // xcopy / robocopy accept exactly one source followed by one destination.
    // cp / mv and PowerShell copy/move accept multiple sources, so the final
    // positional argument is the only reliable write target.
    const destination = ['xcopy', 'robocopy'].includes(name) ? positional.at(1) : positional.at(-1);
    return destination ? [destination] : undefined;
}
function readWindowsMoveSourceTargets(command) {
    const [program, ...args] = tokenizeWindowsCommand(command);
    if (!program)
        return undefined;
    const name = normalizeWindowsProgramName(program);
    if (!isWindowsMoveCommand(name, args))
        return [];
    const explicitDestination = readExplicitWindowsDestination(program, args);
    const positional = readWindowsMovePositionals(name, args);
    if (name === 'robocopy')
        return positional[0] ? [positional[0]] : undefined;
    if (explicitDestination.explicit)
        return positional.length > 0 ? positional : undefined;
    return positional.length >= 2 ? positional.slice(0, -1) : undefined;
}
function isWindowsMoveCommand(name, args) {
    return (WINDOWS_MOVE_COMMANDS.has(name) ||
        (name === 'robocopy' && args.some((arg) => /^\/(?:move|mov)$/i.test(arg))));
}
function readWindowsMovePositionals(name, args) {
    const positional = [];
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        if (arg === undefined)
            continue;
        const skip = windowsMoveOptionSkip(name, arg);
        if (skip === 'consume-next') {
            index += 1;
            continue;
        }
        if (skip === 'skip')
            continue;
        positional.push(arg);
    }
    return positional;
}
function windowsMoveOptionSkip(name, arg) {
    if (name === 'mv' && ['-t', '--target-directory'].includes(arg))
        return 'consume-next';
    if (name === 'mv' && /^(?:-t(?:=)?|--target-directory=)/i.test(arg))
        return 'skip';
    if (name === 'move-item' && /^-destination$/i.test(arg))
        return 'consume-next';
    if (name === 'move-item' && /^-destination(?::|=)/i.test(arg))
        return 'skip';
    return isWindowsCopyOption(arg) ? 'skip' : undefined;
}
/**
 * A move deletes its source after producing its destination. Copy permits a
 * protected source to be read into the workspace, but move/robocopy /MOVE
 * must protect both sides of the operation.
 */
export function readWindowsPathSafetyTargets(command, shellFamily, recoverableRm) {
    const writeTargets = readWindowsWriteTargets(command, shellFamily, recoverableRm);
    if (!writeTargets)
        return undefined;
    const moveSourceTargets = readWindowsMoveSourceTargets(command);
    if (moveSourceTargets === undefined)
        return undefined;
    return [...writeTargets, ...moveSourceTargets];
}
/**
 * Read copy/move destination flags before falling back to a positional
 * destination. A missing or malformed explicit destination deliberately
 * returns `undefined` to the caller so the recursive write is fail-closed.
 */
function readExplicitWindowsDestination(program, args) {
    const name = normalizeWindowsProgramName(program);
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        if (!arg)
            continue;
        const destination = readExplicitWindowsDestinationAt(name, arg, args[index + 1]);
        if (destination)
            return destination;
    }
    return { explicit: false };
}
function explicitWindowsDestination(nextArg) {
    return {
        explicit: true,
        ...(nextArg && !isWindowsCopyOption(nextArg) ? { destination: nextArg } : {}),
    };
}
function readExplicitWindowsDestinationAt(name, arg, nextArg) {
    if (['cp', 'mv'].includes(name)) {
        if (arg === '-t' || arg === '--target-directory') {
            return explicitWindowsDestination(nextArg);
        }
        const shortTarget = /^-t(?:=)?(.+)$/.exec(arg);
        const longTarget = /^--target-directory=(.+)$/i.exec(arg);
        const destination = shortTarget?.[1] ?? longTarget?.[1];
        if (destination !== undefined)
            return { explicit: true, destination };
    }
    if (['copy-item', 'move-item'].includes(name)) {
        if (/^-destination$/i.test(arg)) {
            return explicitWindowsDestination(nextArg);
        }
        const inlineDestination = /^-destination(?::|=)(.+)$/i.exec(arg)?.[1];
        if (inlineDestination !== undefined)
            return { explicit: true, destination: inlineDestination };
    }
    return undefined;
}
//# sourceMappingURL=write-targets.js.map