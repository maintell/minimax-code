const RUNTIME_TARGET_FLAG = '--runtime-target=';
const SSH_HOST_FLAG = '--ssh-host=';
const SSH_WORKSPACE_FLAG = '--ssh-workspace=';
const SSH_MCODE_FLAG = '--ssh-mcode=';
export class InvalidSshRuntimeConfigError extends Error {
    constructor() {
        super(...arguments);
        this.name = 'InvalidSshRuntimeConfigError';
    }
}

/**
 * Resolve the legacy process-wide Runtime identity from startup arguments.
 *
 * This remains as a command-line compatibility entry while product flows move
 * to persisted, project-scoped runtimes. No environment-variable fallback is
 * allowed to silently change the profile/runtime identity.
 */
export function resolveDesktopRuntimeTarget(argv) {
    const requested = readFlag(argv, RUNTIME_TARGET_FLAG) ?? 'local';
    if (requested === 'local')
        return { kind: 'local' };
    if (requested !== 'ssh') {
        throw new InvalidSshRuntimeConfigError(`Unsupported runtime target: ${requested}`);
    }
    const host = requireFlag(argv, SSH_HOST_FLAG, '--ssh-host');
    const workspaceDir = requireFlag(argv, SSH_WORKSPACE_FLAG, '--ssh-workspace');
    const mcodePath = requireFlag(argv, SSH_MCODE_FLAG, '--ssh-mcode');
    if (!isSafeSshHost(host)) {
        throw new InvalidSshRuntimeConfigError('SSH host must be a configured OpenSSH alias or hostname using letters, numbers, dot, dash, or underscore.');
    }
    if (!isSafeAbsoluteRemotePath(workspaceDir)) {
        throw new InvalidSshRuntimeConfigError('SSH workspace must be a valid absolute remote path without traversal or control characters.');
    }
    if (!isSafeAbsoluteRemotePath(mcodePath)) {
        throw new InvalidSshRuntimeConfigError('SSH mcode executable must be a valid absolute remote path without traversal or control characters.');
    }
    return {
        kind: 'ssh',
        host,
        endpoint: { kind: 'ssh_config', hostAlias: host },
        workspaceDir,
        mcodePath,
    };
}
function readFlag(argv, prefix) {
    const value = argv
        .find((argument) => argument.startsWith(prefix))
        ?.slice(prefix.length)
        .trim();
    return value || undefined;
}
function requireFlag(argv, prefix, label) {
    const value = readFlag(argv, prefix);
    if (!value)
        throw new InvalidSshRuntimeConfigError(`${label} is required for SSH Runtime.`);
    return value;
}
export function isSafeSshHost(value) {
    return value.length <= 255 && /^[A-Za-z0-9_][A-Za-z0-9._-]*$/u.test(value);
}
export function isSafeSshHostname(value) {
    if (value.length === 0 || value.length > 255 || value.startsWith('-'))
        return false;
    if (/[^A-Za-z0-9.:[\]_-]/u.test(value))
        return false;
    return !/[\u0000-\u001f\u007f]/u.test(value);
}
export function isSafeSshUser(value) {
    return value.length > 0 && value.length <= 64 && /^[A-Za-z0-9_][A-Za-z0-9._-]*$/u.test(value);
}
export function isSafeSshPort(value) {
    return Number.isInteger(value) && value >= 1 && value <= 65535;
}
export function isValidSshConnectionEndpoint(endpoint) {
    if (typeof endpoint !== 'object' || endpoint === null || Array.isArray(endpoint))
        return false;
    const value = endpoint;
    if (value.kind === 'ssh_config') {
        return (typeof value.hostAlias === 'string' &&
            isSafeSshHost(value.hostAlias) &&
            (value.hostname === undefined ||
                (typeof value.hostname === 'string' && isSafeSshHostname(value.hostname))) &&
            (value.port === undefined || (typeof value.port === 'number' && isSafeSshPort(value.port))) &&
            (value.identityFile === undefined ||
                (typeof value.identityFile === 'string' && isSafeAbsoluteLocalPath(value.identityFile))) &&
            value.password === undefined &&
            value.credentialId === undefined);
    }
    if (value.kind !== 'manual' || typeof value.hostname !== 'string')
        return false;
    return (isSafeSshHostname(value.hostname) &&
        (value.user === undefined || (typeof value.user === 'string' && isSafeSshUser(value.user))) &&
        (value.port === undefined || (typeof value.port === 'number' && isSafeSshPort(value.port))) &&
        (value.identityFile === undefined ||
            (typeof value.identityFile === 'string' && isSafeAbsoluteLocalPath(value.identityFile))) &&
        (value.credentialId === undefined ||
            (typeof value.credentialId === 'string' && isSafeSshCredentialId(value.credentialId))) &&
        !(value.identityFile !== undefined && value.credentialId !== undefined) &&
        value.password === undefined);
}
export function isSafeSshCredentialId(value) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}
export function isSafeAbsoluteLocalPath(value) {
    if (value.length === 0 || value.length > 4096)
        return false;
    if (/[\u0000-\u001f\u007f]/u.test(value))
        return false;
    return /^(?:\/[\s\S]+|[A-Za-z]:[\\/][\s\S]+)$/u.test(value);
}
export function resolveSshRuntimeTarget(target, connection) {
    if (connection.alias !== target.host || !isValidSshConnectionEndpoint(connection.endpoint)) {
        return null;
    }
    return { ...target, endpoint: connection.endpoint };
}
export function isSafeAbsoluteRemotePath(value) {
    if (value.length === 0 || value.length > 4096 || !value.startsWith('/'))
        return false;
    if (/[\u0000-\u001f\u007f]/u.test(value))
        return false;
    return !value.split('/').some((segment) => segment === '..');
}
