/**
 * Runtime-boundary deletion and path safety. These checks run before any
 * permission-mode shortcut, so `off`, bypass, persisted rules and user
 * approval cannot authorize an unrecoverable delete or a protected-path write.
 */
import path from 'node:path';
import { parseWindowsNativeDelete } from '@mavis/permission';
import { inspectTrashRuntime, isGitBashTrashLauncherTrusted, } from '../../../infra/process/ensure-trash-script.js';
import { inspectAndRepairWindowsTrashRuntime } from '../../../infra/process/repair-windows-trash-runtime.js';
import { evaluateLocalPermissionCheck, evaluateWindowsPathSafetyCheck } from './checkers.js';
import { findWindowsDeleteReason, resolveWindowsShellFamily, isRecoverableDeleteInsideWorkspace, isDeleteLikeCommand, commandContainsRmSegment, hasPosixSubstitutionDelete, hasUntrustedMavisTrashExecutable, everyDeleteSegmentIsSafelyRewritable, needsWindowsPathSafetyCheck, } from './windows/delete-policy.js';
/** Shell facts every local checker call of one permission request shares. */
export function runtimeCheckerShell(hostShellFamily, params, nativeDelete) {
    const bash = params.toolName === 'bash';
    return {
        shellFamily: params.trustedShellFamily ?? hostShellFamily ?? (nativeDelete ? 'unknown' : undefined),
        recoverableRm: !nativeDelete && bash,
        trustedShellFamily: params.trustedShellFamily,
        nativeDelete: nativeDelete && bash,
    };
}
/** Deletes always go through the engine so they can be rewritten to the trash launcher. */
export function needsDeleteRewrite(request) {
    const { params, platform, command, nativeDelete } = request;
    if (nativeDelete || command === undefined)
        return false;
    if (platform === 'win32')
        return isDeleteLikeCommand(command, params.trustedShellFamily === 'posix');
    return ['darwin', 'linux'].includes(platform) && commandContainsRmSegment(command);
}
function windowsHardSafetyContext(recoverableNativeDelete, workingDirectory) {
    return {
        ...(recoverableNativeDelete ? { recoverableNativeDelete } : {}),
        ...(workingDirectory ? { workingDirectory } : {}),
    };
}
const RECOVERABLE_DELETE_INSTRUCTION = 'Deletion intent detected. Do not bypass this denial with another permanent delete command, wrapper, script, or filesystem API. ' +
    'Retry only through a simple, top-level recoverable deletion that the runtime can route through its trusted mavis-trash launcher.';
const UNAVAILABLE_TRASH_INSTRUCTION = 'Deletion intent detected. The target was not deleted. Do not fall back to any permanent delete command, wrapper, script, or filesystem API. ' +
    'Re-check mavis-trash availability before retrying and use only the trusted local-runtime launcher. ' +
    'If mavis-trash remains unavailable, tell the user that the target must be removed manually.';
function safetyDenial(reason) {
    return { denial: { behavior: 'deny', reason, denySource: 'safety-immune' } };
}
/**
 * Delete-like commands must reach a healthy, trusted mavis-trash launcher and
 * stay rewritable. The opt-out never skips these checks: they are what keeps
 * an allowed delete recoverable. A Git Bash session additionally requires its
 * own launcher to hold the exact bundled bytes.
 */
function evaluateWindowsTrashDelete(deps, command, shell) {
    const dataDir = deps.configGetter().dataDir;
    const trash = inspectAndRepairWindowsTrashRuntime(dataDir, deps.trashRuntimeProbe);
    if (!trash.available || (shell.posix && !isGitBashTrashLauncherTrusted(dataDir))) {
        const unavailableReason = trash.available
            ? 'Git Bash launcher missing or changed'
            : trash.reason;
        return safetyDenial(`Local hard safety policy blocked deletion: the Windows mavis-trash launcher is unavailable (${unavailableReason}). The agent must not fall back to a permanent delete command. ${UNAVAILABLE_TRASH_INSTRUCTION}`);
    }
    const launcherPath = path.win32.join(dataDir, 'bin', shell.posix ? 'mavis-trash' : 'mavis-trash.cmd');
    if (hasUntrustedMavisTrashExecutable(command, launcherPath, shell.posix)) {
        return safetyDenial(`Local hard safety policy blocked deletion: bare or non-canonical mavis-trash is untrusted because PATH/CWD may select a different executable. The target was not deleted. Retry with one top-level rm command; the runtime will use the trusted launcher at "${launcherPath}". Do not bypass this with a permanent delete command, wrapper, script, or filesystem API.`);
    }
    if (!everyDeleteSegmentIsSafelyRewritable(command, launcherPath, shell.family, shell.posix)) {
        return safetyDenial(`Local hard safety policy blocked a wrapped or compound Windows delete command that cannot be safely rewritten. Use the trusted local-runtime mavis-trash launcher for recoverable removal. ${RECOVERABLE_DELETE_INSTRUCTION}`);
    }
    return undefined;
}
/**
 * A bare native delete runs in the host executor shell. A trusted POSIX
 * session never lends that CMD/PowerShell family to its own commands.
 */
function hostDeleteShell(deps, params) {
    return params.trustedShellFamily === 'posix'
        ? undefined
        : (params.trustedShellFamily ?? deps.shellFamily);
}
/**
 * Runtime-boundary Windows safety net. It runs before permission mode handling,
 * so `off`, bypass, persisted rules and user approval cannot bypass it.
 * The startup opt-out skips broad command/path checks. While native deletion
 * is disabled, trash health/trust checks and recoverable-delete metadata remain.
 */
function evaluateWindowsDeleteSafety(deps, request) {
    const { command, params, nativeDelete, skipWindowsHardSafetyChecks } = request;
    // Path safety parses targets independently; only recoverable mode needs a rewrite.
    if (!command || nativeDelete)
        return {};
    const posix = params.trustedShellFamily === 'posix';
    if (posix && hasPosixSubstitutionDelete(command)) {
        return safetyDenial(`Local hard safety policy blocked deletion inside a Bash substitution. ${RECOVERABLE_DELETE_INSTRUCTION}`);
    }
    const shellFamily = resolveWindowsShellFamily(command, hostDeleteShell(deps, params));
    const recoverableNativeDelete = parseWindowsNativeDelete(command, shellFamily);
    const permanentDeleteReason = skipWindowsHardSafetyChecks
        ? undefined
        : findWindowsDeleteReason(command, Boolean(recoverableNativeDelete));
    if (permanentDeleteReason) {
        return safetyDenial(`Local hard safety policy blocked ${params.toolName}: ${permanentDeleteReason}. Use mavis-trash for recoverable removal; permanent Windows delete commands are not allowed. ${RECOVERABLE_DELETE_INSTRUCTION}`);
    }
    if (isDeleteLikeCommand(command, posix)) {
        const trashDenial = evaluateWindowsTrashDelete(deps, command, { family: shellFamily, posix });
        if (trashDenial)
            return trashDenial;
    }
    return { recoverableNativeDelete };
}
/**
 * A trusted POSIX session Shell owns its own path checks, so only a
 * non-POSIX command may skip the path block as "no Windows path policy needed".
 */
function skipsWindowsPathPolicy(deps, request) {
    const { params, command } = request;
    if (command !== undefined && params.trustedShellFamily === 'posix')
        return false;
    return !needsWindowsPathSafetyCheck(params.toolName, params.input, command, params.trustedShellFamily ?? deps.shellFamily);
}
export async function evaluateWindowsHardSafety(deps, request) {
    const { params, platform, skipWindowsHardSafetyChecks } = request;
    if (platform !== 'win32')
        return {};
    const deleteSafety = evaluateWindowsDeleteSafety(deps, request);
    if (deleteSafety.denial)
        return deleteSafety;
    const { recoverableNativeDelete } = deleteSafety;
    // The startup opt-out skips the path block for every shell.
    if (skipWindowsHardSafetyChecks || skipsWindowsPathPolicy(deps, request)) {
        return recoverableNativeDelete ? { recoverableNativeDelete } : {};
    }
    const workingDirectory = await deps.resolveExplicitWorkspaceDirectory(params.sessionId, params.agentName);
    const pathSafety = evaluateWindowsPathSafetyCheck({
        toolName: params.toolName,
        input: params.input,
        workspaceDir: workingDirectory,
        platform,
        ...runtimeCheckerShell(deps.shellFamily, params, request.nativeDelete),
    });
    const recoverableInsideWorkspace = recoverableNativeDelete !== undefined &&
        workingDirectory !== undefined &&
        isRecoverableDeleteInsideWorkspace(recoverableNativeDelete.targets, workingDirectory);
    if (pathSafety && !recoverableInsideWorkspace)
        return safetyDenial(pathSafety.reason);
    return windowsHardSafetyContext(recoverableNativeDelete, workingDirectory);
}
/**
 * Native deletion skips only the recoverable-trash rewrite. Keep shared
 * UNC/root/home safety ahead of the off-mode short-circuit on every host.
 */
export async function evaluateNativeDeleteSafety(deps, request, windowsHardSafety) {
    const { params, platform, skipWindowsHardSafetyChecks } = request;
    const workingDirectory = platform !== 'win32' && windowsHardSafety.workingDirectory === undefined
        ? await deps.resolveWorkingDirectory(params.sessionId, params.agentName)
        : windowsHardSafety.workingDirectory;
    const nativeHardCheck = evaluateLocalPermissionCheck({
        toolName: params.toolName,
        input: params.input,
        workspaceDir: workingDirectory,
        platform,
        skipWindowsHardSafetyChecks,
        ...runtimeCheckerShell(deps.shellFamily, params, true),
    });
    if (nativeHardCheck?.behavior === 'deny' && nativeHardCheck.denyKind === 'bypass-immune') {
        return safetyDenial(nativeHardCheck.reason);
    }
    return {
        ...windowsHardSafety,
        ...(workingDirectory === undefined ? {} : { workingDirectory }),
    };
}
/**
 * POSIX rm relies on the bundled trash script for recoverability. Keep this
 * health boundary ahead of permission-mode shortcuts so deletion cannot
 * silently fall back to an irreversible shell command.
 */
export function evaluatePosixTrashSafety(configGetter, platform, command) {
    if ((platform !== 'darwin' && platform !== 'linux') ||
        command === undefined ||
        !commandContainsRmSegment(command)) {
        return undefined;
    }
    const dataDir = configGetter().dataDir;
    const trash = inspectTrashRuntime(dataDir, platform);
    if (trash.available)
        return undefined;
    const scriptPath = path.join(dataDir, 'bin', 'mavis-trash');
    return {
        behavior: 'deny',
        reason: 'Recoverable deletion is unavailable, so this delete was blocked rather than ' +
            `performed permanently (${trash.reason ?? 'health check failed'}).\n` +
            `Runtime script: ${scriptPath}\n` +
            'How to restore it:\n' +
            `  1. Remove ${scriptPath} and restart the app — startup re-seeds the script.\n` +
            '  2. If it fails again, verify the runtime data directory is writable and not ' +
            'mounted noexec, and that the script keeps its execute bit.\n' +
            "  3. Two app versions sharing one data directory overwrite each other's script; " +
            'close the other version, then restart.',
        denySource: 'safety-immune',
    };
}
//# sourceMappingURL=runtime-safety.js.map