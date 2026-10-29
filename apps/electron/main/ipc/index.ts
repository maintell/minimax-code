/**
 * IPC 处理模块入口
 */
import { markDesktopAuthorizationUrl } from "@mavis/shared/desktop-authorization-url";
import { resolveSshRuntimeEnvironment } from "../modules/ssh-runtime/ssh-command";
import { openExternalTarget } from "../utils/open-external-target";
import { setupWindowIPC } from "./window.ipc";
import { setupSystemIPC } from "./system.ipc";
import { setupDialogIPC } from "./dialog.ipc";
import { setupStorageIPC } from "./storage.ipc";
import { setupProxyIPC } from "./proxy.ipc";
import { setupAuthIPC } from "./auth.ipc";
import { setupUpdaterIPC } from "./updater.ipc";
import { setupDesktopSettingsIPC } from "./settings.ipc";
import { setupTerminalIPC } from "./terminal.ipc";
import { getTerminalManager } from "../modules/terminal";
import { sshProjectRuntimeId } from "@mavis/shared/desktop-runtime";
import { setupMiniChatIPC } from "./miniChat.ipc";
import { setupArchonChatIPC } from "./archonChat.ipc";
import { setupRuntimeTransportIPC } from "./runtime-transport.ipc";
import { setupSshConnectionsIPC } from "./ssh-connections.ipc";
import { setupSshProjectsIPC } from "./ssh-projects.ipc";
import { createPersistentSshProjectRepository } from "../modules/ssh-runtime/project-repository";
import { createPersistentSshConnectionRepository } from "../modules/ssh-runtime/connection-repository";
import { setupScreenshotIPC } from "./screenshot.ipc";
import { setupTrackingRecorderIPC } from "./trackingRecorder.ipc";
import { setupLogViewerIPC } from "./logViewer.ipc";
import { setupNotificationIPC } from "./notification.ipc";
import { setupHotUpdateIPC } from "./hotUpdate.ipc";
import { setupContextMenuIPC } from "./contextMenu.ipc";
import { setupCuPreviewIPC } from "./cuPreview.ipc";
import { setupCuPermissionIPC } from "./cuPermission.ipc";
import { setupPPTPreviewIPC } from "./pptPreview.ipc";
import { setupDocumentPreviewIPC } from "./documentPreview.ipc";
import { setupPreviewClipboardIPC } from "./previewClipboard.ipc";
import { setupEmbeddedBrowserIPC } from "./embeddedBrowser.ipc";
import { setupMiniAppIPC } from "./miniApp.ipc";
import { setupMiniAppComposerIPC } from "./miniAppComposer.ipc";
import { setupMiniAppAgentIPC } from "./miniAppAgent.ipc";
import { setupMiniAppToolIPC } from "./miniAppTool.ipc";
import { setupMiniAppSpeechIPC } from "./miniAppSpeech.ipc";
import { setupBrowserProfileImportIPC } from "./browserProfileImport.ipc";
import { setupFileIPC } from "./file.ipc";
import { setupDevToolsIPC } from "./devtools.ipc";
import { setupRemoteControlBridgeIPC } from "../modules/remote-control-bridge/ipc";
import { configureOSSSharedAuthSession } from "../modules/oss";
import { refreshSharedRuntimeProjection, projectSharedAccessTokenLeaseToRuntime } from "../modules/auth/runtime-projection";
import { getDeveloperOptions } from "../modules/developer-options";
import { setupModelMenuPopupIPC } from "../windows/model-menu-popup";
/**
 * 初始化所有 IPC 处理器（通用，所有窗口类型都需要）
 */
export async function setupAllIPC(options) {
    if (!options?.sharedAuthSession) {
        throw new TypeError('Desktop Shared OAuth session is required.');
    }
    setupWindowIPC();
    setupStorageIPC({
        sharedAuthEnabled: true,
        onSharedIdentityChanged: () => {
            // Renderer profile edits must not be overwritten by the bearer profile cache.
            options.sharedAuthSession.invalidateRuntimeIdentity?.();
            return refreshSharedRuntimeProjection(options.sharedAuthSession).then(() => undefined);
        },
    });
    const proxyFetchDebugAvailable = (() => {
        try {
            return getDeveloperOptions().available;
        }
        catch {
            return false;
        }
    })();
    const resyncSharedRuntimeProjection = () => refreshSharedRuntimeProjection(options.sharedAuthSession, {
        allowAnonymous: true,
    }).then(() => undefined);
    setupProxyIPC({
        sharedAuthSession: options.sharedAuthSession,
        onAccessTokenInvalidated: resyncSharedRuntimeProjection,
        onAccessTokenLease: (lease) => projectSharedAccessTokenLeaseToRuntime(options.sharedAuthSession, lease),
        ...(proxyFetchDebugAvailable
            ? {
                fetchDebug: {
                    isEnabled: () => {
                        try {
                            const state = getDeveloperOptions();
                            return state.available && state.enabled;
                        }
                        catch {
                            return false;
                        }
                    },
                },
            }
            : {}),
    });
    setupSystemIPC(options);
    setupDesktopSettingsIPC(options);
    setupAuthIPC({ sharedAuthSession: options.sharedAuthSession });
    setupDialogIPC();
    setupUpdaterIPC(options);
    const sshProjectRepository = createPersistentSshProjectRepository();
    const sshConnectionRepository = createPersistentSshConnectionRepository();
    setupTerminalIPC({
        sshProjects: sshProjectRepository,
        sshConnections: sshConnectionRepository,
    });
    setupFileIPC();
    setupDevToolsIPC();
    setupArchonChatIPC(options.runtimeTransportMode ?? 'direct');
    setupRuntimeTransportIPC({
        mode: options.runtimeTransportMode ?? 'direct',
        requestQuit: options.requestQuit,
    });
    const sshConnections = setupSshConnectionsIPC({
        connectHost: (alias, options) => sshProjects.ensureHost(alias, options),
        disconnectHost: (alias) => sshProjects.releaseHost(alias),
        listDirectories: (alias, path) => sshProjects.listDirectories(alias, path),
        onConnectionEnabled: (alias) => sshProjects.retryHost(alias),
        getReadyProbe: (alias) => sshProjects.getReadyProbe(alias),
        onManualReconnect: (alias) => sshProjects.retryHost(alias),
        onCliSetupVerified: (alias, probe) => sshProjects.cliSetupVerified(alias, probe?.mcodePath),
        repository: sshConnectionRepository,
        projects: sshProjectRepository,
        onConnectionDisabled: (alias) => {
            for (const project of sshProjectRepository.list()) {
                if (project.host === alias)
                    getTerminalManager().disposeByRuntime(project.runtimeId);
            }
            return sshProjects.releaseHost(alias);
        },
        onConnectionUpdated: (alias) => {
            for (const project of sshProjectRepository.list()) {
                if (project.host === alias)
                    getTerminalManager().disposeByRuntime(project.runtimeId);
            }
            return sshProjects.reconfigureHost(alias);
        },
        onConnectionRemoved: (alias, removedProjectIds) => {
            // The mappings have already been removed from this profile. Use the
            // captured identities to close local PTYs/transport, not remote tasks.
            for (const projectId of removedProjectIds) {
                getTerminalManager().disposeByRuntime(sshProjectRuntimeId(projectId));
            }
            return sshProjects.releaseHost(alias, removedProjectIds);
        },
        remoteAccount: (alias, input) => sshProjects.remoteAccount(alias, input),
    });
    const sshProjects = setupSshProjectsIPC({
        onHostSnapshot: (alias, snapshot, probe) => sshConnections.observeRuntimeSnapshot?.(alias, snapshot, probe),
        openAuthorizationUrl: (url) => openExternalTarget(markDesktopAuthorizationUrl(url, {
            buildEnv: resolveSshRuntimeEnvironment().buildEnv,
            downloadSource: process.env.VITE_DOWNLOAD_SOURCE,
        })),
        appVersion: options.appVersion ?? 'unknown',
        repository: sshProjectRepository,
        connections: sshConnectionRepository,
    });
    sshProjects.restoreEnabledHosts();
    setupMiniChatIPC();
    setupScreenshotIPC();
    setupTrackingRecorderIPC();
    setupLogViewerIPC();
    setupNotificationIPC();
    setupHotUpdateIPC();
    setupContextMenuIPC();
    const shutdownCuPermissionIPC = setupCuPermissionIPC();
    const shutdownCuPreview = setupCuPreviewIPC();
    const shutdownCuPermission = () => {
        shutdownCuPermissionIPC();
        shutdownCuPreview();
    };
    setupPreviewClipboardIPC();
    const disposeOSSSharedAuth = configureOSSSharedAuthSession(options.sharedAuthSession, {
        onAccessTokenInvalidated: resyncSharedRuntimeProjection,
    });
    let documentPreview;
    let disposeMiniAppComposer;
    let disposeMiniAppTool;
    let disposeMiniAppAgent;
    let disposeMiniAppSpeech;
    const disposeModelMenuPopup = setupModelMenuPopupIPC();
    try {
        documentPreview = setupDocumentPreviewIPC({
            resolveTrustedWorkspace: options.resolveTrustedWorkspace,
            resolveTrustedWorkspaceCapability: options.resolveTrustedWorkspaceCapability,
            ...(options.resolveTrustedAsset ? { resolveTrustedAsset: options.resolveTrustedAsset } : {}),
            ...(options.releaseTrustedAssetSender
                ? { releaseTrustedAssetSender: options.releaseTrustedAssetSender }
                : {}),
            onSenderDestroyed: (senderId) => {
                options.onDocumentPreviewSenderDestroyed?.(senderId);
                void sshProjects.releasePreviewSender(senderId);
            },
            stageRemoteWorkspaceSource: (input) => sshProjects.stageRemotePreviewSource(input),
            ...(options.documentPreviewLogger ? { logger: options.documentPreviewLogger } : {}),
        });
        setupPPTPreviewIPC();
        setupEmbeddedBrowserIPC();
        setupMiniAppIPC();
        disposeMiniAppComposer = setupMiniAppComposerIPC();
        disposeMiniAppAgent = setupMiniAppAgentIPC();
        disposeMiniAppTool = setupMiniAppToolIPC();
        disposeMiniAppSpeech = setupMiniAppSpeechIPC();
        setupBrowserProfileImportIPC();
        await setupRemoteControlBridgeIPC();
    }
    catch (setupError) {
        shutdownCuPermission();
        disposeMiniAppComposer?.();
        disposeMiniAppAgent?.();
        disposeMiniAppTool?.();
        disposeMiniAppSpeech?.();
        disposeModelMenuPopup();
        disposeOSSSharedAuth();
        try {
            await Promise.all([
                ...(documentPreview ? [documentPreview.shutdown()] : []),
                sshProjects.shutdown(),
            ]);
        }
        catch (shutdownError) {
            throw Object.assign(new Error('IPC registration failed and resource rollback also failed'), {
                name: 'AggregateError',
                errors: [setupError, shutdownError],
            });
        }
        throw setupError;
    }
    return createLifecycleIPCHandle(documentPreview, sshProjects, () => {
        disposeMiniAppComposer?.();
        disposeMiniAppAgent?.();
        disposeMiniAppTool?.();
        disposeMiniAppSpeech?.();
        disposeModelMenuPopup();
        disposeOSSSharedAuth();
    }, shutdownCuPermission);
}
function createLifecycleIPCHandle(documentPreview, sshProjects, disposeIPCResources, shutdownCuPermission) {
    return Object.freeze({
        shutdown: async () => {
            shutdownCuPermission();
            disposeIPCResources();
            await Promise.all([documentPreview.shutdown(), sshProjects.shutdown()]);
        },
    });
}
// 也单独导出各个 setup 函数，方便按需使用
export { setupWindowIPC } from "./window.ipc";

export { setupSystemIPC } from "./system.ipc";

export { setupDialogIPC } from "./dialog.ipc";

export { setupStorageIPC } from "./storage.ipc";

export { setupProxyIPC } from "./proxy.ipc";

export { setupAuthIPC } from "./auth.ipc";

export { setupUpdaterIPC } from "./updater.ipc";

export { setupTerminalIPC } from "./terminal.ipc";

export { setupMiniChatIPC } from "./miniChat.ipc";

export { setupArchonChatIPC } from "./archonChat.ipc";

export { setupDesktopSettingsIPC, initDesktopSettings, cleanupDesktopSettings } from "./settings.ipc";

export { setupScreenshotIPC } from "./screenshot.ipc";

export { setupTrackingRecorderIPC } from "./trackingRecorder.ipc";

export { setupLogViewerIPC } from "./logViewer.ipc";

export { setupNotificationIPC } from "./notification.ipc";

export { setupHotUpdateIPC, startHotUpdateAutoCheck, stopHotUpdateAutoCheck } from "./hotUpdate.ipc";

export { setupContextMenuIPC } from "./contextMenu.ipc";

export { setupCuPermissionIPC, CU_PERMISSION_CHANNELS } from "./cuPermission.ipc";

export { setupPPTPreviewIPC } from "./pptPreview.ipc";

export { setupDocumentPreviewIPC } from "./documentPreview.ipc";

export { setupPreviewClipboardIPC } from "./previewClipboard.ipc";

export { setupEmbeddedBrowserIPC } from "./embeddedBrowser.ipc";

export { setupMiniAppIPC } from "./miniApp.ipc";

export { setupBrowserProfileImportIPC } from "./browserProfileImport.ipc";

export { setupFileIPC } from "./file.ipc";

export { setupDevToolsIPC } from "./devtools.ipc";

export { setupSshConnectionsIPC } from "./ssh-connections.ipc";

export { setupSshProjectsIPC } from "./ssh-projects.ipc";

