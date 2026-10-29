import { sanitizeSshDiagnosticText } from "./diagnostics.js";
export class SshRuntimeError extends Error {
    constructor(code, message, details) {
        super(message);
        this.code = code;
        this.details = details;
        this.name = 'SshRuntimeError';
    }
}

export function classifySshFailure(stderr, ready, commandStarted = false) {
    // A ready runtime's accumulated stderr can contain unrelated business failures.
    // Reconnecting will classify any current SSH authentication or policy failure.
    if (ready) {
        return new SshRuntimeError('runtime_connection_lost', 'The SSH Runtime connection was lost.');
    }
    if (!commandStarted &&
        /permission denied|authentication failed|too many authentication failures|no supported authentication methods|no more authentication methods/i.test(stderr)) {
        return new SshRuntimeError('ssh_auth_failed', 'SSH authentication failed.');
    }
    if (/host key verification failed|remote host identification has changed/i.test(stderr)) {
        return new SshRuntimeError('ssh_host_key_untrusted', 'SSH host-key verification failed.');
    }
    // Explicit terminal diagnostics take precedence over a following connection close.
    if (/no matching (?:key exchange method|host key type|cipher|mac|signature algorithm)|no mutual signature (?:algorithm|supported)|unsupported (?:key exchange|host key|public key|signature) algorithm|bad (?:ssh2? )?(?:kexalgorithms|hostkeyalgorithms|pubkeyacceptedalgorithms|ciphers?|macs?)/i.test(stderr)) {
        return new SshRuntimeError('ssh_algorithm_unsupported', 'SSH algorithm negotiation failed.');
    }
    if (commandStarted &&
        /(?:unknown|unrecognized|invalid) (?:command|subcommand|option|argument).*?(?:app-server|daemon|bootstrap|proxy|auth-mode)|(?:app-server|daemon|bootstrap|proxy).*?(?:not supported|unknown command)/i.test(stderr)) {
        return new SshRuntimeError('remote_mcode_incompatible', 'The installed MCode lacks the required service commands.');
    }
    if (commandStarted &&
        /App-server daemon (?:is already running for|state is missing its)|App-server is running from another installation/i.test(stderr)) {
        return new SshRuntimeError('remote_mcode_profile_mismatch', 'The existing remote service belongs to a different environment or installation.');
    }
    if (/administratively prohibited|not allowed (?:to connect|because)|access denied|connection denied|banned|policy (?:violation|denied|rejected)/i.test(stderr)) {
        return new SshRuntimeError('ssh_connection_rejected', 'The SSH server rejected the connection.');
    }
    if (/could not resolve hostname|connection timed out|operation timed out|no route to host|network is unreachable|connection refused|too many connections|exceeded maxstartups|connection (?:closed|reset|aborted)|broken pipe|kex_exchange_identification: (?:read|write):|ssh_exchange_identification: (?:read|write):/i.test(stderr)) {
        return new SshRuntimeError('ssh_host_unreachable', 'The SSH host is unreachable.');
    }
    if (/mcode(?:\S*)?: (?:command )?not found|(?:bash|sh): .*mcode.*no such file or directory/i.test(stderr)) {
        return new SshRuntimeError('remote_mcode_not_found', 'MCode is not installed at the configured remote path.');
    }
    return new SshRuntimeError('remote_mcode_start_failed', 'The remote MCode app-server failed to start.');
}
export function sshFailureDetails(code, evidence) {
    const text = evidence.stderr ?? '';
    const reason = code === 'remote_mcode_incompatible' || code === 'app_server_protocol_mismatch'
        ? 'incompatible'
        : code === 'remote_mcode_profile_mismatch'
            ? 'profile_mismatch'
            : /timeout/.test(code)
                ? 'timeout'
                : evidence.sshVerified && /permission denied|EACCES|read-only file system/i.test(text)
                    ? 'permission'
                    : evidence.sshVerified &&
                        /MODULE_NOT_FOUND|cannot find module|GLIBC_|node.*(?:not found|missing)|better-sqlite3|shared librar/i.test(text)
                        ? 'dependency'
                        : 'unknown';
    return {
        sshVerified: evidence.sshVerified,
        stage: evidence.stage,
        reason,
        occurredAtMs: Date.now(),
        mcodePath: evidence.mcodePath,
        version: evidence.version,
        exitCode: evidence.exitCode,
        summary: text ? sanitizeSshDiagnosticText(text).slice(-4096) : undefined,
    };
}
/** Shared product statuses for bounded operations, distinct from network reachability. */
export function sshOperationStatus(error) {
    if (error instanceof Error && error.name === 'AbortError')
        return 'cancelled';
    if (error instanceof Error &&
        'code' in error &&
        (error.code === 'credential_unavailable' || error.code === 'credential_storage_unavailable'))
        return error.code;
    if (!(error instanceof SshRuntimeError))
        return undefined;
    if (error.code === 'ssh_command_timeout')
        return 'command_timeout';
    if (error.code === 'ssh_channel_invalid')
        return 'channel_invalid';
    if (error.code === 'ssh_cancelled')
        return 'cancelled';
    return undefined;
}
