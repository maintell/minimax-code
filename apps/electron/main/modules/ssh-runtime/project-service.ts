import { isSafeAbsoluteRemotePath, isSafeSshHost } from "./config";
import { probeSshHost } from "./host-probe";
import { SshProjectRepositoryError } from "./project-repository";
import { probeSshWorkspace } from "./workspace-probe";
const defaultDependencies = {
    probeHost: (connection) => probeSshHost(connection),
    probeWorkspace: probeSshWorkspace,
    readAccount: async () => ({
        success: false,
        error: { code: 'account_unavailable', message: 'Remote account status is unavailable.' },
    }),
};
/** Main-only application service for validated, persisted SSH projects. */
export class SshProjectService {
    constructor(repository, dependencies = {}, connections) {
        this.repository = repository;
        this.connections = connections;
        this.dependencies = { ...defaultDependencies, ...dependencies };
    }
    list() {
        return this.repository.list().map((project) => this.withConnectionDisplayName(project));
    }
    async create(value) {
        const input = parseCreateInput(value);
        if (!input)
            return { success: false, error: 'invalid_input' };
        try {
            const connection = this.connections.get(input.host);
            if (connection?.enabled !== true) {
                return { success: false, error: 'host_not_configured' };
            }
            const connectionRevision = this.connections.getIdentityRevision(input.host);
            const isCurrentConnection = () => this.connections.get(input.host)?.enabled === true &&
                this.connections.getIdentityRevision(input.host) === connectionRevision;
            const hostProbe = await this.dependencies.probeHost(connection);
            if (!isCurrentConnection())
                return { success: false, error: 'host_not_configured' };
            if (hostProbe.status !== 'ready') {
                return { success: false, error: mapProbeError(hostProbe.status) };
            }
            if (!hostProbe.mcodePath || !isSafeAbsoluteRemotePath(hostProbe.mcodePath)) {
                return { success: false, error: 'probe_failed' };
            }
            const workspaceProbe = await this.dependencies.probeWorkspace(connection, input.workspaceDir);
            // A completed probe must not resurrect a mapping after this Desktop
            // connection was removed, even if the same alias has since been added.
            if (!isCurrentConnection())
                return { success: false, error: 'host_not_configured' };
            if (workspaceProbe.status !== 'ready') {
                return { success: false, error: mapProbeError(workspaceProbe.status) };
            }
            if (!workspaceProbe.workspaceDir || !isSafeAbsoluteRemotePath(workspaceProbe.workspaceDir)) {
                return { success: false, error: 'probe_failed' };
            }
            return {
                success: true,
                project: this.withConnectionDisplayName(this.repository.create({
                    ...input,
                    workspaceDir: workspaceProbe.workspaceDir,
                    mcodePath: hostProbe.mcodePath,
                })),
            };
        }
        catch (error) {
            return {
                success: false,
                error: error instanceof SshProjectRepositoryError ? mapRepositoryError(error) : 'probe_failed',
            };
        }
    }
    update(value) {
        const input = parseUpdateInput(value);
        if (!input)
            return { success: false, error: 'invalid_input' };
        try {
            return {
                success: true,
                project: this.withConnectionDisplayName(this.repository.update(input)),
            };
        }
        catch (error) {
            return { success: false, error: mapRepositoryError(error) };
        }
    }
    remove(projectId) {
        if (typeof projectId !== 'string')
            return { success: false, error: 'invalid_input' };
        return this.repository.remove(projectId)
            ? { success: true }
            : { success: false, error: 'project_not_found' };
    }
    withConnectionDisplayName(project) {
        return {
            ...project,
            hostDisplayName: this.connections.get(project.host)?.displayName ?? project.host,
        };
    }
}

function parseCreateInput(value) {
    if (!isRecord(value))
        return null;
    if (typeof value.host !== 'string' || !isSafeSshHost(value.host.trim()))
        return null;
    if (typeof value.workspaceDir !== 'string' || !isSafeAbsoluteRemotePath(value.workspaceDir)) {
        return null;
    }
    if (value.name !== undefined && typeof value.name !== 'string')
        return null;
    return {
        host: value.host.trim(),
        workspaceDir: value.workspaceDir,
        ...(typeof value.name === 'string' ? { name: value.name } : {}),
    };
}
function parseUpdateInput(value) {
    if (!isRecord(value) || typeof value.id !== 'string' || typeof value.name !== 'string') {
        return null;
    }
    return { id: value.id, name: value.name };
}
function mapProbeError(status) {
    switch (status) {
        case 'ssh_not_found':
            return 'ssh_not_found';
        case 'auth_failed':
            return 'auth_failed';
        case 'host_key_untrusted':
            return 'host_key_untrusted';
        case 'unreachable':
            return 'host_unreachable';
        case 'cli_missing':
            return 'cli_missing';
        case 'cli_incompatible':
            return 'cli_incompatible';
        case 'credential_unavailable':
        case 'credential_storage_unavailable':
        case 'command_timeout':
        case 'channel_invalid':
        case 'cancelled':
            return status;
        case 'workspace_not_found':
            return 'workspace_not_found';
        default:
            return 'probe_failed';
    }
}
function mapRepositoryError(error) {
    if (!(error instanceof SshProjectRepositoryError))
        return 'probe_failed';
    switch (error.code) {
        case 'duplicate_project':
            return 'duplicate_project';
        case 'project_not_found':
            return 'project_not_found';
        default:
            return 'invalid_input';
    }
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
