import { spawn as nodeSpawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_RUNNING_MINIAPP_SERVICES, MINIAPP_LOOPBACK_HEALTH_PATH, MINIAPP_LOOPBACK_TOKEN_HEADER, } from '../../contracts.js';
import { selectFailureAfterCleanup } from '../../supervisor/cleanup-settlement.js';
import { MiniAppCleanupUnprovenError, markMiniAppRootTerminationProven } from '../../errors.js';
import { sanitizeMiniAppRuntimeLogEvent } from '../../runtime-log.js';
import { isMiniAppListenPortErrorCode } from './host-runner.js';
import { createDirectNodeRootTerminator, } from './direct-root.js';
import { attachStartupFailureDetail, captureStartupError, isRunnerErrorMessage, MiniAppNodeRuntimeError, runnerFailure, } from './node-runtime-startup-error.js';
const LOOPBACK_HOST = '127.0.0.1';
const PORT_MIN = 49_152;
const PORT_MAX = 65_535;
const PORT_COUNT = PORT_MAX - PORT_MIN + 1;
/**
 * Odd, so it is coprime with PORT_COUNT (2^14): one launch walks a full permutation of the
 * range without repeats. The first five raw candidates are pairwise >= 1637 ports apart, which
 * keeps a Windows excluded-port block from swallowing the whole retry budget. Skipping reserved
 * ports advances the cursor, so attempted ports keep the no-repeat guarantee but not the spacing.
 */
const PORT_STRIDE = 6_007;
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
    // One credential per process generation; port retries reuse it with a fresh startupToken.
    const loopbackToken = input.options.makeLoopbackToken();
    let lastError;
    const candidates = candidatePortSequence(input);
    for (let index = 0; index < input.options.maxPortAttempts; index += 1) {
        const port = candidates.next();
        if (port === undefined) {
            throw new MiniAppNodeRuntimeError('NO_CANDIDATE_PORT', 'No Host-approved port is available');
        }
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
            attempt = await spawnAttempt(input, port, loopbackToken);
            const readinessSignal = AbortSignal.any([input.signal, attempt.fatal.signal]);
            await waitForStarted(attempt, readinessSignal, {
                deadline,
                timeoutMs: input.options.runnerStartTimeoutMs,
                nowMs: input.options.nowMs,
            });
            await waitForLoopbackReadiness({
                options: input.options,
                port,
                loopbackToken,
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
async function spawnAttempt(input, port, loopbackToken) {
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
        loopbackToken,
        hostConnectorPolicy: input.candidate.hostConnectorPolicy,
        agentPolicy: input.candidate.agentPolicy ?? { kind: 'deny-all' },
        toolPolicy: input.candidate.toolPolicy ?? { kind: 'deny-all' },
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
    const { hostConnectorPolicy, agentPolicy, toolPolicy } = input.candidate;
    if (!needsConnectorChannel(input.candidate))
        return undefined;
    if (!child.send || child.connected === false || !input.options.hostConnectorSessionFactory) {
        throw new MiniAppNodeRuntimeError('HOST_CONNECTOR_UNAVAILABLE', 'Host Connector IPC or session factory is unavailable');
    }
    return input.options.hostConnectorSessionFactory.create({
        pluginId: input.candidate.pluginId,
        processGeneration: input.processGeneration,
        providers: hostConnectorPolicy.kind === 'allowlist' ? hostConnectorPolicy.providers : [],
        ...(agentPolicy ? { agentPolicy } : {}),
        ...(toolPolicy ? { toolPolicy } : {}),
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
function waitForStarted(attempt, signal, budget) {
    throwIfAborted(signal);
    const remainingMs = deadlineBudget(budget.deadline, budget.nowMs);
    if (remainingMs <= 0)
        return Promise.reject(readinessTimeout('started'));
    const timeoutMs = Math.min(budget.timeoutMs, remainingMs);
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
        const timer = setTimeout(() => finish(readinessTimeout('started')), Math.max(1, timeoutMs));
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
async function waitForLoopbackReadiness(input) {
    let lastError;
    let lastRejection;
    for (;;) {
        throwIfAborted(input.signal);
        const budget = deadlineBudget(input.deadline, input.options.nowMs);
        if (budget <= 0)
            throw readinessTimeout('loopback-auth', lastRejection ?? lastError);
        try {
            await input.options.probeReadiness({
                host: LOOPBACK_HOST,
                port: input.port,
                loopbackToken: input.loopbackToken,
                timeoutMs: Math.min(input.options.readinessProbeTimeoutMs, budget),
                signal: input.signal,
            });
            return;
        }
        catch (error) {
            throwIfAborted(input.signal);
            lastError = error;
            if (isProbeRejection(error))
                lastRejection = error;
        }
        const left = deadlineBudget(input.deadline, input.options.nowMs);
        // A capped final probe may time out at the deadline; keep the last status mismatch as the reason.
        if (left <= 0)
            throw readinessTimeout('loopback-auth', lastRejection ?? lastError);
        await input.options.wait(Math.min(input.options.readinessRetryMs, left), input.signal);
    }
}
/** Non-throwing time remaining before `deadline`, as observed through `nowMs`. */
function deadlineBudget(deadline, nowMs) {
    return deadline - nowMs();
}
function readinessTimeout(stage, reason) {
    if (stage === 'started') {
        return new MiniAppNodeRuntimeError('READINESS_TIMEOUT', 'Runner start readiness timed out');
    }
    const message = 'Loopback auth probe readiness timed out';
    return new MiniAppNodeRuntimeError('READINESS_TIMEOUT', isProbeRejection(reason) ? `${message}: ${reason.message}` : message, reason === undefined ? undefined : { cause: reason });
}
function isProbeRejection(error) {
    return error instanceof MiniAppNodeRuntimeError && error.code === 'READINESS_PROBE_REJECTED';
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
        loopbackToken: input.attempt.init.loopbackToken,
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
        probeReadiness: probeMiniAppLoopbackAuth,
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
        makeLoopbackToken: () => randomBytes(32).toString('base64url'),
        nowMs: Date.now,
        wait: defaultWait,
        runnerStartTimeoutMs: 10_000,
        readinessProbeTimeoutMs: 500,
        readinessRetryMs: 50,
        maxPortAttempts: 5,
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
    // Agent calls share the connector IPC session, so its absence surfaces with the same code.
    if (candidate.agentPolicy?.kind === 'allowlist' && !options.hostConnectorSessionFactory) {
        throw new MiniAppNodeRuntimeError('HOST_CONNECTOR_UNAVAILABLE', 'Mini App Agent IPC session is unavailable');
    }
    if (candidate.toolPolicy?.kind === 'allowlist' && !options.hostConnectorSessionFactory) {
        throw new MiniAppNodeRuntimeError('HOST_CONNECTOR_UNAVAILABLE', 'Mini App tool IPC session is unavailable');
    }
}
/** Connector, Agent and tool access share one `miniapp:connector` IPC session. */
function needsConnectorChannel(candidate) {
    return (candidate.hostConnectorPolicy.kind === 'allowlist' ||
        candidate.agentPolicy?.kind === 'allowlist' ||
        candidate.toolPolicy?.kind === 'allowlist');
}
async function resolveDataDir(options, pluginId) {
    const requested = await options.resolvePluginDataDir(pluginId);
    if (!path.isAbsolute(requested))
        throw new MiniAppNodeRuntimeError('PLUGIN_DATA_DIR_INVALID', 'Plugin data directory must be absolute');
    await options.ensureDirectory(requested);
    return options.resolveRealPath(requested);
}
/**
 * Candidate 0 is the persisted preferred port (or the plugin's stable hash, unchanged from
 * earlier releases). The sequence is created once per launch and only moves forward, so a port
 * that already failed is never retried even when other reservations change meanwhile.
 */
function candidatePortSequence(input) {
    const pluginId = input.candidate.pluginId;
    const preferred = input.preferredPort;
    const digest = createHash('sha256').update(pluginId).digest();
    const first = preferred !== undefined && preferred >= PORT_MIN && preferred <= PORT_MAX
        ? preferred
        : PORT_MIN + (digest.readUInt32BE(0) % PORT_COUNT);
    let step = 0;
    return {
        next() {
            while (step < PORT_COUNT) {
                const port = PORT_MIN + ((first - PORT_MIN + step * PORT_STRIDE) % PORT_COUNT);
                step += 1;
                if (!input.options.isPortReserved({ pluginId, port }))
                    return port;
            }
            return undefined;
        },
    };
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
/**
 * Proves the Host guard owns the port: an anonymous health check must be rejected
 * before the authenticated one is answered by the guard itself.
 */
async function probeMiniAppLoopbackAuth(input) {
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(new MiniAppNodeRuntimeError('READINESS_PROBE_TIMEOUT', 'Loopback auth probe request timed out')), Math.max(1, input.timeoutMs));
    timer.unref();
    const signal = AbortSignal.any([input.signal, timeout.signal]);
    try {
        const anonymous = await requestLoopbackHealth(input, signal, undefined);
        if (anonymous !== 401) {
            throw probeRejected(`unauthenticated health probe expected 401, received ${anonymous}`);
        }
        const authenticated = await requestLoopbackHealth(input, signal, input.loopbackToken);
        if (authenticated !== 204) {
            throw probeRejected(`authenticated health probe expected 204, received ${authenticated}`);
        }
    }
    finally {
        clearTimeout(timer);
    }
}
function probeRejected(message) {
    return new MiniAppNodeRuntimeError('READINESS_PROBE_REJECTED', message);
}
function requestLoopbackHealth(input, signal, token) {
    if (signal.aborted)
        return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (outcome) => {
            if (settled)
                return;
            settled = true;
            signal.removeEventListener('abort', onAbort);
            if ('status' in outcome) {
                resolve(outcome.status);
                return;
            }
            request.destroy();
            reject(outcome.error);
        };
        const request = httpRequest({
            host: input.host,
            port: input.port,
            method: 'GET',
            path: MINIAPP_LOOPBACK_HEALTH_PATH,
            agent: false,
            headers: token ? { [MINIAPP_LOOPBACK_TOKEN_HEADER]: token } : {},
        }, (response) => {
            response.on('error', () => undefined);
            response.resume();
            finish({ status: response.statusCode ?? 0 });
        });
        const onAbort = () => finish({ error: signal.reason });
        request.on('error', (error) => finish({ error }));
        signal.addEventListener('abort', onAbort, { once: true });
        request.end();
    });
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
/** Only runner-confirmed listen failures are retryable; Host-side spawn/fs errors keep their raw code. */
function retryablePortError(error) {
    return isMiniAppListenPortErrorCode(errorCode(error));
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