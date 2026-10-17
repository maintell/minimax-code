import { spawn as nodeSpawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { createConnection } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_RUNNING_MINIAPP_SERVICES } from '../../contracts.js';
import { selectFailureAfterCleanup } from '../../supervisor/cleanup-settlement.js';
import { MiniAppCleanupUnprovenError, markMiniAppRootTerminationProven } from '../../errors.js';
import { sanitizeMiniAppRuntimeLogEvent } from '../../runtime-log.js';
import { createDirectNodeRootTerminator, } from './direct-root.js';
import { attachStartupFailureDetail, captureStartupError, isRunnerErrorMessage, MiniAppNodeRuntimeError, runnerFailure, } from './node-runtime-startup-error.js';
const LOOPBACK_HOST = '127.0.0.1';
const PORT_MIN = 49_152;
const PORT_MAX = 65_535;
const PORT_COUNT = PORT_MAX - PORT_MIN + 1;
const runtimeObservations = new Set();
export function createMiniAppNodeRuntimeAdapter(options) {
    const resolved = resolveOptions(options);
    const physicalRoots = createPhysicalRootCapacity(MAX_RUNNING_MINIAPP_SERVICES);
    return {
        async prepare(input) {
            assertCapabilities(resolved, input.candidate);
            throwIfAborted(input.signal);
            const dataDir = await resolveDataDir(resolved, input.candidate.pluginId);
            const runtimeDir = await resolved.createRuntimeDir();
            try {
                const candidate = await materializeProcessCandidate({
                    options: resolved,
                    candidate: input.candidate,
                    runtimeDir,
                    signal: input.signal,
                });
                return await prepareRuntime({
                    ...input,
                    options: resolved,
                    physicalRoots,
                    candidate,
                    dataDir,
                    runtimeDir,
                });
            }
            catch (error) {
                if (isCleanupUnproven(error))
                    throw error;
                const failure = await selectFailureAfterCleanup(error, () => resolved.removeRuntimeDir(runtimeDir));
                attachStartupFailureDetail(error, failure);
                throw failure;
            }
        },
    };
}
async function materializeProcessCandidate(input) {
    const packageRoot = path.join(input.runtimeDir, 'package');
    await input.options.materializePackage({
        sourceRoot: input.candidate.packageRoot,
        targetRoot: packageRoot,
    });
    throwIfAborted(input.signal);
    const packageStat = await input.options.lstatPath(packageRoot);
    if (packageStat.isSymbolicLink() || !packageStat.isDirectory())
        throw artifactRootError();
    const [canonicalRuntimeDir, canonicalPackageRoot] = await Promise.all([
        input.options.resolveRealPath(input.runtimeDir),
        input.options.resolveRealPath(packageRoot),
    ]);
    if (path.dirname(canonicalPackageRoot) !== canonicalRuntimeDir)
        throw artifactRootError();
    const candidate = { ...input.candidate, packageRoot: canonicalPackageRoot };
    if (!(await input.options.verifyCandidate(candidate))) {
        throw new MiniAppNodeRuntimeError('CANDIDATE_CHANGED', 'Mini App process artifact did not match the accepted candidate');
    }
    throwIfAborted(input.signal);
    return candidate;
}
function artifactRootError() {
    return new MiniAppNodeRuntimeError('CANDIDATE_CHANGED', 'Mini App process artifact root is not an owned physical directory');
}
async function prepareRuntime(input) {
    let lastError;
    for (let index = 0; index < input.options.maxPortAttempts; index += 1) {
        const port = candidatePort(input, index);
        const reservation = input.options.reservePort?.({
            pluginId: input.candidate.pluginId,
            port,
            processGeneration: input.processGeneration,
        });
        if (input.options.reservePort && !reservation)
            continue;
        const deadline = input.options.nowMs() + input.options.runnerStartTimeoutMs;
        let attempt;
        try {
            attempt = await spawnAttempt(input, port);
            const readinessSignal = AbortSignal.any([input.signal, attempt.fatal.signal]);
            await waitForStarted(attempt, readinessSignal, Math.min(input.options.runnerStartTimeoutMs, remaining(deadline, input.options.nowMs)));
            await waitForTcp({
                options: input.options,
                port,
                signal: readinessSignal,
                deadline,
            });
            attempt.startupErrorCapture.complete();
            return preparedRuntime({
                ...input,
                attempt,
                port,
                reservation,
            });
        }
        catch (error) {
            const failure = await selectFailureAfterCleanup(error, () => cleanupFailedPreparation(attempt, reservation, error));
            attachStartupFailureDetail(error, failure);
            attempt?.startupErrorCapture.attachFailure(failure, error);
            lastError = failure;
            if (!retryablePortError(failure) || index + 1 >= input.options.maxPortAttempts)
                throw failure;
        }
    }
    throw (lastError ??
        new MiniAppNodeRuntimeError('NO_CANDIDATE_PORT', 'No Host-approved port is available'));
}
async function cleanupFailedAttempt(attempt, cause) {
    if (!attempt)
        return { postStopErrors: [] };
    return stopAttempt(attempt, cause);
}
async function cleanupFailedPreparation(attempt, reservation, cause) {
    const cleanup = await cleanupFailedAttempt(attempt, cause);
    if (!attempt && isCleanupUnproven(cause))
        throw cause;
    const postStopErrors = [...cleanup.postStopErrors];
    try {
        reservation?.release();
    }
    catch (releaseError) {
        postStopErrors.push(releaseError);
    }
    throwPostStopErrors(postStopErrors);
}
async function spawnAttempt(input, port) {
    const init = {
        type: 'miniapp:init',
        protocolVersion: 1,
        pluginId: input.candidate.pluginId,
        processGeneration: input.processGeneration,
        packageRoot: input.candidate.packageRoot,
        nodeEntry: input.candidate.nodeEntry,
        dataDir: input.dataDir,
        listen: { host: LOOPBACK_HOST, port },
        readiness: {
            startupToken: input.options.makeStartupToken(),
            nodeDigest: input.candidate.nodeDigest,
        },
        hostConnectorPolicy: input.candidate.hostConnectorPolicy,
    };
    const physicalRoot = input.physicalRoots.acquire(input.candidate.pluginId);
    let child;
    try {
        child = input.options.spawn(input.options.execPath, [input.options.runnerPath], {
            cwd: input.candidate.packageRoot,
            detached: false,
            windowsHide: true,
            shell: false,
            env: runnerEnvironment(input.options.env),
            stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
            serialization: 'json',
        });
    }
    catch (error) {
        physicalRoot.release();
        throw error;
    }
    observePhysicalRoot(child, physicalRoot);
    const startupErrorCapture = captureStartupError(child);
    const terminatorOptions = {
        platform: input.options.platform,
    };
    let terminator;
    try {
        terminator = input.options.createTerminator(child, terminatorOptions);
    }
    catch (error) {
        return proveSpawnCleanupAndThrow(startupErrorCapture, createDirectNodeRootTerminator(child, terminatorOptions), error);
    }
    const fatal = new AbortController();
    let connector;
    try {
        connector = createConnectorSession(input, child, fatal);
    }
    catch (error) {
        return proveSpawnCleanupAndThrow(startupErrorCapture, terminator, error);
    }
    captureChildLogs(child, {
        processGeneration: input.processGeneration,
        onLog: input.onLog,
        fatal,
    });
    let shutdownRequested = false;
    let resolveClosed = () => undefined;
    let rejectClosed = () => undefined;
    const closed = new Promise((resolve, reject) => {
        resolveClosed = resolve;
        rejectClosed = reject;
    });
    observeRuntimeOperation(ignoreClosedRejection(closed));
    child.once('error', (error) => fatal.abort(error));
    child.once('exit', (code, signal) => {
        const exit = { code, signal, shutdownRequested };
        if (!exit.shutdownRequested) {
            fatal.abort(new MiniAppNodeRuntimeError('RUNNER_EXITED', 'Runner exited without Host shutdown'));
        }
        observeRuntimeOperation(connector?.close() ?? Promise.resolve());
        resolveClosed(exit);
    });
    return {
        child,
        terminator,
        init,
        ...(connector ? { connector } : {}),
        fatal,
        closed,
        startupErrorCapture,
        rejectClosed,
        markShutdown() {
            shutdownRequested = true;
        },
    };
}
async function proveSpawnCleanup(terminator, cause) {
    let result;
    try {
        result = await terminator.stop();
    }
    catch (cleanupError) {
        throw unproven(cleanupError);
    }
    if (!result.proven)
        throw unproven(cause);
}
async function proveSpawnCleanupAndThrow(startupErrorCapture, terminator, cause) {
    let failure = cause;
    try {
        await proveSpawnCleanup(terminator, cause);
    }
    catch (cleanupError) {
        failure = cleanupError;
    }
    startupErrorCapture.attachFailure(failure, cause);
    throw failure;
}
function createPhysicalRootCapacity(maxPluginServices) {
    const occupants = new Map();
    return {
        acquire(pluginId) {
            if (occupants.has(pluginId)) {
                throw new MiniAppNodeRuntimeError('BUSY', 'Mini App plugin service already owns a direct root', { busyReason: 'operation_busy' });
            }
            if (occupants.size >= maxPluginServices) {
                throw new MiniAppNodeRuntimeError('BUSY', 'At most three distinct MiniApp plugin services may run concurrently', { busyReason: 'capacity_busy' });
            }
            const identity = Symbol(pluginId);
            occupants.set(pluginId, identity);
            let released = false;
            return {
                release() {
                    if (released)
                        return;
                    released = true;
                    if (occupants.get(pluginId) === identity)
                        occupants.delete(pluginId);
                },
            };
        },
    };
}
function observePhysicalRoot(child, ownership) {
    let spawned = child.pid !== undefined;
    const release = () => ownership.release();
    if ((child.exitCode !== null && child.exitCode !== undefined) ||
        (child.signalCode !== null && child.signalCode !== undefined)) {
        release();
        return;
    }
    child.once('spawn', () => {
        spawned = true;
    });
    child.once('error', () => {
        if (!spawned && child.pid === undefined)
            release();
    });
    child.once('exit', release);
}
async function ignoreClosedRejection(closed) {
    try {
        await closed;
    }
    catch {
        // The Supervisor observes terminal cleanup proof through this same promise.
    }
}
function createConnectorSession(input, child, fatal) {
    if (input.candidate.hostConnectorPolicy.kind !== 'allowlist')
        return undefined;
    if (!child.send || child.connected === false || !input.options.hostConnectorSessionFactory) {
        throw new MiniAppNodeRuntimeError('HOST_CONNECTOR_UNAVAILABLE', 'Host Connector IPC or session factory is unavailable');
    }
    return input.options.hostConnectorSessionFactory.create({
        pluginId: input.candidate.pluginId,
        processGeneration: input.processGeneration,
        providers: input.candidate.hostConnectorPolicy.providers,
        transport: child,
        onFatal: (error) => fatal.abort(error),
    });
}
function captureChildLogs(child, options) {
    child.on('message', (raw) => {
        if (isRunnerErrorMessage(raw)) {
            options.fatal.abort(runnerFailure(raw.code, `Mini App runner reported ${raw.code}`, raw.errorText));
            return;
        }
        if (!isRunnerLogMessage(raw))
            return;
        options.onLog(sanitizeMiniAppRuntimeLogEvent({
            processGeneration: options.processGeneration,
            level: raw.level,
            message: raw.message,
            byteLength: Buffer.byteLength(raw.message),
            fieldKeys: raw.fieldKeys,
        }));
    });
    let logWindowStartedAt = Date.now();
    let remainingLogBytes = 64 * 1024;
    const captureStreamLog = (level, chunk) => {
        const now = Date.now();
        if (now - logWindowStartedAt >= 1_000) {
            logWindowStartedAt = now;
            remainingLogBytes = 64 * 1024;
        }
        if (remainingLogBytes <= 0)
            return;
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        const accepted = bytes.subarray(0, Math.min(4 * 1024, remainingLogBytes));
        remainingLogBytes -= accepted.byteLength;
        options.onLog(sanitizeMiniAppRuntimeLogEvent({
            processGeneration: options.processGeneration,
            level,
            message: accepted.toString('utf8').trim(),
            byteLength: bytes.byteLength,
            fieldKeys: [],
        }));
    };
    child.stderr?.on('data', (chunk) => captureStreamLog('error', chunk));
    child.stdout?.on('data', (chunk) => captureStreamLog('info', chunk));
}
function waitForStarted(attempt, signal, timeoutMs) {
    throwIfAborted(signal);
    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (error) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            signal.removeEventListener('abort', onAbort);
            attempt.child.removeListener('message', onMessage);
            attempt.child.removeListener('error', onError);
            attempt.child.removeListener('exit', onExit);
            if (error)
                reject(error);
            else
                resolve();
        };
        const onAbort = () => finish(signal.reason);
        const onError = (error) => finish(error);
        const onExit = () => finish(new MiniAppNodeRuntimeError('RUNNER_EXITED', 'Runner exited before readiness'));
        const onMessage = (raw) => {
            if (isRunnerErrorMessage(raw)) {
                finish(runnerFailure(raw.code, 'Runner rejected MiniApp entry', raw.errorText));
            }
            else if (isRunnerStartedMessage(raw)) {
                const matches = raw.pluginId === attempt.init.pluginId &&
                    raw.processGeneration === attempt.init.processGeneration &&
                    raw.readiness.startupToken === attempt.init.readiness.startupToken &&
                    raw.readiness.nodeDigest === attempt.init.readiness.nodeDigest;
                finish(matches
                    ? undefined
                    : new MiniAppNodeRuntimeError('RUNNER_IDENTITY_MISMATCH', 'Runner identity did not match the candidate'));
            }
        };
        const timer = setTimeout(() => finish(new MiniAppNodeRuntimeError('READINESS_TIMEOUT', 'Runner start timed out')), Math.max(1, timeoutMs));
        timer.unref();
        signal.addEventListener('abort', onAbort, { once: true });
        attempt.child.on('message', onMessage);
        attempt.child.once('error', onError);
        attempt.child.once('exit', onExit);
        try {
            attempt.connector?.startHandshake();
            attempt.child.send?.(attempt.init);
        }
        catch (error) {
            finish(error);
        }
    });
}
async function waitForTcp(input) {
    let lastError;
    for (;;) {
        throwIfAborted(input.signal);
        try {
            await input.options.connectPort({
                host: LOOPBACK_HOST,
                port: input.port,
                timeoutMs: Math.min(input.options.tcpConnectTimeoutMs, remaining(input.deadline, input.options.nowMs)),
                signal: input.signal,
            });
            return;
        }
        catch (error) {
            lastError = error;
        }
        const delay = Math.min(input.options.tcpRetryMs, remaining(input.deadline, input.options.nowMs));
        await input.options.wait(delay, input.signal);
        if (input.options.nowMs() >= input.deadline) {
            throw new MiniAppNodeRuntimeError('READINESS_TIMEOUT', 'TCP readiness timed out', {
                cause: lastError,
            });
        }
    }
}
function preparedRuntime(input) {
    let stopPromise;
    let cleanupPromise;
    let removeRuntimeDirPromise;
    let reservationReleased = false;
    const releaseReservation = () => {
        if (reservationReleased)
            return;
        input.reservation?.release();
        reservationReleased = true;
    };
    input.attempt.child.once('exit', releaseReservation);
    const removeRuntimeDir = () => {
        removeRuntimeDirPromise ??= input.options.removeRuntimeDir(input.runtimeDir);
        return removeRuntimeDirPromise;
    };
    input.attempt.child.once('exit', () => {
        observeRuntimeOperation(removeRuntimeDir());
    });
    const cleanup = () => {
        cleanupPromise ??= (async () => {
            const result = await stopAttempt(input.attempt);
            const postStopErrors = [...result.postStopErrors];
            try {
                releaseReservation();
            }
            catch (releaseError) {
                postStopErrors.push(releaseError);
            }
            try {
                await removeRuntimeDir();
            }
            catch (removeError) {
                postStopErrors.push(removeError);
            }
            throwPostStopErrors(postStopErrors);
            return { proven: true };
        })();
        return cleanupPromise;
    };
    input.attempt.fatal.signal.addEventListener('abort', () => {
        observeRuntimeOperation(cleanupAfterFatal(cleanup, input.attempt.rejectClosed));
    }, { once: true });
    return {
        processGeneration: input.processGeneration,
        nodeDigest: input.candidate.nodeDigest,
        port: input.port,
        origin: `http://${LOOPBACK_HOST}:${input.port}`,
        ...(input.attempt.connector ? { hostConnectorSession: input.attempt.connector } : {}),
        closed: input.attempt.closed,
        stop() {
            input.attempt.markShutdown();
            stopPromise ??= cleanup();
            return stopPromise;
        },
    };
}
async function cleanupAfterFatal(cleanup, rejectClosed) {
    try {
        await cleanup();
    }
    catch (error) {
        if (isCleanupUnproven(error))
            rejectClosed(error);
    }
}
function observeRuntimeOperation(operation) {
    const observed = settleRuntimeOperation(operation, () => runtimeObservations.delete(observed));
    runtimeObservations.add(observed);
}
async function settleRuntimeOperation(operation, complete) {
    try {
        await operation;
    }
    catch {
        // Runtime exit and cleanup proof are observed through the owning lifecycle state.
    }
    finally {
        complete();
    }
}
async function stopAttempt(attempt, cleanupCause) {
    const postStopErrors = [];
    try {
        await attempt.connector?.retire();
    }
    catch (error) {
        postStopErrors.push(error);
    }
    try {
        attempt.child.send?.({ type: 'miniapp:stop' });
    }
    catch {
        // Direct-root exit proof remains authoritative.
    }
    let result;
    try {
        result = await attempt.terminator.stop();
    }
    catch (error) {
        throw unproven(error);
    }
    if (!result.proven) {
        throw unproven(cleanupCause ??
            new MiniAppNodeRuntimeError('NODE_ROOT_TERMINATION_UNPROVEN', 'Mini App direct Node root termination could not be proven'));
    }
    return { proven: true, postStopErrors };
}
function resolveOptions(options) {
    const defaults = {
        execPath: process.execPath,
        runnerPath: fileURLToPath(new URL('./host-runner.js', import.meta.url)),
        platform: process.platform,
        env: process.env,
        spawn: nodeSpawn,
        connectPort: connectMiniAppPort,
        createTerminator: createDirectNodeRootTerminator,
        createRuntimeDir: () => mkdtemp(path.join(os.tmpdir(), 'mavis-miniapp-')),
        lstatPath: lstat,
        removeRuntimeDir: async (directory) => {
            await rm(directory, { recursive: true, force: true });
        },
        ensureDirectory: async (directory) => {
            await mkdir(directory, { recursive: true });
        },
        resolveRealPath: realpath,
        makeStartupToken: randomUUID,
        nowMs: Date.now,
        wait: defaultWait,
        runnerStartTimeoutMs: 10_000,
        tcpConnectTimeoutMs: 500,
        tcpRetryMs: 50,
        maxPortAttempts: 3,
    };
    const defined = Object.fromEntries(Object.entries(options).filter((entry) => entry[1] !== undefined));
    return {
        ...defaults,
        ...defined,
        resolvePluginDataDir: options.resolvePluginDataDir,
        verifyCandidate: options.verifyCandidate,
        materializePackage: options.materializePackage,
        isPortReserved: options.isPortReserved,
    };
}
function assertCapabilities(options, candidate) {
    if (candidate.hostConnectorPolicy.kind === 'allowlist' && !options.hostConnectorSessionFactory) {
        throw new MiniAppNodeRuntimeError('HOST_CONNECTOR_UNAVAILABLE', 'Host Connector session is unavailable');
    }
}
async function resolveDataDir(options, pluginId) {
    const requested = await options.resolvePluginDataDir(pluginId);
    if (!path.isAbsolute(requested))
        throw new MiniAppNodeRuntimeError('PLUGIN_DATA_DIR_INVALID', 'Plugin data directory must be absolute');
    await options.ensureDirectory(requested);
    return options.resolveRealPath(requested);
}
function candidatePort(input, index) {
    const preferred = input.preferredPort;
    const digest = createHash('sha256').update(input.candidate.pluginId).digest();
    const base = preferred !== undefined && preferred >= PORT_MIN && preferred <= PORT_MAX
        ? preferred
        : PORT_MIN + (digest.readUInt32BE(0) % PORT_COUNT);
    let available = 0;
    for (let offset = 0; offset < PORT_COUNT; offset += 1) {
        const port = PORT_MIN + ((base - PORT_MIN + offset) % PORT_COUNT);
        if (input.options.isPortReserved({ pluginId: input.candidate.pluginId, port }))
            continue;
        if (available === index)
            return port;
        available += 1;
    }
    throw new MiniAppNodeRuntimeError('NO_CANDIDATE_PORT', 'No Host-approved port is available');
}
function runnerEnvironment(env) {
    const result = { ELECTRON_RUN_AS_NODE: '1' };
    for (const key of [
        'PATH',
        'Path',
        'SystemRoot',
        'WINDIR',
        'TEMP',
        'TMP',
        'TMPDIR',
        'HOME',
        'USERPROFILE',
        'LANG',
        'LC_ALL',
    ]) {
        if (env[key] !== undefined)
            result[key] = env[key];
    }
    return result;
}
function connectMiniAppPort(input) {
    if (input.signal.aborted)
        return Promise.reject(input.signal.reason);
    return new Promise((resolve, reject) => {
        const socket = createConnection({ host: input.host, port: input.port });
        let settled = false;
        const finish = (error) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            input.signal.removeEventListener('abort', onAbort);
            socket.removeListener('connect', onConnect);
            socket.removeListener('error', onError);
            socket.destroy();
            if (error)
                reject(error);
            else
                resolve();
        };
        const onConnect = () => finish();
        const onError = (error) => finish(error);
        const onAbort = () => finish(input.signal.reason);
        const timer = setTimeout(() => finish(new MiniAppNodeRuntimeError('TCP_CONNECT_TIMEOUT', 'TCP connect timed out')), Math.max(1, input.timeoutMs));
        timer.unref();
        socket.once('connect', onConnect);
        socket.once('error', onError);
        input.signal.addEventListener('abort', onAbort, { once: true });
    });
}
function remaining(deadline, now) {
    const value = deadline - now();
    if (value <= 0)
        throw new MiniAppNodeRuntimeError('READINESS_TIMEOUT', 'Readiness deadline expired');
    return value;
}
function defaultWait(ms, signal) {
    if (signal.aborted)
        return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, ms);
        timer.unref();
        signal.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(signal.reason);
        }, { once: true });
    });
}
function throwIfAborted(signal) {
    if (signal.aborted)
        throw signal.reason;
}
function retryablePortError(error) {
    return errorCode(error) === 'EADDRINUSE';
}
function errorCode(error) {
    return isRecord(error) && typeof error.code === 'string' ? error.code : 'RUNTIME_START_FAILED';
}
function isCleanupUnproven(error) {
    return error instanceof MiniAppCleanupUnprovenError;
}
function throwPostStopErrors(errors) {
    if (errors.length === 1) {
        const [error] = errors;
        if (error && (typeof error === 'object' || typeof error === 'function')) {
            markMiniAppRootTerminationProven(error);
            throw error;
        }
        const aggregate = new AggregateError(errors, 'Mini App post-stop cleanup failed');
        markMiniAppRootTerminationProven(aggregate);
        throw aggregate;
    }
    if (errors.length > 1) {
        const aggregate = new AggregateError(errors, 'Mini App post-stop cleanup failed');
        markMiniAppRootTerminationProven(aggregate);
        throw aggregate;
    }
}
function unproven(cause) {
    return new MiniAppCleanupUnprovenError('Mini App direct Node root termination could not be proven', { cause });
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isRunnerStartedMessage(value) {
    if (!isRecord(value) || value.type !== 'miniapp:started' || !isRecord(value.readiness)) {
        return false;
    }
    return (typeof value.pluginId === 'string' &&
        typeof value.processGeneration === 'string' &&
        typeof value.readiness.startupToken === 'string' &&
        typeof value.readiness.nodeDigest === 'string');
}
function isRunnerLogMessage(value) {
    if (!isRecord(value) || value.type !== 'miniapp:log')
        return false;
    return ((value.level === 'debug' ||
        value.level === 'info' ||
        value.level === 'warn' ||
        value.level === 'error') &&
        typeof value.message === 'string' &&
        Array.isArray(value.fieldKeys) &&
        value.fieldKeys.every((field) => typeof field === 'string'));
}
//# sourceMappingURL=node-runtime.js.map