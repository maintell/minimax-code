import { SshRendererBindings } from "./renderer-bindings";
import { SshWorkspaceFileReader } from "./workspace-file-reader";
import { posix } from "node:path";
import { HostRuntimeRecovery } from "./host-runtime-recovery.js";
import { RemoteAccountAuthorization } from "./remote-account-authorization";
import { sshProjectIdFromRuntimeId, sshProjectRuntimeId } from "@mavis/shared/desktop-runtime";
import { RUNTIME_FAILED_CHANNEL, RUNTIME_TRANSPORT_LOST_CHANNEL } from "../local-runtime/utility/control";
import { isSafeAbsoluteRemotePath, resolveSshRuntimeTarget } from "./config";
import { PROJECT_RUNTIME_STATUS_CHANNEL } from "./project-runtime-channels";
import { SshRuntimeManager } from "./ssh-runtime-manager";
/** One host connection, with isolated project/renderer MessagePorts and stores. */
export class ProjectRuntimeRegistry {
    constructor(options) {
        this.options = options;
        this.managers = new Map();
        this.managerCreations = new Map();
        this.hostManagers = new Map();
        this.hostCreations = new Map();
        this.hostFailures = new Map();
        this.renderers = new SshRendererBindings();
        this.authorizations = new Map();
        this.stopped = false;
        this.hostRevisions = new Map();
        this.connectOptions = new Map();
        this.verifiedMcodePaths = new Map();
        this.activeRuntimes = new Map();
        this.readyProbes = new Map();
        this.hostWorkspaces = new Map();
        this.managerStops = new WeakMap();
        this.cleanups = new Set();
        this.files = new SshWorkspaceFileReader({
            repository: options.repository,
            resolveConnection: (runtimeId) => this.getOrCreateManager(runtimeId),
            retainOperation: (runtimeId) => this.retainOperation(runtimeId),
        });
        this.recovery = new HostRuntimeRecovery({
            configure: (host) => ({
                configRevision: this.hostRevisions.get(host) ?? 0,
                attemptTimeoutMs: () => this.connectOptions.get(host)?.timeoutMs,
                getDaemonInstanceId: (manager) => manager.getDaemonInstanceId?.() ?? null,
                run: async (context) => {
                    const connection = this.options.connections.get(host);
                    if (!connection?.enabled)
                        throw Object.assign(new Error('SSH connection disabled.'), {
                            code: 'ssh_connection_disabled',
                        });
                    context.setPhase('probing');
                    const manager = await this.createHostManager(connection, this.hostWorkspaces.get(host) ?? '/', context);
                    if (!manager)
                        throw Object.assign(new Error(this.hostFailures.get(host)?.message ?? 'SSH host is unavailable.'), {
                            code: this.hostFailures.get(host)?.code ?? 'ssh_probe_failed',
                        });
                    const cancel = () => {
                        void this.stopManager(manager);
                    };
                    context.signal.addEventListener('abort', cancel, { once: true });
                    try {
                        context.signal.throwIfAborted();
                        await manager.connect();
                        context.signal.throwIfAborted();
                        const probe = manager.getHostProbe?.();
                        if (probe)
                            this.readyProbes.set(host, probe);
                        return manager;
                    }
                    catch (error) {
                        await this.disposeManager(host, manager);
                        throw error;
                    }
                    finally {
                        context.signal.removeEventListener('abort', cancel);
                    }
                },
                onReady: (manager) => {
                    void this.authorizeHost(host);
                    return this.attachHostTargets(host, manager);
                },
                disposeValue: (manager) => this.disposeManager(host, manager),
            }),
            onSnapshot: (host, snapshot) => this.publishHostStatus(host, snapshot),
        });
    }
    recoveryHint(reason) {
        this.recovery.hint(reason);
    }
    /** A foreground hint changes queue order, never creates connection demand. */
    setActiveRuntime(rendererId, runtimeId) {
        if (this.stopped)
            return;
        if (runtimeId !== null && this.hostForRuntime(runtimeId) === undefined)
            return;
        const previous = this.hostForRuntime(this.activeRuntimes.get(rendererId));
        if (typeof runtimeId === 'string')
            this.activeRuntimes.set(rendererId, runtimeId);
        else
            this.activeRuntimes.delete(rendererId);
        const next = this.hostForRuntime(runtimeId);
        if (previous)
            this.refreshHostPriority(previous);
        if (next && next !== previous)
            this.refreshHostPriority(next);
    }
    hostForRuntime(runtimeId) {
        const id = typeof runtimeId === 'string' ? sshProjectIdFromRuntimeId(runtimeId) : null;
        return id ? this.options.repository.getRuntimeTarget(id)?.host : undefined;
    }
    refreshHostPriority(host) {
        const foreground = [...this.activeRuntimes.values()].some((runtimeId) => this.hostForRuntime(runtimeId) === host);
        this.recovery.setPriority(host, foreground ? 'foreground' : 'background');
    }
    getHostController(host) {
        const controller = this.recovery.get(host);
        this.refreshHostPriority(host);
        if (this.options.connections.get(host)?.enabled)
            controller.retainDemand('enabled');
        return controller;
    }
    getReadyProbe(host) {
        if (!this.options.connections.get(host)?.enabled || !this.hostManagers.get(host)?.isReady())
            return undefined;
        const probe = this.readyProbes.get(host);
        return probe ? { ...probe } : undefined;
    }
    restoreEnabledHosts() {
        for (const connection of this.options.connections.list()) {
            if (connection.enabled)
                void this.ensureHost(connection.alias).catch(() => undefined);
        }
    }
    async ensureHost(host, options) {
        if (this.stopped || !this.options.connections.get(host)?.enabled)
            throw Object.assign(new Error('SSH connection disabled.'), {
                code: 'ssh_connection_disabled',
            });
        options?.signal?.throwIfAborted();
        const controller = this.getHostController(host);
        const cancel = () => controller.dispose();
        const attemptOptions = options
            ? {
                ...options,
                ...(options.onSshVerified
                    ? {
                        onSshVerified: () => {
                            // Closing a saved add form must not cancel Main's service startup.
                            options.signal?.removeEventListener('abort', cancel);
                            options.onSshVerified?.();
                        },
                    }
                    : {}),
            }
            : undefined;
        if (attemptOptions)
            this.connectOptions.set(host, attemptOptions);
        options?.signal?.addEventListener('abort', cancel, { once: true });
        try {
            const result = await controller.connect();
            if (!result.connected)
                throw Object.assign(new Error(result.error.message), result.error);
            return this.getReadyProbe(host) ?? { alias: host, status: 'ready' };
        }
        finally {
            options?.signal?.removeEventListener('abort', cancel);
            if (this.connectOptions.get(host) === attemptOptions)
                this.connectOptions.delete(host);
        }
    }
    async retryHost(host) {
        if (this.options.connections.get(host)?.enabled)
            this.getHostController(host).hint('manual');
        return this.ensureHost(host);
    }
    /** Browse through the established service. Optional API failures never retire the host. */
    async listDirectories(host, path) {
        const failed = { alias: host, path, status: 'probe_failed' };
        if (!isSafeAbsoluteRemotePath(path))
            return failed;
        try {
            await this.ensureHost(host);
            const manager = this.hostManagers.get(host);
            if (!manager?.isReady())
                return failed;
            const isCurrent = () => this.options.connections.get(host)?.enabled && this.hostManagers.get(host) === manager;
            const signal = AbortSignal.timeout(15000);
            const normalized = posix.normalize(path);
            const directories = [];
            const cursors = new Set();
            let cursor;
            do {
                const url = new URL('http://ssh-runtime/minimax-desktop/api/v1/file/tree');
                url.searchParams.set('workspace', normalized);
                // Older runtimes accept only workspace/path. Ask for pagination only if advertised.
                if (cursor)
                    url.searchParams.set('cursor', cursor);
                const response = await manager.fetch(new Request(url, { signal }));
                if (!isCurrent())
                    return failed;
                if (!response.ok)
                    return {
                        ...failed,
                        status: response.status === 404 ? 'workspace_not_found' : 'probe_failed',
                    };
                const body = await response.json();
                if (!isCurrent() || !body || typeof body !== 'object')
                    return failed;
                const entries = body.entries ?? [];
                if (!Array.isArray(entries))
                    return failed;
                for (const entry of entries) {
                    if (!entry || typeof entry !== 'object')
                        return failed;
                    if (entry.type !== 'directory')
                        continue;
                    if (typeof entry.name !== 'string' ||
                        !entry.name ||
                        entry.name === '.' ||
                        entry.name === '..' ||
                        entry.name.includes('/') ||
                        /[\u0000-\u001f\u007f]/u.test(entry.name))
                        return failed;
                    directories.push({ name: entry.name, path: posix.join(normalized, entry.name) });
                }
                const nextCursor = body.next_cursor ?? body.nextCursor;
                cursor = typeof nextCursor === 'string' && nextCursor ? nextCursor : undefined;
                if (cursor && cursors.has(cursor))
                    return failed;
                if (cursor)
                    cursors.add(cursor);
                if (cursors.size > 200)
                    return failed;
            } while (cursor);
            return {
                alias: host,
                path: normalized,
                status: 'ready',
                directories: directories.sort((a, b) => a.name.localeCompare(b.name)),
            };
        }
        catch {
            return failed;
        }
    }
    /** Configuration/install changes preserve active project demand, not old resources. */
    async reconfigureHost(host) {
        this.recovery.reset(host);
        this.hostRevisions.set(host, (this.hostRevisions.get(host) ?? 0) + 1);
        this.hostFailures.delete(host);
        this.readyProbes.delete(host);
        this.hostCreations.delete(host);
        this.authorizations.get(host)?.dispose();
        this.authorizations.delete(host);
        const previous = this.hostManagers.get(host);
        if (previous)
            await this.disposeManager(host, previous);
        for (const [runtimeId, targets] of this.renderers.entries()) {
            const id = sshProjectIdFromRuntimeId(runtimeId);
            if (!id || this.options.repository.getRuntimeTarget(id)?.host !== host)
                continue;
            this.managerCreations.delete(runtimeId);
            if (!this.options.connections.get(host)?.enabled)
                continue;
            for (const rendererId of targets.keys())
                this.getHostController(host).retainDemand(`${runtimeId}:${rendererId}`);
        }
        if (this.options.connections.get(host)?.enabled)
            this.getHostController(host);
        if (this.recovery.peek(host)?.getSnapshot().demandCount)
            void this.getHostController(host).connect();
    }
    stopManager(manager) {
        const existing = this.managerStops.get(manager);
        if (existing)
            return existing;
        const cleanup = manager
            .stop()
            .catch((error) => {
            this.options.logger?.warn(`[ProjectRuntime] local resource cleanup failed: ${String(error)}`);
        })
            .finally(() => this.cleanups.delete(cleanup));
        this.cleanups.add(cleanup);
        this.managerStops.set(manager, cleanup);
        return cleanup;
    }
    async disposeManager(host, manager) {
        if (this.hostManagers.get(host) === manager)
            this.hostManagers.delete(host);
        for (const [runtimeId, candidate] of this.managers)
            if (candidate === manager)
                this.managers.delete(runtimeId);
        this.renderers.forgetManager(manager);
        await this.stopManager(manager);
    }
    publishHostStatus(host, snapshot) {
        this.options.onHostSnapshot?.(host, snapshot, this.getReadyProbe(host));
        this.options.logger?.info(`[SshRecovery] ${JSON.stringify({
            hostId: host,
            controllerEpoch: snapshot.controllerEpoch,
            configRevision: snapshot.configRevision,
            revision: snapshot.revision,
            generation: snapshot.generation,
            attemptId: snapshot.attemptId,
            daemonInstanceId: snapshot.daemonInstanceId,
            state: snapshot.state,
            phase: snapshot.phase,
            attempt: snapshot.attempt,
            nextRetryAtMs: snapshot.nextRetryAtMs,
            code: snapshot.error?.code,
            disposition: snapshot.error?.disposition,
        })}`);
        for (const [runtimeId, targets] of this.renderers.entries()) {
            const projectId = sshProjectIdFromRuntimeId(runtimeId);
            if (!projectId || this.options.repository.getRuntimeTarget(projectId)?.host !== host)
                continue;
            const status = this.getStatus(runtimeId);
            if (!status)
                continue;
            for (const target of targets.values())
                target.send(PROJECT_RUNTIME_STATUS_CHANNEL, { ...status, hostConnection: snapshot });
        }
    }
    async attachHostTargets(host, manager) {
        const tasks = [];
        for (const [runtimeId, targets] of this.renderers.entries()) {
            const id = sshProjectIdFromRuntimeId(runtimeId);
            if (!id || this.options.repository.getRuntimeTarget(id)?.host !== host)
                continue;
            this.managers.set(runtimeId, manager);
            for (const rendererId of targets.keys())
                tasks.push(this.renderers.attach(runtimeId, rendererId, manager));
        }
        await Promise.all(tasks);
    }
    async connectRenderer(runtimeId, target, request) {
        if (typeof runtimeId !== 'string')
            return { enabled: true, connected: false };
        if (this.stopped || !sshProjectIdFromRuntimeId(runtimeId))
            return { enabled: true, connected: false };
        const attemptKey = `${runtimeId}:${target.id}`;
        const binding = this.renderers.begin(runtimeId, target, request?.transportIntentId);
        const scopedTarget = binding.target;
        const projectId = sshProjectIdFromRuntimeId(runtimeId);
        const projectTarget = this.options.repository.getRuntimeTarget(projectId);
        if (projectTarget && this.options.connections.get(projectTarget.host)?.enabled) {
            if (!this.hostWorkspaces.has(projectTarget.host))
                this.hostWorkspaces.set(projectTarget.host, projectTarget.workspaceDir);
            this.getHostController(projectTarget.host).retainDemand(attemptKey);
        }
        const manager = await this.getOrCreateManager(runtimeId);
        if (this.stopped || !binding.isCurrent()) {
            return { enabled: true, connected: false };
        }
        if (!manager) {
            const error = this.getStatus(runtimeId)?.error;
            if (error && error.code !== 'ssh_cancelled') {
                scopedTarget.send(RUNTIME_FAILED_CHANNEL, {
                    type: error.code,
                    reasonCode: error.code,
                    message: error.message,
                });
            }
            return { enabled: true, connected: false };
        }
        return this.renderers.attach(runtimeId, target.id, manager);
    }
    fetchMedia(runtimeId, request) {
        return this.files.fetchMedia(runtimeId, request);
    }
    readWorkspaceFileBytes(...args) {
        return this.files.readWorkspaceFileBytes(...args);
    }
    projectIdForWorkspace(runtimeId, workspaceDir) {
        return this.files.projectIdForWorkspace(runtimeId, workspaceDir);
    }
    retainOperation(runtimeId) {
        const id = typeof runtimeId === 'string' ? sshProjectIdFromRuntimeId(runtimeId) : null;
        const host = id ? this.options.repository.getRuntimeTarget(id)?.host : undefined;
        if (host && id && !this.hostWorkspaces.has(host))
            this.hostWorkspaces.set(host, this.options.repository.getRuntimeTarget(id).workspaceDir);
        return host ? this.retainHostOperation(host) : () => undefined;
    }
    retainHostOperation(host) {
        if (this.stopped || !this.options.connections.get(host)?.enabled)
            return () => undefined;
        return this.recovery.retainOperation(host);
    }
    getStatus(runtimeId) {
        const status = this.getConnectionStatus(runtimeId);
        if (!status)
            return null;
        const projectId = sshProjectIdFromRuntimeId(status.runtimeId);
        const target = projectId ? this.options.repository.getRuntimeTarget(projectId) : null;
        const connection = target ? this.options.connections.get(target.host) : null;
        return {
            ...status,
            reconnectAllowed: connection?.enabled === true,
            ...(target && this.recovery.peek(target.host)
                ? { hostConnection: this.recovery.peek(target.host).getSnapshot() }
                : {}),
        };
    }
    getConnectionStatus(runtimeId) {
        if (typeof runtimeId !== 'string')
            return null;
        const projectId = sshProjectIdFromRuntimeId(runtimeId);
        if (!projectId || !this.options.repository.get(projectId))
            return null;
        const scopedRuntimeId = sshProjectRuntimeId(projectId);
        const target = this.options.repository.getRuntimeTarget(projectId);
        const connection = target ? this.options.connections.get(target.host) : null;
        if (target && connection?.enabled !== true) {
            return {
                runtimeId: scopedRuntimeId,
                state: 'failed',
                error: {
                    code: 'ssh_connection_disabled',
                    message: 'The SSH connection is disabled or no longer configured.',
                },
            };
        }
        const snapshot = target ? this.recovery.peek(target.host)?.getSnapshot() : undefined;
        if (snapshot?.state === 'connecting' || snapshot?.state === 'retry_wait')
            return {
                runtimeId: scopedRuntimeId,
                state: 'connecting',
                error: snapshot.error ?? undefined,
            };
        if (snapshot?.state === 'action_required')
            return { runtimeId: scopedRuntimeId, state: 'failed', error: snapshot.error ?? undefined };
        if (this.managerCreations.has(runtimeId) || (target && this.hostCreations.has(target.host))) {
            return { runtimeId: scopedRuntimeId, state: 'connecting' };
        }
        const manager = this.managers.get(runtimeId) ?? (target ? this.hostManagers.get(target.host) : undefined);
        if (!manager) {
            const error = target ? this.hostFailures.get(target.host) : undefined;
            return error
                ? { runtimeId: scopedRuntimeId, state: 'failed', error }
                : { runtimeId: scopedRuntimeId, state: 'disconnected' };
        }
        if (manager.isReady())
            return { runtimeId: scopedRuntimeId, state: 'connected' };
        if (manager.isConnecting())
            return { runtimeId: scopedRuntimeId, state: 'connecting' };
        const failure = manager.getFailReason();
        return failure
            ? {
                runtimeId: scopedRuntimeId,
                state: 'failed',
                error: { code: failure.type, message: failure.message },
            }
            : { runtimeId: scopedRuntimeId, state: 'disconnected' };
    }
    disconnectRenderer(rendererId, reason, runtimeId, request) {
        if (typeof runtimeId === 'string') {
            if (!this.renderers.release(runtimeId, rendererId, reason, request?.transportIntentId))
                return;
            if (!this.renderers.hasTargets(runtimeId))
                this.managerCreations.delete(runtimeId);
            const id = sshProjectIdFromRuntimeId(runtimeId);
            const host = id ? this.options.repository.getRuntimeTarget(id)?.host : undefined;
            if (host)
                this.recovery.peek(host)?.releaseDemand(`${runtimeId}:${rendererId}`);
            return;
        }
        for (const projectRuntimeId of this.renderers.runtimeIds()) {
            this.disconnectRenderer(rendererId, reason, projectRuntimeId);
        }
        this.setActiveRuntime(rendererId, null);
    }
    /** Also called for a ready host with no projects or mounted Settings UI. */
    async authorizeHost(alias) {
        await this.authorizationFor(alias)?.connected();
    }
    authorizationFor(alias) {
        if (this.stopped || !this.options.openAuthorizationUrl)
            return undefined;
        const existing = this.authorizations.get(alias);
        if (existing)
            return existing;
        const connection = this.options.connections.get(alias);
        if (!connection?.enabled)
            return undefined;
        const revision = this.hostRevisions.get(alias) ?? 0;
        const endpoint = JSON.stringify(connection.endpoint);
        const isCurrent = () => {
            const current = this.options.connections.get(alias);
            return (!this.stopped &&
                current?.enabled === true &&
                (this.hostRevisions.get(alias) ?? 0) === revision &&
                JSON.stringify(current.endpoint) === endpoint);
        };
        const authorization = new RemoteAccountAuthorization({
            isCurrent,
            openBrowser: this.options.openAuthorizationUrl,
            request: async (input) => {
                if (!isCurrent())
                    throw new Error('The SSH connection changed.');
                const release = this.retainHostOperation(alias);
                try {
                    const manager = this.hostManagers.get(alias);
                    if (!manager?.isReady() || !isCurrent())
                        throw new Error('The SSH host is unavailable.');
                    return await manager.remoteAccount(input);
                }
                finally {
                    release();
                }
            },
        });
        this.authorizations.set(alias, authorization);
        return authorization;
    }
    async remoteAccount(alias, input) {
        const connection = this.options.connections.get(alias);
        if (!connection?.enabled)
            return {
                success: false,
                error: {
                    code: 'host_not_configured',
                    message: 'Enable the SSH connection before managing its account.',
                },
            };
        try {
            const authorization = this.authorizationFor(alias);
            if (authorization)
                return { success: true, account: await authorization.request(input) };
            const release = this.retainHostOperation(alias);
            try {
                const manager = this.hostManagers.get(alias);
                if (!manager?.isReady())
                    throw new Error(this.hostFailures.get(alias)?.message ?? 'The SSH host is unavailable.');
                return { success: true, account: await manager.remoteAccount(input) };
            }
            finally {
                release();
            }
        }
        catch (error) {
            return {
                success: false,
                error: {
                    code: 'remote_account_failed',
                    message: error instanceof Error ? error.message : 'The remote account operation failed.',
                },
            };
        }
    }
    async releaseProject(projectId) {
        const runtimeId = `ssh-project:${projectId}`;
        for (const [rendererId, activeRuntime] of this.activeRuntimes) {
            if (activeRuntime === runtimeId)
                this.setActiveRuntime(rendererId, null);
        }
        const creation = this.managerCreations.get(runtimeId);
        const existing = this.managers.get(runtimeId);
        this.managerCreations.delete(runtimeId);
        this.managers.delete(runtimeId);
        const targets = [...this.renderers.entries()].find(([id]) => id === runtimeId)?.[1];
        for (const [rendererId, target] of targets ?? []) {
            target.send(RUNTIME_TRANSPORT_LOST_CHANNEL, { reasonCode: 'runtime_connection_stopped' });
            this.disconnectRenderer(rendererId, 'renderer-request', runtimeId);
        }
        const manager = existing ?? (await creation);
        if (!manager)
            return;
        if ([...this.managers.values()].includes(manager))
            return;
        for (const [host, candidate] of this.hostManagers) {
            if (candidate === manager) {
                if (this.recovery.peek(host)?.getSnapshot().demandCount)
                    return;
                this.hostManagers.delete(host);
                this.recovery.reset(host);
            }
        }
        await this.stopManager(manager);
    }
    /** Installation changes one host; never restart a ready transport carrying tasks. */
    async cliSetupVerified(host, mcodePath) {
        if (mcodePath && isSafeAbsoluteRemotePath(mcodePath)) {
            this.verifiedMcodePaths.set(host, mcodePath);
            this.options.connections.setMcodePath(host, mcodePath);
        }
        const manager = this.hostManagers.get(host);
        // Keep the established host carrying tasks; only capability cache changes.
        if (manager?.isReady())
            return;
        await this.reconfigureHost(host);
    }
    async releaseHost(host, removedProjectIds) {
        this.connectOptions.delete(host);
        this.recovery.reset(host);
        this.verifiedMcodePaths.delete(host);
        this.readyProbes.delete(host);
        this.hostFailures.delete(host);
        // Connection removal supplies a snapshot of the mappings it actually
        // removed. Do not include projects from a subsequently re-added alias.
        const projectIds = removedProjectIds ??
            this.options.repository
                .list()
                .filter((project) => project.host === host)
                .map((project) => project.id);
        this.authorizations.get(host)?.dispose();
        this.authorizations.delete(host);
        this.hostRevisions.set(host, (this.hostRevisions.get(host) ?? 0) + 1);
        // Invalidate pending renderer attempts before waiting for an in-flight host probe.
        const releases = projectIds.map((projectId) => this.releaseProject(projectId));
        const manager = this.hostManagers.get(host);
        await this.hostCreations.get(host)?.catch(() => undefined);
        await Promise.all(releases);
        if (manager && this.hostManagers.get(host) === manager) {
            this.hostManagers.delete(host);
            await this.stopManager(manager);
        }
    }
    async stop() {
        this.stopped = true;
        this.connectOptions.clear();
        this.recovery.dispose();
        this.activeRuntimes.clear();
        this.renderers.clear();
        for (const authorization of this.authorizations.values())
            authorization.dispose();
        this.authorizations.clear();
        await Promise.allSettled([...this.managerCreations.values(), ...this.hostCreations.values()]);
        const managers = [...new Set([...this.managers.values(), ...this.hostManagers.values()])];
        this.managers.clear();
        this.hostManagers.clear();
        this.hostFailures.clear();
        this.verifiedMcodePaths.clear();
        await Promise.all(managers.map((manager) => this.stopManager(manager)));
        await Promise.all([...this.cleanups]);
    }
    async getOrCreateManager(runtimeId) {
        if (this.stopped)
            return null;
        const projectId = sshProjectIdFromRuntimeId(runtimeId);
        if (!projectId)
            return null;
        const projectTarget = this.options.repository.getRuntimeTarget(projectId);
        if (!projectTarget)
            return null;
        const connection = this.options.connections.get(projectTarget.host);
        if (connection?.enabled !== true)
            return null;
        // Persisted mappings are the authority even while a removed project's
        // cached transport is still completing its asynchronous local teardown.
        const existing = this.managers.get(runtimeId);
        if (existing?.isReady())
            return existing;
        const pending = this.managerCreations.get(runtimeId);
        if (pending)
            return pending;
        const target = resolveSshRuntimeTarget(projectTarget, connection);
        if (!target)
            return null;
        const creation = this.getOrCreateHostManager(connection, target.workspaceDir)
            .then((manager) => {
            if (manager && this.managerCreations.get(runtimeId) === creation) {
                this.managers.set(runtimeId, manager);
            }
            return manager;
        })
            .finally(() => {
            if (this.managerCreations.get(runtimeId) === creation) {
                this.managerCreations.delete(runtimeId);
            }
        });
        this.managerCreations.set(runtimeId, creation);
        return creation;
    }
    async getOrCreateHostManager(connection, workspaceDir) {
        if (!this.hostWorkspaces.has(connection.alias))
            this.hostWorkspaces.set(connection.alias, workspaceDir);
        const result = await this.getHostController(connection.alias).connect();
        return result.connected ? result.value : null;
    }
    createHostManager(connection, workspaceDir, context) {
        const host = connection.alias;
        this.hostFailures.delete(host);
        const revision = this.hostRevisions.get(host) ?? 0;
        const creation = (async () => {
            // Installation belongs to the host, not to the date a project was added.
            const verifiedPath = this.verifiedMcodePaths.get(host) ?? connection.mcodePath;
            const currentConnection = this.options.connections.get(host);
            if (!currentConnection?.enabled ||
                JSON.stringify(currentConnection.endpoint) !== JSON.stringify(connection.endpoint))
                return null;
            const executionOptions = this.connectOptions.get(host);
            const manager = (this.options.createManager ?? ((options) => new SshRuntimeManager(options)))({
                target: {
                    kind: 'ssh',
                    host,
                    endpoint: connection.endpoint,
                    workspaceDir,
                    ...(verifiedPath ? { mcodePath: verifiedPath } : {}),
                },
                appVersion: this.options.appVersion,
                attemptId: context.attemptId,
                onPhase: (phase) => {
                    if (context.signal.aborted)
                        return;
                    context.setPhase(phase);
                    if (phase === 'starting')
                        executionOptions?.onSshVerified?.();
                },
                executionOptions,
                onLost: (error) => {
                    if (this.hostManagers.get(host) === manager)
                        this.recovery.peek(host)?.markLost(error);
                },
                onAccountUpdated: (account) => {
                    if (this.hostManagers.get(host) === manager)
                        this.authorizationFor(host)?.observe(account);
                },
                ...(this.options.logger ? { logger: this.options.logger } : {}),
            });
            if ((this.hostRevisions.get(host) ?? 0) !== revision) {
                if (manager)
                    await this.stopManager(manager);
                return null;
            }
            if (manager)
                this.hostManagers.set(host, manager);
            return manager;
        })().finally(() => {
            if (this.hostCreations.get(host) === creation)
                this.hostCreations.delete(host);
        });
        this.hostCreations.set(host, creation);
        return creation;
    }
}

