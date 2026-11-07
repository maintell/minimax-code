import { powerMonitor, ipcMain } from "electron";
import { IPC_CHANNELS } from "../config/constants";
import { isDev } from "../config";
import { bindUtilityRuntimeRendererWebContentsLifecycle } from "../modules/local-runtime/utility/renderer-lifecycle";
import { createPersistentSshProjectRepository } from "../modules/ssh-runtime/project-repository";
import { SshAttachmentUploader } from "../modules/ssh-runtime/attachment-upload";
import { ProjectRuntimeRegistry } from "../modules/ssh-runtime/project-runtime-registry";
import { SshRemotePreviewStaging } from "../modules/ssh-runtime/remote-preview-staging";
import { setSshPerfSink, shouldEnableSshPerf } from "../modules/ssh-runtime/perf";
import { SshProjectService } from "../modules/ssh-runtime/project-service";
import { getCategoryLogger } from "../utils/logger";
import { getTerminalManager } from "../modules/terminal";
import { registerProjectRuntimeMediaRequestHandler } from "../modules/protocol/project-runtime-media";
const logger = getCategoryLogger('archon', 'ssh-projects');
const perfLogger = getCategoryLogger('main', 'ssh-perf');
/** Registers project CRUD and project-scoped Runtime transport boundaries. */
export function setupSshProjectsIPC(options) {
    // Perf records are opt-out in dev and opt-in elsewhere; installing the sink
    // here is what turns the instrumentation on across both SSH lanes.
    setSshPerfSink(shouldEnableSshPerf(isDev) ? { info: (message) => perfLogger.info(message) } : null);
    const repository = options.repository ?? createPersistentSshProjectRepository();
    const registry = options.registry ??
        new ProjectRuntimeRegistry({
            repository,
            connections: options.connections,
            appVersion: options.appVersion,
            onHostSnapshot: options.onHostSnapshot,
            openAuthorizationUrl: options.openAuthorizationUrl,
            logger: {
                info: (message) => logger.info(message),
                warn: (message) => logger.warn(message),
                error: (message) => logger.error(message),
            },
        });
    const service = options.service ??
        new SshProjectService(repository, {
            probeHost: (connection) => registry.ensureHost(connection.alias),
            probeWorkspace: async (connection, path) => {
                const result = await registry.listDirectories(connection.alias, path);
                return {
                    status: result.status,
                    ...(result.status === 'ready' ? { workspaceDir: result.path } : {}),
                };
            },
        }, options.connections);
    const attachmentUploader = options.attachmentUploader ?? new SshAttachmentUploader(repository, options.connections);
    const previewStaging = new SshRemotePreviewStaging({
        registry,
        logger: {
            info: (message) => logger.info(message),
            warn: (message) => logger.warn(message),
        },
    });
    const lifecycleBoundRenderers = new WeakSet();
    const bindRenderer = (sender) => {
        if (lifecycleBoundRenderers.has(sender))
            return;
        bindUtilityRuntimeRendererWebContentsLifecycle(sender, (rendererId, reason) => {
            registry.disconnectRenderer(rendererId, reason);
        });
        lifecycleBoundRenderers.add(sender);
    };
    const onResume = () => registry.recoveryHint('resume');
    const onOnline = () => registry.recoveryHint('online');
    const onActiveProject = (event, runtimeId) => {
        bindRenderer(event.sender);
        registry.setActiveRuntime(event.sender.id, runtimeId);
    };
    powerMonitor.on('resume', onResume);
    ipcMain.on(IPC_CHANNELS.PROJECT_RUNTIME_NETWORK_ONLINE, onOnline);
    ipcMain.on(IPC_CHANNELS.PROJECT_RUNTIME_ACTIVE_PROJECT, onActiveProject);
    ipcMain.handle(IPC_CHANNELS.SSH_PROJECTS_LIST, () => service.list());
    ipcMain.handle(IPC_CHANNELS.SSH_PROJECTS_CREATE, (_event, input) => service.create(input));
    ipcMain.handle(IPC_CHANNELS.SSH_PROJECTS_UPDATE, (_event, input) => service.update(input));
    ipcMain.handle(IPC_CHANNELS.SSH_PROJECTS_REMOVE, async (_event, projectId) => {
        if (typeof projectId !== 'string')
            return service.remove(projectId);
        const project = service.list().find((candidate) => candidate.id === projectId);
        if (!project)
            return service.remove(projectId);
        const resumeTerminals = getTerminalManager().suspendRuntime(project.runtimeId);
        try {
            await registry.releaseProject(projectId);
            return service.remove(projectId);
        }
        finally {
            resumeTerminals();
        }
    });
    ipcMain.handle(IPC_CHANNELS.SSH_PROJECTS_UPLOAD_ATTACHMENT, (_event, input) => attachmentUploader.upload(input));
    ipcMain.handle(IPC_CHANNELS.PROJECT_RUNTIME_TRANSPORT_REQUEST_PORT, async (event, runtimeId, request) => {
        try {
            bindRenderer(event.sender);
            const result = await registry.connectRenderer(runtimeId, event.sender, request);
            return result.connected
                ? { mode: 'direct', enabled: true, connected: true }
                : { mode: 'direct', enabled: true, connected: false };
        }
        catch (error) {
            logger.warn(`[ProjectRuntime] renderer port request failed: ${String(error)}`);
            return { mode: 'direct', enabled: true, connected: false };
        }
    });
    ipcMain.handle(IPC_CHANNELS.PROJECT_RUNTIME_TRANSPORT_DISCONNECT, (event, runtimeId, request) => {
        registry.disconnectRenderer(event.sender.id, 'renderer-request', runtimeId, request);
    });
    ipcMain.handle(IPC_CHANNELS.PROJECT_RUNTIME_GET_STATUS, (_event, runtimeId) => registry.getStatus(runtimeId));
    const unregisterMediaRequestHandler = registerProjectRuntimeMediaRequestHandler((runtimeId, request) => registry.fetchMedia(runtimeId, request));
    return {
        restoreEnabledHosts: () => registry.restoreEnabledHosts(),
        ensureHost: (alias, options) => registry.ensureHost(alias, options),
        listDirectories: (alias, path) => registry.listDirectories(alias, path),
        authorizeHost: (alias) => registry.authorizeHost(alias),
        reconfigureHost: (alias) => registry.reconfigureHost(alias),
        retryHost: (alias) => registry.retryHost(alias),
        getReadyProbe: (alias) => registry.getReadyProbe(alias),
        cliSetupVerified: (alias, mcodePath) => registry.cliSetupVerified(alias, mcodePath),
        releaseHost: (alias, removedProjectIds) => removedProjectIds === undefined
            ? registry.releaseHost(alias)
            : registry.releaseHost(alias, removedProjectIds),
        remoteAccount: (alias, input) => registry.remoteAccount(alias, input),
        stageRemotePreviewSource: (input) => previewStaging.stage(input),
        releasePreviewSender: (senderId) => previewStaging.releaseSender(senderId),
        shutdown: async () => {
            powerMonitor.removeListener('resume', onResume);
            ipcMain.removeListener(IPC_CHANNELS.PROJECT_RUNTIME_NETWORK_ONLINE, onOnline);
            ipcMain.removeListener(IPC_CHANNELS.PROJECT_RUNTIME_ACTIVE_PROJECT, onActiveProject);
            unregisterMediaRequestHandler();
            await previewStaging.dispose();
            await registry.stop();
        },
    };
}
