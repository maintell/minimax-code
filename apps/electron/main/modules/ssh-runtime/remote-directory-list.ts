import { sshExecution } from "./ssh-execution.js";
import { sshOperationStatus } from "./errors.js";
import { isSafeAbsoluteRemotePath } from "./config";
import { classifySshFailure } from "./errors";
import { startSshPerfSpan } from "./perf";
import { buildSshExecArgs, quoteRemoteShellArg } from "./ssh-command";
const DIRECTORY_LIST_MARKER = '__MCODE_SSH_DIRECTORY_LIST_V1__';
const MAX_DIRECTORY_ENTRIES = 2000;
/** List one remote directory without mounting or copying it into Desktop. */
export async function listRemoteDirectories(connection, path, runCommand, options = {}) {
    const { alias } = connection;
    if (!isSafeAbsoluteRemotePath(path)) {
        return { alias, path, status: 'probe_failed' };
    }
    const span = startSshPerfSpan('ssh-exec.directory-list', { lane: 'ssh-exec', alias });
    try {
        const result = await (runCommand ??
            ((_command, args) => sshExecution.run(connection.endpoint, args[args.length - 1], options)))('ssh', buildSshExecArgs(connection.endpoint, '-T', buildRemoteDirectoryListCommand(path)));
        span.end({ outcome: 'ok', stdoutBytes: result.stdout.length });
        return parseRemoteDirectoryListOutput(alias, path, result.stdout);
    }
    catch (error) {
        span.end({ outcome: 'error' });
        const status = sshOperationStatus(error);
        if (status)
            return { alias, path, status };
        if (hasErrorCode(error, 'ENOENT'))
            return { alias, path, status: 'ssh_not_found' };
        if (isTimedOut(error))
            return { alias, path, status: 'unreachable' };
        const classified = classifySshFailure(readStderr(error), false);
        switch (classified.code) {
            case 'ssh_auth_failed':
                return { alias, path, status: 'auth_failed' };
            case 'ssh_host_key_untrusted':
                return { alias, path, status: 'host_key_untrusted' };
            case 'ssh_host_unreachable':
                return { alias, path, status: 'unreachable' };
            default:
                return { alias, path, status: 'probe_failed' };
        }
    }
}
export function buildRemoteDirectoryListCommand(path) {
    const quotedPath = quoteRemoteShellArg(path);
    return [
        `printf '${DIRECTORY_LIST_MARKER}\\0'`,
        `if canonical="$(CDPATH= cd ${quotedPath} 2>/dev/null && pwd -P)"`,
        `then printf 'status=ready\\0path=%s\\0' "$canonical"`,
        `for entry in "$canonical"/* "$canonical"/.[!.]* "$canonical"/..?*`,
        `do if [ -d "$entry" ]; then printf '%s\\0' "$entry"; fi; done`,
        `else printf 'status=workspace_not_found\\0'`,
        'fi',
    ].join('; ');
}
export function parseRemoteDirectoryListOutput(alias, requestedPath, output) {
    const markerIndex = output.indexOf(DIRECTORY_LIST_MARKER);
    if (markerIndex < 0)
        return { alias, path: requestedPath, status: 'probe_failed' };
    const fields = output
        .slice(markerIndex + DIRECTORY_LIST_MARKER.length)
        .split('\0')
        .filter(Boolean);
    if (fields[0] === 'status=workspace_not_found') {
        return { alias, path: requestedPath, status: 'workspace_not_found' };
    }
    if (fields[0] !== 'status=ready' || !fields[1]?.startsWith('path=')) {
        return { alias, path: requestedPath, status: 'probe_failed' };
    }
    const canonicalPath = fields[1].slice('path='.length);
    if (!isSafeAbsoluteRemotePath(canonicalPath)) {
        return { alias, path: requestedPath, status: 'probe_failed' };
    }
    const directories = fields
        .slice(2, MAX_DIRECTORY_ENTRIES + 2)
        .filter(isSafeAbsoluteRemotePath)
        .filter((entryPath) => entryPath !== canonicalPath)
        .map((entryPath) => ({
        path: entryPath,
        name: entryPath.slice(entryPath.lastIndexOf('/') + 1),
    }))
        .filter((entry) => entry.name.length > 0)
        .sort((left, right) => left.name.localeCompare(right.name));
    return { alias, path: canonicalPath, status: 'ready', directories };
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
