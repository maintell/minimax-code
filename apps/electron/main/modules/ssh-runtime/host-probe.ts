import { sshExecution } from "./ssh-execution.js";
import { SshRuntimeError, sshOperationStatus } from "./errors.js";
import { isSafeSshHost } from "./config";
import { sshFailureDetails, classifySshFailure } from "./errors";
import { startSshPerfSpan } from "./perf";
import { buildSshExecArgs, buildRemoteProbeCommand } from "./ssh-command";
import { startSshDiagnostic } from "./diagnostics";
const PROBE_MARKER = '__MCODE_SSH_PROBE_V1__';
export async function probeSshHost(connectionValue, options = {}, runCommand) {
    const connection = normalizeConnection(connectionValue);
    const alias = typeof connectionValue === 'string' ? connectionValue : connectionValue.alias;
    if (!connection)
        return { alias, status: 'probe_failed' };
    const span = startSshPerfSpan('ssh-exec.host-probe', { lane: 'ssh-exec', alias });
    const diagnostics = startSshDiagnostic('host-probe', { alias }, options.diagnostics?.id, options.attemptId);
    try {
        const result = await (runCommand ??
            ((_command, args) => sshExecution.run(connection.endpoint, args[args.length - 1], {
                maxOutputBytes: 64 * 1024,
                ...options,
                diagnostics,
                captureDiagnosticOutput: true,
            })))('ssh', buildSshExecArgs(connection.endpoint, '-T', buildRemoteProbeCommand(options.mcodePath, options.requiredMcodeRelativePath, options.requiredMcodePath, options.inspectVersion)));
        span.end({ outcome: 'ok' });
        const probe = parseProbeOutput(alias, result.stdout);
        diagnostics.record('result', {
            status: probe.status,
            mcodePath: probe.mcodePath,
            mcodeVersion: probe.mcodeVersion,
            stdout: result.stdout,
            stderr: result.stderr,
        });
        return probe;
    }
    catch (error) {
        diagnostics.fail(error);
        span.end({ outcome: 'error' });
        if (options.inspectVersion &&
            error &&
            typeof error === 'object' &&
            'commandStarted' in error &&
            error.commandStarted === true) {
            return {
                alias,
                status: 'probe_failed',
                cliFailureReason: 'cli_start_failed',
                failureDetails: sshFailureDetails(error instanceof SshRuntimeError ? error.code : 'remote_mcode_start_failed', {
                    sshVerified: true,
                    stage: 'bootstrap',
                    stderr: readStderr(error),
                    mcodePath: options.requiredMcodePath,
                }),
            };
        }
        const status = sshOperationStatus(error);
        if (status)
            return {
                alias,
                status,
                ...(error instanceof SshRuntimeError ? { reasonCode: error.code } : {}),
            };
        if (hasErrorCode(error, 'ENOENT'))
            return { alias, status: 'ssh_not_found' };
        if (isTimedOut(error))
            return { alias, status: 'unreachable' };
        const classified = error instanceof SshRuntimeError ? error : classifySshFailure(readStderr(error), false);
        const classifiedStatus = (() => {
            switch (classified.code) {
                case 'ssh_auth_failed':
                    return 'auth_failed';
                case 'ssh_host_key_untrusted':
                    return 'host_key_untrusted';
                case 'ssh_host_unreachable':
                    return 'unreachable';
                default:
                    return 'probe_failed';
            }
        })();
        return { alias, status: classifiedStatus, reasonCode: classified.code };
    }
}
function normalizeConnection(value) {
    if (typeof value !== 'string')
        return value;
    const alias = value.trim();
    if (!isSafeSshHost(alias))
        return null;
    return {
        alias,
        displayName: alias,
        endpoint: { kind: 'ssh_config', hostAlias: alias },
        enabled: true,
        createdAtMs: 0,
        updatedAtMs: 0,
    };
}
export function parseProbeOutput(alias, output) {
    const markerIndex = output.indexOf(PROBE_MARKER);
    if (markerIndex < 0)
        return { alias, status: 'probe_failed' };
    const values = new Map();
    for (const line of output.slice(markerIndex + PROBE_MARKER.length).split(/\r?\n/u)) {
        const separator = line.indexOf('=');
        if (separator <= 0)
            continue;
        const key = line.slice(0, separator);
        if (!values.has(key))
            values.set(key, line.slice(separator + 1).trim());
    }
    const mcodePath = values.get('mcode_path') || undefined;
    const mcodePresent = values.get('mcode_present') === '1';
    return {
        alias,
        status: mcodePath
            ? 'ready'
            : values.get('mcode_failed') === '1'
                ? 'probe_failed'
                : mcodePresent
                    ? 'cli_incompatible'
                    : 'cli_missing',
        ...(!mcodePath && values.get('mcode_failed') === '1'
            ? { cliFailureReason: 'cli_start_failed' }
            : {}),
        ...(values.get('hostname') ? { hostname: values.get('hostname') } : {}),
        ...(values.get('remote_user') ? { remoteUser: values.get('remote_user') } : {}),
        ...(values.get('home_dir') ? { homeDir: values.get('home_dir') } : {}),
        ...(mcodePath ? { mcodePath } : {}),
        ...(values.get('mcode_version') ? { mcodeVersion: values.get('mcode_version') } : {}),
    };
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
