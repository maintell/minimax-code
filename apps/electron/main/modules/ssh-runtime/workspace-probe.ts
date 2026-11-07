import { sshExecution } from "./ssh-execution.js";
import { sshOperationStatus } from "./errors.js";
import { isSafeAbsoluteRemotePath } from "./config";
import { classifySshFailure } from "./errors";
import { startSshPerfSpan } from "./perf";
import { buildSshExecArgs, quoteRemoteShellArg } from "./ssh-command";
const WORKSPACE_PROBE_MARKER = '__MCODE_SSH_WORKSPACE_V1__';
export async function probeSshWorkspace(connection, workspaceDir, runCommand, options = {}) {
    if (!isSafeAbsoluteRemotePath(workspaceDir)) {
        return { status: 'probe_failed' };
    }
    const span = startSshPerfSpan('ssh-exec.workspace-probe', {
        lane: 'ssh-exec',
        alias: connection.alias,
    });
    try {
        const result = await (runCommand ??
            ((_command, args) => sshExecution.run(connection.endpoint, args[args.length - 1], {
                maxOutputBytes: 64 * 1024,
                ...options,
            })))('ssh', buildSshExecArgs(connection.endpoint, '-T', buildRemoteWorkspaceProbeCommand(workspaceDir)));
        span.end({ outcome: 'ok' });
        return parseWorkspaceProbeOutput(result.stdout);
    }
    catch (error) {
        span.end({ outcome: 'error' });
        const status = sshOperationStatus(error);
        if (status)
            return { status };
        if (hasErrorCode(error, 'ENOENT'))
            return { status: 'ssh_not_found' };
        if (isTimedOut(error))
            return { status: 'unreachable' };
        const classified = classifySshFailure(readStderr(error), false);
        switch (classified.code) {
            case 'ssh_auth_failed':
                return { status: 'auth_failed' };
            case 'ssh_host_key_untrusted':
                return { status: 'host_key_untrusted' };
            case 'ssh_host_unreachable':
                return { status: 'unreachable' };
            default:
                return { status: 'probe_failed' };
        }
    }
}
export function buildRemoteWorkspaceProbeCommand(workspaceDir) {
    const quotedPath = quoteRemoteShellArg(workspaceDir);
    return [
        `printf '${WORKSPACE_PROBE_MARKER}\\n'`,
        `if CDPATH= cd ${quotedPath} 2>/dev/null`,
        `then printf 'status=ready\\n'; printf 'workspace=%s\\n' "$(pwd -P)"`,
        `else printf 'status=workspace_not_found\\n'`,
        'fi',
    ].join('; ');
}
export function parseWorkspaceProbeOutput(output) {
    const markerIndex = output.indexOf(WORKSPACE_PROBE_MARKER);
    if (markerIndex < 0)
        return { status: 'probe_failed' };
    const values = new Map();
    for (const line of output.slice(markerIndex + WORKSPACE_PROBE_MARKER.length).split(/\r?\n/u)) {
        const separator = line.indexOf('=');
        if (separator <= 0)
            continue;
        const key = line.slice(0, separator);
        if (!values.has(key))
            values.set(key, line.slice(separator + 1));
    }
    if (values.get('status') === 'workspace_not_found') {
        return { status: 'workspace_not_found' };
    }
    const canonicalPath = values.get('workspace');
    if (values.get('status') !== 'ready' || !canonicalPath)
        return { status: 'probe_failed' };
    if (!isSafeAbsoluteRemotePath(canonicalPath))
        return { status: 'probe_failed' };
    return { status: 'ready', workspaceDir: canonicalPath };
}
function readStderr(error) {
    return error && typeof error === 'object' && 'stderr' in error && typeof error.stderr === 'string'
        ? error.stderr
        : '';
}
function hasErrorCode(error, code) {
    return Boolean(error && typeof error === 'object' && 'code' in error && error.code === code);
}
function isTimedOut(error) {
    return Boolean(error && typeof error === 'object' && 'killed' in error && error.killed === true);
}
