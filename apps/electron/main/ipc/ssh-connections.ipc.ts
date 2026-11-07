import { ipcMain } from "electron";
import { getCategoryLogger } from "../utils/logger";
import { setSshDiagnosticSink, shouldEnableSshDiagnostics } from "../modules/ssh-runtime/diagnostics";
import { resolveSshRuntimeEnvironment } from "../modules/ssh-runtime/ssh-command";
import { IPC_CHANNELS } from "../config/constants";
import { isSafeSshHost } from "../modules/ssh-runtime/config";
import { createPersistentSshConnectionRepository } from "../modules/ssh-runtime/connection-repository";
import { SshConnectionService } from "../modules/ssh-runtime/connection-service";
import { discoverSshHosts } from "../modules/ssh-runtime/host-discovery";
import { hostKeyConfirmation } from "../modules/ssh-runtime/host-key-dialog.js";
import { createPersistentSshProjectRepository } from "../modules/ssh-runtime/project-repository";
export function setupSshConnectionsIPC(options = {}) {
    setSshDiagnosticSink(shouldEnableSshDiagnostics(resolveSshRuntimeEnvironment().buildEnv)
        ? getCategoryLogger('main', 'ssh-diagnostics')
        : null);
    const logger = getCategoryLogger('archon', 'ssh-connections');
    const pending = new Map();
    const manualProbes = new Map();
    const service = options.service ??
        createSshConnectionsService(options.repository, options.projects, async (alias, probe) => {
            try {
                await options.onCliSetupVerified?.(alias, probe);
            }
            catch (error) {
                logger.warn(`[SshSetup] local transport cleanup failed: ${String(error)}`);
            }
        }, options.getReadyProbe, options);
    const stateReaders = new Map();
    service.onOperationState?.((state) => {
        for (const reader of stateReaders.values()) {
            if (!reader.isDestroyed())
                reader.send(IPC_CHANNELS.SSH_CONNECTIONS_OPERATION_STATE, state);
        }
    });
    ipcMain.handle(IPC_CHANNELS.SSH_CONNECTIONS_OPERATION_STATES, (event) => {
        const reader = event.sender;
        if (!stateReaders.has(reader.id)) {
            stateReaders.set(reader.id, reader);
            reader.once('destroyed', () => stateReaders.delete(reader.id));
        }
        return service.getOperationStates?.() ?? [];
    });
    ipcMain.handle(IPC_CHANNELS.SSH_CONNECTIONS_LIST, () => service.list());
    ipcMain.handle(IPC_CHANNELS.SSH_CONNECTIONS_ADD, async (event, input, request) => {
        if (request === undefined)
            return service.add(input);
        if (typeof request?.requestId !== 'string' ||
            !/^[a-zA-Z0-9-]{1,80}$/u.test(request.requestId)) {
            return { success: false, error: 'invalid_input' };
        }
        const requestId = request.requestId;
        const key = `${event.sender.id}:${requestId}`;
        if (pending.has(key))
            return { success: false, error: 'invalid_input' };
        const startedAt = Date.now();
        logger.info(`[SshAdd] request=${requestId} phase=start`);
        const controller = new AbortController();
        pending.set(key, controller);
        let timedOut = false;
        let settled = false;
        let waitingForTrust = false;
        let remainingWorkMs = 45000;
        let workStartedAt = performance.now();
        const deadline = workStartedAt + 120000;
        let timer;
        const armDeadline = () => {
            clearTimeout(timer);
            if (settled || controller.signal.aborted)
                return;
            timer = setTimeout(() => {
                timedOut = true;
                controller.abort();
            }, Math.max(0, Math.min(deadline - performance.now(), waitingForTrust ? Infinity : remainingWorkMs)));
        };
        armDeadline();
        const confirmHostKey = hostKeyConfirmation(event.sender);
        const onDestroyed = () => controller.abort();
        event.sender.once('destroyed', onDestroyed);
        try {
            const cancelled = new Promise((resolve) => controller.signal.addEventListener('abort', () => {
                resolve({ success: false, error: timedOut ? 'command_timeout' : 'cancelled' });
            }, { once: true }));
            const result = await Promise.race([
                service.add(input, {
                    signal: controller.signal,
                    timeoutMs: 120000,
                    confirmHostKey: async (challenge, signal) => {
                        remainingWorkMs -= performance.now() - workStartedAt;
                        waitingForTrust = true;
                        armDeadline();
                        try {
                            return await confirmHostKey(challenge, signal);
                        }
                        finally {
                            waitingForTrust = false;
                            workStartedAt = performance.now();
                            armDeadline();
                        }
                    },
                    onProgress: (mode) => {
                        logger.info(`[SshAdd] request=${requestId} phase=probe mode=${mode}`);
                        if (!controller.signal.aborted && !event.sender.isDestroyed()) {
                            event.sender.send(IPC_CHANNELS.SSH_CONNECTIONS_ADD_PROGRESS, { requestId, mode });
                        }
                    },
                }),
                cancelled,
            ]);
            logger.info(`[SshAdd] request=${requestId} phase=done status=${result.success ? 'saved' : result.error} elapsedMs=${Date.now() - startedAt}`);
            return result;
        }
        finally {
            settled = true;
            clearTimeout(timer);
            event.sender.removeListener('destroyed', onDestroyed);
            pending.delete(key);
        }
    });
    ipcMain.handle(IPC_CHANNELS.SSH_CONNECTIONS_CANCEL_ADD, (event, requestId) => {
        if (typeof requestId === 'string')
            pending.get(`${event.sender.id}:${requestId}`)?.abort();
    });
    ipcMain.handle(IPC_CHANNELS.SSH_CONNECTIONS_UPDATE, async (_event, input) => {
        const alias = typeof input === 'object' &&
            input !== null &&
            'alias' in input &&
            typeof input.alias === 'string'
            ? input.alias
            : '';
        const previous = (await service.list()).find((connection) => connection.alias === alias);
        const result = await service.update(input);
        if (result.success &&
            previous &&
            JSON.stringify(previous.endpoint) !== JSON.stringify(result.connection.endpoint)) {
            try {
                await options.onConnectionUpdated?.(alias);
            }
            catch (error) {
                logger.warn(`[SshConnection] local transport cleanup failed after update: ${String(error)}`);
            }
        }
        return result;
    });
    ipcMain.handle(IPC_CHANNELS.SSH_CONNECTIONS_SET_ENABLED, (_event, alias, enabled) => {
        if (typeof alias !== 'string' || !isSafeSshHost(alias) || typeof enabled !== 'boolean') {
            return Promise.resolve({ success: false, error: 'invalid_input' });
        }
        return service.setEnabled(alias, enabled).then(async (result) => {
            if (result.success) {
                if (!result.connection.enabled)
                    await options.onConnectionDisabled?.(alias);
                else
                    void options.onConnectionEnabled?.(alias).catch((error) => {
                        logger.warn(`[SshConnection] connect failed: ${String(error)}`);
                    });
            }
            return result;
        });
    });
    ipcMain.handle(IPC_CHANNELS.SSH_CONNECTIONS_REMOTE_ACCOUNT, async (_event, alias, input) => {
        if (typeof alias !== 'string' || !isSafeSshHost(alias) || !isRemoteAccountAction(input)) {
            return {
                success: false,
                error: { code: 'invalid_input', message: 'Invalid remote account request.' },
            };
        }
        if (!options.remoteAccount)
            return {
                success: false,
                error: {
                    code: 'unavailable',
                    message: 'Remote account management is unavailable.',
                },
            };
        return options.remoteAccount(alias, input);
    });
    ipcMain.handle(IPC_CHANNELS.SSH_CONNECTIONS_REMOVE, (_event, alias) => {
        if (typeof alias !== 'string' || !isSafeSshHost(alias)) {
            return Promise.resolve({ success: false, error: 'invalid_input' });
        }
        return service.remove(alias).then(async (result) => {
            if (result.success) {
                if (options.onConnectionRemoved) {
                    await options.onConnectionRemoved(alias, result.removedProjectIds ?? []);
                }
                else {
                    await options.onConnectionDisabled?.(alias);
                }
            }
            return result;
        });
    });
    ipcMain.handle(IPC_CHANNELS.SSH_CONNECTIONS_DISCOVER, () => service.discover());
    ipcMain.handle(IPC_CHANNELS.SSH_CONNECTIONS_PROBE, async (_event, alias) => {
        if (typeof alias !== 'string' || !isSafeSshHost(alias))
            return { alias: typeof alias === 'string' ? alias : '', status: 'probe_failed' };
        return service.probe(alias);
    });
    ipcMain.handle(IPC_CHANNELS.SSH_CONNECTIONS_CONNECT, (_event, alias) => {
        if (typeof alias !== 'string' || !isSafeSshHost(alias))
            return { alias: typeof alias === 'string' ? alias : '', status: 'probe_failed' };
        const pending = manualProbes.get(alias);
        if (pending)
            return pending;
        const task = Promise.resolve()
            .then(() => options.onManualReconnect?.(alias) ?? { alias, status: 'probe_failed' })
            .finally(() => {
            if (manualProbes.get(alias) === task)
                manualProbes.delete(alias);
        });
        manualProbes.set(alias, task);
        return task;
    });
    ipcMain.handle(IPC_CHANNELS.SSH_CONNECTIONS_SETUP_CLI, (_event, alias) => {
        if (typeof alias !== 'string' || !isSafeSshHost(alias)) {
            return Promise.resolve({ success: false, error: 'invalid_input' });
        }
        return service.setupCli(alias);
    });
    ipcMain.handle(IPC_CHANNELS.SSH_CONNECTIONS_LIST_DIRECTORIES, async (_event, alias, path) => {
        if (typeof alias !== 'string' || typeof path !== 'string') {
            return {
                alias: typeof alias === 'string' ? alias : '',
                path: typeof path === 'string' ? path : '',
                status: 'probe_failed',
            };
        }
        return service.listDirectories(alias, path);
    });
    return service;
}
function createSshConnectionsService(repository = createPersistentSshConnectionRepository(), projects = createPersistentSshProjectRepository(), onCliSetupVerified, getReadyProbe, transport = {}) {
    const lifecycle = new SshConnectionService(repository, undefined, projects, onCliSetupVerified, getReadyProbe, transport.connectHost && transport.disconnectHost
        ? { connectHost: transport.connectHost, disconnectHost: transport.disconnectHost }
        : undefined);
    return {
        list: () => Promise.resolve(lifecycle.list()),
        add: (input, options) => lifecycle.add(input, options),
        update: (input) => Promise.resolve(lifecycle.update(input)),
        setEnabled: (alias, enabled) => lifecycle.setEnabled({ alias, enabled }),
        remove: (alias) => Promise.resolve(lifecycle.remove(alias)),
        discover: discoverSshHosts,
        probe: (alias, options) => lifecycle.probe(alias, options),
        getOperationStates: async () => lifecycle.operations.snapshot(),
        onOperationState: (listener) => lifecycle.operations.subscribe(listener),
        observeRuntimeSnapshot: (alias, snapshot, probe) => lifecycle.observeRuntimeSnapshot(alias, snapshot, probe),
        setupCli: (alias) => lifecycle.setupCli(alias),
        listDirectories: async (alias, path) => {
            const connection = repository.get(alias);
            if (!connection?.enabled) {
                return { alias, path, status: 'probe_failed' };
            }
            return transport.listDirectories?.(alias, path) ?? { alias, path, status: 'probe_failed' };
        },
    };
}
function isRemoteAccountAction(value) {
    if (!value || typeof value !== 'object' || !('action' in value))
        return false;
    if (value.action === 'cancel')
        return ('loginId' in value &&
            typeof value.loginId === 'string' &&
            value.loginId.length > 0 &&
            value.loginId.length <= 256);
    return value.action === 'read' || value.action === 'login' || value.action === 'logout';
}
