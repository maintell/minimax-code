import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve as pathResolve, isAbsolute } from "node:path";
import { isSafeSshPort, isSafeSshHostname, isSafeSshUser, isSafeAbsoluteLocalPath, isSafeSshHost } from "./config";
import { SshConnectionRepositoryError } from "./connection-repository";
import { discoverSshHosts } from "./host-discovery";
import { sshCredentials, SshCredentialError, isValidSshPassword } from "./credentials.js";
import { probeSshHost } from "./host-probe";
import { setupRemoteMcodeCli } from "./cli-setup";
import { SshConnectionOperations } from "./connection-operations.js";
import { sshExecution } from "./ssh-execution.js";
const defaultDependencies = {
    discoverHosts: discoverSshHosts,
    probeHost: (connection, options) => probeSshHost(connection, options),
    setupCli: (connection, onVerifying) => setupRemoteMcodeCli(connection, undefined, { onVerifying }),
    identityFileExists: async (path) => {
        try {
            return (await stat(path)).isFile();
        }
        catch {
            return false;
        }
    },
    createId: randomUUID,
};
/** Main-owned lifecycle for aliases explicitly enabled in the product. */
export class SshConnectionService {
    constructor(repository, dependencies = defaultDependencies, projects, onCliSetupVerified, getReadyProbe, transport) {
        this.repository = repository;
        this.dependencies = dependencies;
        this.projects = projects;
        this.onCliSetupVerified = onCliSetupVerified;
        this.getReadyProbe = getReadyProbe;
        this.transport = transport;
        this.operations = new SshConnectionOperations();
    }
    get credentials() {
        return this.dependencies.credentials ?? sshCredentials;
    }
    list() {
        return this.repository.list();
    }
    observeRuntimeSnapshot(alias, snapshot, probe) {
        const connection = this.repository.get(alias);
        if (!connection || (!connection.enabled && snapshot.state !== 'disabled'))
            return;
        this.operations.observeRuntimeSnapshot(alias, snapshot, probe);
    }
    async add(value, options = {}) {
        const input = parseCreateInput(value);
        if (!input)
            return { success: false, error: 'invalid_input' };
        let pendingCredentialId;
        let committed = false;
        let failure;
        let provisional;
        let provisionalRevision;
        try {
            try {
                const connection = this.createPendingConnection(input);
                if (this.hasEquivalentConnection(connection)) {
                    return { success: false, error: 'connection_exists' };
                }
                if (options.signal?.aborted)
                    return { success: false, error: 'cancelled' };
                if (input.kind === 'manual' &&
                    input.password !== undefined &&
                    connection.endpoint.kind === 'manual') {
                    if (!connection.endpoint.credentialId)
                        throw new SshCredentialError('credential_unavailable');
                    pendingCredentialId = connection.endpoint.credentialId;
                    this.credentials.stage(pendingCredentialId, input.password);
                }
                const validation = await this.validateConnection(connection, options, Boolean(this.transport));
                if (!validation.error && this.transport) {
                    provisional = this.repository.add({
                        alias: connection.alias,
                        displayName: connection.displayName,
                        endpoint: connection.endpoint,
                    });
                    provisionalRevision = this.repository.getIdentityRevision(connection.alias);
                    this.operations.seed(connection.alias);
                    try {
                        // Saving depends on SSH verification. Main owns the remaining service startup.
                        let verified;
                        const sshVerified = new Promise((resolve) => {
                            verified = () => resolve(undefined);
                        });
                        validation.probe = await Promise.race([
                            this.transport.connectHost(connection.alias, { ...options, onSshVerified: verified }),
                            sshVerified,
                        ]);
                    }
                    catch (error) {
                        const code = error && typeof error === 'object' && 'code' in error ? error.code : '';
                        if (code === 'remote_mcode_not_found' ||
                            code === 'remote_mcode_incompatible' ||
                            code === 'app_server_protocol_mismatch')
                            validation.probe = {
                                alias: connection.alias,
                                status: code === 'remote_mcode_not_found' ? 'cli_missing' : 'cli_incompatible',
                            };
                        else
                            throw error;
                    }
                }
                if (validation.error)
                    return { success: false, error: validation.error };
                if (options.signal?.aborted ||
                    (provisional &&
                        (this.repository.getIdentityRevision(provisional.alias) !== provisionalRevision ||
                            !this.repository.get(provisional.alias)?.enabled)))
                    return { success: false, error: 'cancelled' };
                if (pendingCredentialId && input.kind === 'manual' && input.rememberPassword !== false) {
                    this.credentials.save(pendingCredentialId);
                }
                const saved = provisional ??
                    this.repository.add({
                        alias: connection.alias,
                        displayName: connection.displayName,
                        endpoint: connection.endpoint,
                    });
                committed = true;
                if (!this.transport)
                    this.operations.seed(saved.alias, validation.probe);
                return { success: true, connection: saved, probe: validation.probe };
            }
            catch (error) {
                failure = error;
                throw error;
            }
            finally {
                try {
                    if (provisional &&
                        !committed &&
                        this.repository.getIdentityRevision(provisional.alias) === provisionalRevision) {
                        this.repository.remove(provisional.alias);
                        await this.transport?.disconnectHost(provisional.alias);
                        this.operations.forget(provisional.alias);
                    }
                }
                finally {
                    if (pendingCredentialId && !committed) {
                        try {
                            this.credentials.remove(pendingCredentialId);
                        }
                        catch (cleanupError) {
                            throw new SshCredentialError('credential_storage_unavailable', failure === undefined
                                ? cleanupError
                                : {
                                    errors: [failure, cleanupError],
                                    message: 'SSH connection creation cleanup failed',
                                });
                        }
                    }
                }
            }
        }
        catch (error) {
            return { success: false, error: mapRepositoryError(error) };
        }
    }
    async update(value) {
        const input = parseUpdateInput(value);
        if (!input)
            return { success: false, error: 'invalid_input' };
        try {
            const current = this.repository.get(input.alias);
            if (!current)
                return { success: false, error: 'connection_not_found' };
            if (this.operations.isInstalling(input.alias))
                return { success: false, error: 'operation_in_progress' };
            const isCurrent = this.operations.checkpoint(input.alias);
            const endpoint = updatedEndpoint(current.endpoint, input);
            if (!endpoint)
                return { success: false, error: 'invalid_input' };
            const endpointChanged = JSON.stringify(endpoint) !== JSON.stringify(current.endpoint);
            const validation = endpointChanged && current.enabled
                ? await this.validateConnection({ ...current, endpoint }, {}, Boolean(this.transport))
                : {};
            if (validation.error)
                return { success: false, error: validation.error };
            if (!isCurrent() || this.operations.isInstalling(input.alias))
                return { success: false, error: 'operation_in_progress' };
            const saved = this.repository.updateConnection(input.alias, input.displayName, endpoint);
            if (endpointChanged) {
                sshExecution.invalidateModes(current.endpoint);
                this.operations.seed(input.alias, validation.probe, saved.enabled);
            }
            return {
                success: true,
                connection: saved,
                ...(validation.probe ? { probe: validation.probe } : {}),
            };
        }
        catch (error) {
            return { success: false, error: mapRepositoryError(error) };
        }
    }
    async setEnabled(value) {
        if (!isRecord(value) || typeof value.enabled !== 'boolean') {
            return { success: false, error: 'invalid_input' };
        }
        const alias = parseAlias(value.alias);
        if (!alias)
            return { success: false, error: 'invalid_input' };
        try {
            const connection = this.repository.get(alias);
            if (!connection)
                return { success: false, error: 'connection_not_found' };
            if (this.operations.isInstalling(alias))
                return { success: false, error: 'operation_in_progress' };
            // This is a persisted preference. The subsequent controller connection
            // owns authentication, CLI discovery and failure reporting in one SSH.
            const saved = this.repository.setEnabled(alias, value.enabled);
            if (connection.enabled !== value.enabled)
                this.operations.seed(alias, undefined, value.enabled);
            return {
                success: true,
                connection: saved,
            };
        }
        catch (error) {
            return { success: false, error: mapRepositoryError(error) };
        }
    }
    remove(value) {
        const alias = parseAlias(value);
        if (!alias)
            return { success: false, error: 'invalid_input' };
        if (this.operations.isInstalling(alias))
            return { success: false, error: 'operation_in_progress' };
        const endpoint = this.repository.get(alias)?.endpoint;
        if (endpoint)
            sshExecution.invalidateModes(endpoint);
        try {
            if (!this.repository.get(alias)) {
                return { success: false, error: 'connection_not_found' };
            }
            const removeConnection = () => {
                if (!this.repository.remove(alias)) {
                    throw new SshConnectionRepositoryError('connection_not_found', 'SSH connection not found.');
                }
            };
            let removedProjectIds = [];
            const removeRelatedRecords = () => {
                if (this.projects)
                    removedProjectIds = this.projects.removeByHost(alias, removeConnection);
                else
                    removeConnection();
            };
            if (endpoint?.kind === 'manual' && endpoint.credentialId) {
                this.credentials.remove(endpoint.credentialId, removeRelatedRecords);
            }
            else {
                removeRelatedRecords();
            }
            this.operations.forget(alias);
            return { success: true, removedProjectIds };
        }
        catch (error) {
            return {
                success: false,
                error: error instanceof SshCredentialError
                    ? 'credential_storage_unavailable'
                    : error instanceof SshConnectionRepositoryError && error.code === 'connection_not_found'
                        ? 'connection_not_found'
                        : 'remove_failed',
            };
        }
    }
    async setupCli(value) {
        const alias = parseAlias(value);
        if (!alias)
            return { success: false, error: 'invalid_input' };
        const connection = this.repository.get(alias);
        if (!connection)
            return { success: false, error: 'connection_not_found' };
        if (!connection.enabled)
            return { success: false, error: 'connection_disabled' };
        return this.operations.install(alias, async (verifying) => {
            const result = await this.dependencies.setupCli(connection, verifying);
            if (result.success)
                await this.onCliSetupVerified?.(alias, result.probe);
            return result;
        });
    }
    async probe(alias, options = {}) {
        const connection = this.repository.get(alias);
        if (!connection?.enabled)
            return { alias, status: 'probe_failed' };
        // A live, validated transport is stronger evidence than another short SSH login.
        // Installation still verifies its exact launcher through the independent path.
        const ready = !options.requiredMcodePath && !options.requiredMcodeRelativePath
            ? this.getReadyProbe?.(alias)
            : undefined;
        if (ready)
            return ready;
        if (this.transport && !options.requiredMcodePath && !options.requiredMcodeRelativePath)
            return this.transport.connectHost(alias);
        return this.operations.probe(alias, async () => ({
            ...(await this.dependencies.probeHost(connection, options)),
            alias,
        }));
    }
    async validateConnection(connection, options = {}, localOnly = false) {
        const endpoint = connection.endpoint;
        if (endpoint.kind === 'ssh_config') {
            const discovery = await this.dependencies.discoverHosts();
            if (!discovery.hosts.some((host) => host.alias === endpoint.hostAlias)) {
                return { error: 'host_not_configured' };
            }
        }
        if (endpoint.identityFile &&
            !(await this.dependencies.identityFileExists(endpoint.identityFile))) {
            return { error: 'identity_file_not_found' };
        }
        if (endpoint.kind === 'manual' &&
            endpoint.credentialId &&
            this.credentials.get(endpoint.credentialId) === undefined) {
            return { error: 'credential_unavailable' };
        }
        if (options.signal?.aborted)
            return { error: 'cancelled' };
        if (localOnly)
            return {};
        const probe = await this.dependencies.probeHost(connection, options);
        if (probe.status === 'ready' ||
            probe.status === 'cli_missing' ||
            probe.status === 'cli_incompatible') {
            return { probe: { ...probe, alias: connection.alias } };
        }
        return { error: mapProbeError(probe.status) };
    }
    createPendingConnection(input) {
        const alias = input.kind === 'ssh_config'
            ? input.alias
            : `manual-${this.dependencies.createId().replace(/[^A-Za-z0-9_-]/gu, '')}`;
        return {
            alias,
            displayName: input.displayName,
            endpoint: input.kind === 'ssh_config'
                ? { kind: 'ssh_config', hostAlias: input.alias }
                : {
                    kind: 'manual',
                    hostname: input.hostname,
                    ...(input.user ? { user: input.user } : {}),
                    ...(input.port !== undefined ? { port: input.port } : {}),
                    ...(input.identityFile ? { identityFile: input.identityFile } : {}),
                    ...(input.password !== undefined
                        ? { credentialId: alias.slice('manual-'.length) }
                        : {}),
                },
            enabled: true,
            createdAtMs: 0,
            updatedAtMs: 0,
        };
    }
    hasEquivalentConnection(candidate) {
        return this.repository.list().some((connection) => {
            if (connection.alias === candidate.alias)
                return true;
            if (connection.endpoint.kind !== candidate.endpoint.kind)
                return false;
            if (connection.endpoint.kind === 'ssh_config' && candidate.endpoint.kind === 'ssh_config') {
                return connection.endpoint.hostAlias === candidate.endpoint.hostAlias;
            }
            if (connection.endpoint.kind !== 'manual' || candidate.endpoint.kind !== 'manual') {
                return false;
            }
            const endpoint = candidate.endpoint;
            return (connection.endpoint.hostname === endpoint.hostname &&
                connection.endpoint.user === endpoint.user &&
                connection.endpoint.port === endpoint.port &&
                connection.endpoint.identityFile === endpoint.identityFile &&
                Boolean(connection.endpoint.credentialId) === Boolean(endpoint.credentialId));
        });
    }
}

function parseCreateInput(value) {
    if (typeof value === 'string') {
        const alias = parseAlias(value);
        return alias ? { kind: 'ssh_config', alias, displayName: alias } : null;
    }
    if (!isRecord(value) || (value.kind !== 'ssh_config' && value.kind !== 'manual'))
        return null;
    if (value.credentialId !== undefined)
        return null;
    if (value.kind === 'ssh_config') {
        if (value.password !== undefined || value.rememberPassword !== undefined)
            return null;
        const alias = parseAlias(value.alias);
        const displayName = parseDisplayName(value.displayName ?? alias);
        return alias && displayName ? { kind: 'ssh_config', alias, displayName } : null;
    }
    const displayName = parseDisplayName(value.displayName);
    const parsedHost = parseManualHost(value.hostname);
    const port = value.port === undefined ? undefined : Number(value.port);
    const identityFile = parseIdentityFile(value.identityFile);
    if (!displayName ||
        !parsedHost ||
        (value.password !== undefined &&
            (!isValidSshPassword(value.password) || Boolean(identityFile))) ||
        (value.rememberPassword !== undefined && typeof value.rememberPassword !== 'boolean') ||
        (port !== undefined && !isSafeSshPort(port)) ||
        (value.identityFile !== undefined && value.identityFile !== '' && !identityFile)) {
        return null;
    }
    return {
        kind: 'manual',
        displayName,
        hostname: parsedHost.hostname,
        ...(parsedHost.user ? { user: parsedHost.user } : {}),
        ...(port !== undefined ? { port } : {}),
        ...(identityFile ? { identityFile } : {}),
        ...(typeof value.password === 'string' ? { password: value.password } : {}),
        ...(typeof value.rememberPassword === 'boolean'
            ? { rememberPassword: value.rememberPassword }
            : {}),
    };
}
function parseUpdateInput(value) {
    if (!isRecord(value))
        return null;
    if (value.endpoint !== undefined ||
        value.password !== undefined ||
        value.credentialId !== undefined)
        return null;
    const alias = parseAlias(value.alias);
    const displayName = parseDisplayName(value.displayName);
    if (!alias || !displayName)
        return null;
    if (value.hostname !== undefined && value.hostname !== null && !parseManualHost(value.hostname))
        return null;
    if (value.port !== undefined &&
        value.port !== null &&
        (typeof value.port !== 'number' || !isSafeSshPort(value.port)))
        return null;
    if (value.identityFile !== undefined &&
        value.identityFile !== null &&
        value.identityFile !== '' &&
        !parseIdentityFile(value.identityFile))
        return null;
    return {
        alias,
        displayName,
        ...(value.hostname !== undefined ? { hostname: value.hostname } : {}),
        ...(value.port !== undefined ? { port: value.port } : {}),
        ...(value.identityFile !== undefined
            ? { identityFile: value.identityFile === '' ? null : value.identityFile }
            : {}),
    };
}
function updatedEndpoint(current, input) {
    const identityFile = input.identityFile === undefined
        ? current.identityFile
        : input.identityFile === null
            ? undefined
            : parseIdentityFile(input.identityFile);
    if (identityFile === null)
        return null;
    if (current.kind === 'ssh_config') {
        if (input.hostname !== undefined && input.hostname !== null && input.hostname.includes('@'))
            return null;
        return {
            kind: 'ssh_config',
            hostAlias: current.hostAlias,
            ...(input.hostname === null
                ? {}
                : input.hostname !== undefined
                    ? { hostname: input.hostname.trim() }
                    : current.hostname
                        ? { hostname: current.hostname }
                        : {}),
            ...(input.port === null
                ? {}
                : input.port !== undefined
                    ? { port: input.port }
                    : current.port !== undefined
                        ? { port: current.port }
                        : {}),
            ...(identityFile ? { identityFile } : {}),
        };
    }
    if (input.hostname === null)
        return null;
    const host = input.hostname === undefined
        ? { hostname: current.hostname, ...(current.user ? { user: current.user } : {}) }
        : parseManualHost(input.hostname);
    if (!host || (identityFile && current.credentialId))
        return null;
    return {
        kind: 'manual',
        ...host,
        ...(input.port === null
            ? {}
            : input.port !== undefined
                ? { port: input.port }
                : current.port !== undefined
                    ? { port: current.port }
                    : {}),
        ...(identityFile ? { identityFile } : {}),
        ...(current.credentialId ? { credentialId: current.credentialId } : {}),
    };
}
function parseDisplayName(value) {
    if (typeof value !== 'string')
        return null;
    const displayName = value.trim();
    if (!displayName || displayName.length > 80 || /[\u0000-\u001f\u007f]/u.test(displayName)) {
        return null;
    }
    return displayName;
}
function parseManualHost(value) {
    if (typeof value !== 'string')
        return null;
    const input = value.trim();
    const separator = input.lastIndexOf('@');
    const user = separator >= 0 ? input.slice(0, separator) : undefined;
    const hostname = separator >= 0 ? input.slice(separator + 1) : input;
    if (!isSafeSshHostname(hostname) || (user !== undefined && !isSafeSshUser(user)))
        return null;
    return { hostname, ...(user ? { user } : {}) };
}
function parseIdentityFile(value) {
    if (value === undefined || value === '')
        return undefined;
    if (typeof value !== 'string')
        return null;
    const input = value.trim();
    const expanded = input === '~' ? homedir() : input.startsWith('~/') ? pathResolve(homedir(), input.slice(2)) : input;
    if (!isAbsolute(expanded) || !isSafeAbsoluteLocalPath(expanded))
        return null;
    return expanded;
}
function parseAlias(value) {
    if (typeof value !== 'string')
        return null;
    const alias = value.trim();
    return isSafeSshHost(alias) ? alias : null;
}
function mapProbeError(status) {
    switch (status) {
        case 'credential_unavailable':
        case 'credential_storage_unavailable':
        case 'command_timeout':
        case 'channel_invalid':
        case 'cancelled':
            return status;
        case 'ssh_not_found':
            return 'ssh_not_found';
        case 'auth_failed':
            return 'auth_failed';
        case 'host_key_untrusted':
            return 'host_key_untrusted';
        case 'unreachable':
            return 'host_unreachable';
        default:
            return 'probe_failed';
    }
}
function mapRepositoryError(error) {
    if (error instanceof SshCredentialError)
        return error.code;
    if (error instanceof Error && error.name === 'AbortError')
        return 'cancelled';
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
    const transportErrors = {
        ssh_cancelled: 'cancelled',
        ssh_connection_disabled: 'cancelled',
        ssh_auth_failed: 'auth_failed',
        ssh_host_key_untrusted: 'host_key_untrusted',
        ssh_host_unreachable: 'host_unreachable',
        ssh_not_found: 'ssh_not_found',
        ssh_command_timeout: 'command_timeout',
        host_connection_timeout: 'command_timeout',
        ssh_channel_invalid: 'channel_invalid',
    };
    if (transportErrors[code])
        return transportErrors[code];
    if (!(error instanceof SshConnectionRepositoryError))
        return 'probe_failed';
    switch (error.code) {
        case 'connection_exists':
            return 'connection_exists';
        case 'connection_not_found':
            return 'connection_not_found';
        default:
            return 'invalid_input';
    }
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
