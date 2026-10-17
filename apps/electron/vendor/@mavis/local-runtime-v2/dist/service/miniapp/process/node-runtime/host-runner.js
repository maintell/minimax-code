import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { boundMiniAppRuntimeErrorText } from '../../errors.js';
import { createMiniAppHostConnectorRuntimeClient, } from '../host-connector/host-connector.js';
const MAX_LOG_MESSAGE_LENGTH = 4 * 1024;
const runnerObservations = new Set();
const MINIAPP_RUNNER_ERROR_CODES = new Set([
    'ENTRY_OUTSIDE_ARTIFACT',
    'HOST_CONNECTOR_UNAVAILABLE',
    'RUNNER_LIFECYCLE_INVALID',
    'RUNNER_PROTOCOL_ERROR',
    'START_EXPORT_MISSING',
]);
export class MiniAppRunnerError extends Error {
    code;
    name = 'MiniAppRunnerError';
    constructor(code, message, options) {
        super(message, options);
        this.code = code;
    }
}
/** Loads the package entry and gives it only the frozen, Host-owned runtime context. */
export async function startMiniAppModule(init, options = {}) {
    const resolveRealPath = options.resolveRealPath ?? realpath;
    const packageRoot = await resolveRealPath(init.packageRoot);
    const start = await loadStartFunction(init, packageRoot, resolveRealPath, options.loadModule);
    assertConnectorAvailable(init, options.createHostConnector);
    const abortController = new AbortController();
    const logger = createLogger(options.emit);
    const hostConnector = options.createHostConnector?.({
        pluginId: init.pluginId,
        processGeneration: init.processGeneration,
        policy: init.hostConnectorPolicy,
    });
    const context = Object.freeze({
        pluginId: init.pluginId,
        pluginRoot: packageRoot,
        dataDir: init.dataDir,
        generationId: init.processGeneration,
        listen: Object.freeze({ ...init.listen }),
        signal: abortController.signal,
        logger,
        ...(hostConnector ? { hostConnector } : {}),
    });
    let result;
    try {
        result = await start(context);
    }
    catch (error) {
        abortController.abort();
        throw error;
    }
    const dispose = readDispose(result, abortController);
    let stopPromise;
    return {
        stop() {
            stopPromise ??= (async () => {
                abortController.abort();
                await dispose?.();
            })();
            return stopPromise;
        },
    };
}
async function loadStartFunction(init, packageRoot, resolveRealPath, loadModule) {
    const entryPath = await resolveRealPath(path.resolve(packageRoot, init.nodeEntry));
    if (!isInside(packageRoot, entryPath)) {
        throw new MiniAppRunnerError('ENTRY_OUTSIDE_ARTIFACT', 'Mini App Node entry resolved outside its package artifact');
    }
    const loaded = (await (loadModule ?? ((url) => import(url)))(pathToFileURL(entryPath).href));
    if (typeof loaded.start !== 'function') {
        throw new MiniAppRunnerError('START_EXPORT_MISSING', 'Mini App Node entry must export a named start function');
    }
    return loaded.start;
}
function assertConnectorAvailable(init, create) {
    if (init.hostConnectorPolicy.kind === 'allowlist' && !create) {
        throw new MiniAppRunnerError('HOST_CONNECTOR_UNAVAILABLE', 'Host Connector access requires a Host-owned client');
    }
}
function readDispose(result, abortController) {
    if (result === undefined)
        return undefined;
    if (!isRecord(result) || typeof result.dispose !== 'function') {
        abortController.abort();
        throw new MiniAppRunnerError('RUNNER_LIFECYCLE_INVALID', 'Mini App start must return void or include dispose()');
    }
    return result.dispose.bind(result);
}
function createLogger(emit) {
    const log = (level, message, fields) => {
        emit?.({
            type: 'miniapp:log',
            level,
            message: boundedLogMessage(message),
            fieldKeys: Object.keys(fields ?? {}),
        });
    };
    return Object.freeze({
        debug: (message, fields) => log('debug', message, fields),
        info: (message, fields) => log('info', message, fields),
        warn: (message, fields) => log('warn', message, fields),
        error: (message, fields) => log('error', message, fields),
    });
}
/** Child executable entry. IPC routes lifecycle and Connector messages; stdio carries logs. */
export function runMiniAppHostRunner(options = {}) {
    const processPort = options.process ?? nativeProcessPort();
    const send = (message) => {
        if (processPort.connected === false || !processPort.send)
            return;
        try {
            processPort.send(message);
        }
        catch {
            // Parent loss is handled by disconnect plus direct Node root ownership.
        }
    };
    const sendStopped = () => flushRunnerMessage(processPort, { type: 'miniapp:stopped' });
    const disconnect = () => {
        if (processPort.connected === false || !processPort.disconnect)
            return;
        try {
            processPort.disconnect();
        }
        catch {
            // A concurrent parent disconnect already releases the IPC handle.
        }
    };
    const transport = runnerIpcTransport(processPort);
    const start = options.start ?? ((init) => startWithIpcConnector(init, send, transport));
    let running;
    let initialized = false;
    let stopping;
    const stop = (exitCode) => {
        stopping ??= (async () => {
            await running?.stop();
            await sendStopped();
            processPort.exitCode = exitCode;
            disconnect();
        })();
        return stopping;
    };
    const fail = async (error) => {
        send({ type: 'miniapp:error', code: errorCode(error), errorText: errorText(error) });
        await stop(1);
    };
    const dispatch = (operation) => {
        const observed = dispatchOperation(operation, processPort, () => runnerObservations.delete(observed));
        runnerObservations.add(observed);
    };
    processPort.on('message', (message) => {
        // Connector responses must be delivered while start(context) is awaiting list().
        if (isConnectorMessage(message))
            return;
        dispatch((async () => {
            if (isStopMessage(message)) {
                await stop(0);
                return;
            }
            if (!isMiniAppRunnerInitMessage(message) || initialized) {
                await fail(new MiniAppRunnerError('RUNNER_PROTOCOL_ERROR', 'Invalid runner init'));
                return;
            }
            initialized = true;
            try {
                const started = await start(message);
                if (stopping || processPort.connected === false) {
                    await started.stop();
                    return;
                }
                running = started;
                send({
                    type: 'miniapp:started',
                    pluginId: message.pluginId,
                    processGeneration: message.processGeneration,
                    readiness: message.readiness,
                });
            }
            catch (error) {
                await fail(error);
            }
        })());
    });
    processPort.once('disconnect', () => dispatch(stop(0)));
    processPort.once('SIGTERM', () => dispatch(stop(0)));
    processPort.once('SIGINT', () => dispatch(stop(0)));
    processPort.once('uncaughtException', (error) => dispatch(fail(error)));
    processPort.once('unhandledRejection', (error) => dispatch(fail(error)));
}
function flushRunnerMessage(processPort, message) {
    if (processPort.connected === false || !processPort.send)
        return Promise.resolve();
    const send = processPort.send.bind(processPort);
    return new Promise((resolve) => {
        let settled = false;
        const complete = () => {
            if (settled)
                return;
            settled = true;
            resolve();
        };
        try {
            send(message, complete);
        }
        catch {
            complete();
        }
    });
}
async function dispatchOperation(operation, processPort, complete) {
    try {
        await operation;
    }
    catch {
        processPort.exitCode = 1;
    }
    finally {
        complete();
    }
}
async function startWithIpcConnector(init, emit, transport) {
    let connector;
    const closeConnector = () => {
        connector?.close();
    };
    try {
        const running = await startMiniAppModule(init, {
            emit,
            createHostConnector: init.hostConnectorPolicy.kind === 'allowlist'
                ? () => {
                    connector = createMiniAppHostConnectorRuntimeClient({
                        transport,
                    });
                    return connector.client;
                }
                : undefined,
        });
        return {
            async stop() {
                try {
                    await running.stop();
                }
                finally {
                    closeConnector();
                }
            },
        };
    }
    catch (error) {
        closeConnector();
        throw error;
    }
}
export function isMiniAppRunnerInitMessage(value) {
    if (!isRecord(value))
        return false;
    const keys = [
        'type',
        'protocolVersion',
        'pluginId',
        'processGeneration',
        'packageRoot',
        'nodeEntry',
        'dataDir',
        'listen',
        'readiness',
        'hostConnectorPolicy',
    ];
    if (!hasExactKeys(value, keys))
        return false;
    return (value.type === 'miniapp:init' &&
        value.protocolVersion === 1 &&
        hasStringIdentityFields(value) &&
        isListenAddress(value.listen) &&
        isReadinessIdentity(value.readiness) &&
        isConnectorPolicy(value.hostConnectorPolicy));
}
function hasStringIdentityFields(value) {
    return ['pluginId', 'processGeneration', 'packageRoot', 'nodeEntry', 'dataDir'].every((field) => typeof value[field] === 'string');
}
function isListenAddress(value) {
    return (isRecord(value) &&
        hasExactKeys(value, ['host', 'port']) &&
        value.host === '127.0.0.1' &&
        Number.isInteger(value.port));
}
function isReadinessIdentity(value) {
    return (isRecord(value) &&
        hasExactKeys(value, ['startupToken', 'nodeDigest']) &&
        typeof value.startupToken === 'string' &&
        typeof value.nodeDigest === 'string');
}
function nativeProcessPort() {
    return {
        get connected() {
            return process.connected;
        },
        get exitCode() {
            return typeof process.exitCode === 'number' ? process.exitCode : undefined;
        },
        set exitCode(value) {
            process.exitCode = value;
        },
        on(event, listener) {
            process.on(event, listener);
            return this;
        },
        once(event, listener) {
            process.once(event, listener);
            return this;
        },
        removeListener(event, listener) {
            process.removeListener(event, listener);
            return this;
        },
        send(message, callback) {
            if (!process.send) {
                callback?.(new Error('Runner IPC channel is unavailable'));
                return false;
            }
            return callback ? process.send(message, callback) : process.send(message);
        },
        disconnect() {
            if (process.connected)
                process.disconnect();
        },
    };
}
function runnerIpcTransport(processPort) {
    return {
        get connected() {
            return processPort.connected;
        },
        send(message, callback) {
            if (!processPort.send) {
                callback(new Error('Runner IPC channel is unavailable'));
                return false;
            }
            return processPort.send(message, callback);
        },
        on: (event, listener) => processPort.on(event, listener),
        removeListener: (event, listener) => processPort.removeListener(event, listener),
    };
}
function isConnectorMessage(value) {
    return isRecord(value) && value.type === 'miniapp:connector';
}
function isConnectorPolicy(value) {
    if (!isRecord(value))
        return false;
    return value.kind === 'deny-all'
        ? hasExactKeys(value, ['kind'])
        : value.kind === 'allowlist' &&
            hasExactKeys(value, ['kind', 'providers']) &&
            Array.isArray(value.providers) &&
            value.providers.every((provider) => typeof provider === 'string');
}
function isStopMessage(value) {
    return isRecord(value) && hasExactKeys(value, ['type']) && value.type === 'miniapp:stop';
}
function isInside(root, candidate) {
    const relative = path.relative(root, candidate);
    return (relative === '' ||
        (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)));
}
function errorText(value) {
    let text;
    try {
        const candidate = value instanceof Error ? (value.stack ?? `${value.name}: ${value.message}`) : value;
        text = typeof candidate === 'string' ? candidate : String(candidate);
    }
    catch {
        text = 'Runner error could not be converted to text';
    }
    return boundMiniAppRuntimeErrorText(text, 'runner error text');
}
function boundedLogMessage(message) {
    return message.slice(0, MAX_LOG_MESSAGE_LENGTH);
}
function errorCode(error) {
    if (error instanceof MiniAppRunnerError)
        return error.code;
    return isRecord(error) && error.code === 'EADDRINUSE' ? error.code : 'RUNNER_START_FAILED';
}
/** Re-validates child IPC before a runner failure crosses into the Host runtime. */
export function normalizeMiniAppRunnerFailureCode(code) {
    if (code === 'EADDRINUSE' || code === 'RUNNER_START_FAILED')
        return code;
    return MINIAPP_RUNNER_ERROR_CODES.has(code)
        ? code
        : 'RUNNER_START_FAILED';
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function hasExactKeys(value, keys) {
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    runMiniAppHostRunner();
}
//# sourceMappingURL=host-runner.js.map