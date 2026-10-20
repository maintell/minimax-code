import { decodeRemoteAccount, decodeRemoteLogin } from "./remote-account";
import { Duplex } from "node:stream";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { isSafeAbsoluteRemotePath } from "./config";
import { SshRuntimeError, classifySshFailure, sshFailureDetails } from "./errors";
import { sshExecution, isSshLaunchModeFailure } from "./ssh-execution.js";
import { SshOutputProtocol } from "./ssh-output-protocol.js";
import { parseProbeOutput } from "./host-probe";
import { prepareSshAuthentication } from "./ssh-authentication";
import { stopOwnedSsh, spawnOwnedSsh } from "./ssh-process.js";
import { startSshPerfSpan, isSshPerfEnabled, recordSshPerf } from "./perf";
import { startSshDiagnostic } from "./diagnostics.js";
import { resolveSshRuntimeEnvironment, buildSshAppServerSpawnSpec, SSH_BOOTSTRAP_PROBE_END } from "./ssh-command";
const INITIALIZE_ID = 'mcode-desktop-initialize';
const DEFAULT_INITIALIZE_TIMEOUT_MS = 60000;
const DEFAULT_HEALTH_TIMEOUT_MS = 10000;
const MAX_BOOTSTRAP_BYTES = 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const RECEIVE_SLOW_LINE_MS = 5;
const RECEIVE_SUMMARY_EVERY_LINES = 200;
export class SshAppServerClient {
    constructor(options) {
        this.options = options;
        this.child = null;
        this.generation = 0;
        this.connecting = null;
        this.outputProtocol = null;
        this.websocket = null;
        this.bootstrapIdentity = null;
        this.pendingAccount = new Map();
        this.pendingHealth = new Map();
        this.protocol = null;
        this.startPromise = null;
        this.resolveInitialize = null;
        this.rejectInitialize = null;
        this.initializeTimer = null;
        this.receiveQueue = Promise.resolve();
        this.receiveQueueDepth = 0;
        this.receiveLines = 0;
        this.receiveBytes = 0;
        this.receiveWaitTotalMs = 0;
        this.receiveWaitMaxMs = 0;
        this.receiveProcessTotalMs = 0;
        this.receiveDepthMax = 0;
        this.writeQueue = Promise.resolve();
        this.stdoutBuffer = Buffer.alloc(0);
        this.binaryPayloadEncoding = 'base64';
        this.stderrBuffer = '';
        this.stdoutBytes = 0;
        this.stderrBytes = 0;
        this.remoteStderrObserved = false;
        this.ready = false;
        this.awaitingDiscovery = false;
        this.accountMethods = new Set();
        this.stopping = false;
        this.lostNotified = false;
        this.accountListeners = new Set();
        this.frameListeners = new Set();
        this.lostListeners = new Set();
    }
    isReady() {
        return this.ready;
    }
    /** Available only after initialize confirms the daemon identity from bootstrap. */
    getDaemonInstanceId() {
        const instanceId = this.ready ? this.bootstrapIdentity?.instanceId : undefined;
        return typeof instanceId === 'string' && instanceId.length > 0 ? instanceId : null;
    }
    getHostProbe() {
        if (!this.ready)
            return undefined;
        return {
            ...this.hostProbe,
            alias: this.options.target.host,
            status: 'ready',
            mcodePath: this.hostProbe?.mcodePath ?? this.options.target.mcodePath,
            mcodeVersion: this.bootstrapIdentity?.version,
        };
    }
    onAccountUpdated(listener) {
        this.accountListeners.add(listener);
        return () => this.accountListeners.delete(listener);
    }
    onFrame(listener) {
        this.frameListeners.add(listener);
        return () => this.frameListeners.delete(listener);
    }
    onLost(listener) {
        this.lostListeners.add(listener);
        return () => this.lostListeners.delete(listener);
    }
    start() {
        if (this.startPromise)
            return this.startPromise;
        const environment = this.options.runtimeEnvironment ?? resolveSshRuntimeEnvironment();
        this.runtimeEnvironment = environment;
        const diagnostics = startSshDiagnostic('app-server', {
            alias: this.options.target.host,
            mcodePath: this.options.target.mcodePath,
            buildEnv: environment.buildEnv,
            region: environment.region,
            clientVersion: this.options.clientVersion,
        }, this.options.diagnosticId, this.options.attemptId);
        this.diagnostics = diagnostics;
        const attempt = this.startInternal().catch((error) => {
            diagnostics.fail(error, { phase: 'initialize' });
            if (this.startPromise === attempt)
                this.startPromise = null;
            throw error;
        });
        this.startPromise = attempt;
        return attempt;
    }
    async sendFrame(frame) {
        if (!this.ready || !this.protocol || !this.child) {
            throw new SshRuntimeError('runtime_connection_lost', 'The SSH Runtime connection is not ready.');
        }
        const encoded = this.protocol.encodeAppServerDesktopServiceClientFrame(frame);
        await this.sendMessage({
            method: this.protocol.APP_SERVER_DESKTOP_SERVICE_METHOD,
            params: { frame: encoded },
        });
    }
    /** Verify this daemon's WebSocket loop without consulting account/business state. */
    healthCheck(signal, timeoutMs = DEFAULT_HEALTH_TIMEOUT_MS) {
        const websocket = this.websocket;
        if (signal?.aborted) {
            return Promise.reject(new SshRuntimeError('ssh_cancelled', 'SSH health check cancelled.'));
        }
        if (!this.ready || !websocket || websocket.readyState !== WebSocket.OPEN) {
            return Promise.reject(new SshRuntimeError('runtime_connection_lost', 'The SSH Runtime connection is not ready.'));
        }
        const id = randomUUID();
        const diagnostics = startSshDiagnostic('app-server.health', {}, this.diagnostics?.id, this.options.attemptId ?? this.diagnostics?.attemptId);
        return new Promise((resolve, reject) => {
            let settled = false;
            const finish = (error) => {
                if (settled)
                    return;
                settled = true;
                clearTimeout(timer);
                signal?.removeEventListener('abort', onAbort);
                this.pendingHealth.delete(id);
                if (error) {
                    diagnostics.fail(error, { phase: 'health' });
                    reject(error);
                }
                else {
                    diagnostics.record('completed');
                    resolve();
                }
            };
            const onAbort = () => finish(new SshRuntimeError('ssh_cancelled', 'SSH health check cancelled.'));
            const timer = setTimeout(() => finish(new SshRuntimeError('runtime_connection_lost', 'The SSH Runtime health check timed out.')), Number.isFinite(timeoutMs) ? Math.max(1, timeoutMs) : DEFAULT_HEALTH_TIMEOUT_MS);
            this.pendingHealth.set(id, { websocket, finish });
            signal?.addEventListener('abort', onAbort, { once: true });
            if (signal?.aborted)
                onAbort();
            else {
                try {
                    websocket.ping(id, undefined, (error) => {
                        if (error)
                            finish(new SshRuntimeError('runtime_connection_lost', 'Unable to check the SSH Runtime connection.'));
                    });
                }
                catch {
                    finish(new SshRuntimeError('runtime_connection_lost', 'Unable to check the SSH Runtime connection.'));
                }
            }
        });
    }
    async remoteAccount(input) {
        const protocol = this.protocol;
        if (!this.ready || !protocol)
            throw new Error('The SSH connection is not ready.');
        const methods = {
            read: protocol.APP_SERVER_ACCOUNT_READ_METHOD,
            login: protocol.APP_SERVER_ACCOUNT_LOGIN_START_METHOD,
            logout: protocol.APP_SERVER_ACCOUNT_LOGOUT_METHOD,
            cancel: protocol.APP_SERVER_ACCOUNT_LOGIN_CANCEL_METHOD,
        };
        const result = await this.accountRequest(methods[input.action], input.action === 'cancel' ? { loginId: input.loginId } : undefined);
        if (input.action !== 'login')
            return decodeRemoteAccount(result);
        if (isRecord(result) && result.state === 'authenticated') {
            return decodeRemoteAccount(result);
        }
        const pendingLogin = decodeRemoteLogin(result);
        const account = decodeRemoteAccount(await this.accountRequest(methods.read));
        return account.state === 'authenticated' ? account : { ...account, pendingLogin };
    }
    accountRequest(method, params) {
        if (!this.accountMethods.has(method)) {
            return Promise.reject(new Error('This remote service does not support this account action.'));
        }
        const id = `remote-account-${randomUUID()}`;
        const startedAt = performance.now();
        this.diagnostics?.record('remote-account.started', { method });
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pendingAccount.delete(id);
                this.diagnostics?.record('remote-account.failed', {
                    method,
                    durationMs: performance.now() - startedAt,
                    reason: 'timeout',
                });
                reject(new Error('The remote account operation timed out. Retry without disconnecting SSH.'));
            }, 30000);
            this.pendingAccount.set(id, {
                resolve: (result) => {
                    clearTimeout(timer);
                    this.diagnostics?.record('remote-account.completed', {
                        method,
                        durationMs: performance.now() - startedAt,
                    });
                    resolve(result);
                },
                reject: (error) => {
                    clearTimeout(timer);
                    this.diagnostics?.record('remote-account.failed', {
                        method,
                        durationMs: performance.now() - startedAt,
                    });
                    reject(error);
                },
            });
            void this.sendMessage({ id, method, ...(params ? { params } : {}) }).catch((error) => {
                this.pendingAccount.get(id)?.reject(error);
                this.pendingAccount.delete(id);
            });
        });
    }
    async stop() {
        this.diagnostics?.record('stopped', {
            ...this.commandEvidence(),
            ready: this.ready,
            stderr: this.stderrBuffer,
        });
        this.connecting?.abort();
        this.generation += 1;
        this.stopping = true;
        this.closeWebSocket();
        this.clearInitializeTimer();
        const child = this.child;
        this.child = null;
        this.ready = false;
        this.accountMethods.clear();
        this.binaryPayloadEncoding = 'base64';
        this.startPromise = null;
        this.rejectPendingInitialize(new SshRuntimeError('ssh_cancelled', 'The SSH Runtime connection was stopped.'));
        if (!child)
            return;
        if (this.options.spawnProcess) {
            if (child.exitCode === null && child.signalCode === null)
                child.kill('SIGTERM');
        }
        else
            await stopOwnedSsh(child);
    }
    async startInternal() {
        const generation = ++this.generation;
        const connecting = new AbortController();
        this.connecting = connecting;
        this.stopping = false;
        this.lostNotified = false;
        this.stdoutBuffer = Buffer.alloc(0);
        this.hostProbe = undefined;
        this.awaitingDiscovery = !this.options.target.mcodePath;
        this.bootstrapIdentity = null;
        this.outputProtocol = null;
        this.stderrBuffer = '';
        this.stdoutBytes = 0;
        this.stderrBytes = 0;
        this.binaryPayloadEncoding = 'base64';
        this.remoteStderrObserved = false;
        const connectSpan = startSshPerfSpan('app-server.connect', { lane: 'app-server' });
        const protocol = await (this.options.loadProtocol ?? loadAppServerTransportModule)();
        if (generation !== this.generation) {
            throw new SshRuntimeError('ssh_cancelled', 'The SSH connection attempt was cancelled.');
        }
        this.protocol = protocol;
        connectSpan.mark('protocol-loaded');
        const mode = await (this.options.selectMode ?? ((endpoint, options) => sshExecution.selectMode(endpoint, options)))(this.options.target.endpoint, {
            ...this.options.executionOptions,
            signal: connecting.signal,
            diagnostics: this.diagnostics,
            attemptId: this.options.attemptId,
        });
        if (generation !== this.generation)
            throw new SshRuntimeError('ssh_cancelled', 'SSH connection cancelled.');
        const spec = buildSshAppServerSpawnSpec(this.options.target, this.runtimeEnvironment, Boolean(this.options.executionOptions?.confirmHostKey));
        const outputProtocol = new SshOutputProtocol();
        this.outputProtocol = outputProtocol;
        const script = outputProtocol.streamScript(spec.args[spec.args.length - 1]);
        const args = [...spec.args.slice(0, -1), ...(mode === 'exec' ? [script] : [])];
        let child;
        const authentication = await prepareSshAuthentication(this.options.target.endpoint, {
            ...this.options.executionOptions,
            signal: connecting.signal,
        });
        if (generation !== this.generation) {
            authentication?.dispose();
            throw new SshRuntimeError('ssh_cancelled', 'SSH connection cancelled.');
        }
        try {
            this.options.onPhase?.('probing');
            if (generation !== this.generation) {
                throw new SshRuntimeError('ssh_cancelled', 'SSH connection cancelled.');
            }
            child = this.options.spawnProcess
                ? this.options.spawnProcess(spec.command, args)
                : spawnOwnedSsh(args, authentication?.env);
            child.once('close', () => authentication?.dispose());
            child.once('error', () => authentication?.dispose());
        }
        catch (error) {
            authentication?.dispose();
            if (error instanceof SshRuntimeError)
                throw error;
            throw sshSpawnError(error, this.ready);
        }
        this.child = child;
        this.diagnostics?.record('spawned', { ...this.commandEvidence(), mode, pid: child.pid });
        // Everything after this point includes the SSH handshake plus the remote
        // `mcode app-server` cold start, which is the dominant cost of opening a
        // project and is invisible from any per-request timing.
        connectSpan.mark('spawned');
        const initialized = new Promise((resolve, reject) => {
            this.resolveInitialize = resolve;
            this.rejectInitialize = reject;
        });
        this.initializeTimer = setTimeout(() => {
            this.fail(new SshRuntimeError('app_server_initialize_timeout', 'Timed out while initializing the remote MCode app-server.'));
        }, this.options.initializeTimeoutMs ?? DEFAULT_INITIALIZE_TIMEOUT_MS);
        this.bindChild(child);
        try {
            if (mode === 'shell-stdin')
                child.stdin.write(outputProtocol.shellInput(script));
        }
        catch (error) {
            this.fail(sshSpawnError(error, this.ready));
        }
        return initialized.then((result) => {
            connectSpan.end({ outcome: 'ok' });
            return result;
        }, (error) => {
            connectSpan.end({
                outcome: 'error',
                code: error instanceof SshRuntimeError ? error.code : 'unknown',
            });
            throw error;
        });
    }
    async sendInitialize() {
        const protocol = this.protocol;
        if (!protocol)
            throw new SshRuntimeError('runtime_connection_lost', 'The SSH protocol is unavailable.');
        await this.sendMessage({
            id: INITIALIZE_ID,
            method: 'initialize',
            params: {
                protocolVersion: protocol.APP_SERVER_PROTOCOL_VERSION,
                clientInfo: {
                    name: 'mcode-desktop',
                    title: 'MCode Desktop',
                    version: this.options.clientVersion,
                },
                capabilities: {
                    desktopService: {
                        transportProtocolVersion: protocol.APP_SERVER_DESKTOP_SERVICE_CAPABILITIES.transportProtocolVersion,
                        // Additive: a server that does not know this field ignores it and
                        // keeps sending base64, which is exactly the fallback we want.
                        binaryPayloadEncodings: [...protocol.APP_SERVER_BINARY_PAYLOAD_ENCODINGS],
                    },
                },
            },
        });
    }
    bindChild(child) {
        const protocol = this.protocol;
        if (!protocol)
            throw new SshRuntimeError('runtime_connection_lost', 'The SSH protocol is unavailable.');
        const diagnostics = this.diagnostics;
        const outputProtocol = this.outputProtocol;
        let stdoutBytes = 0;
        let stderrBytes = 0;
        let commandStartedRecorded = false;
        child.stdout.on('data', (chunk) => {
            stdoutBytes += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.byteLength;
            if (this.child === child)
                this.stdoutBytes = stdoutBytes;
        });
        child.once('close', (exitCode, signal) => {
            diagnostics?.record('ssh-process.closed', {
                commandStarted: outputProtocol?.hasStarted() ?? false,
                stdoutBytes,
                stderrBytes,
                exitCode,
                signal,
            });
        });
        const onBootstrap = (chunk) => {
            if (this.child !== child)
                return;
            let bytes;
            try {
                bytes =
                    this.outputProtocol?.acceptStart(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk) ?? null;
            }
            catch {
                this.fail(new SshRuntimeError('ssh_channel_invalid', 'SSH startup output exceeded its limit.'));
                return;
            }
            if (bytes === null)
                return;
            if (!commandStartedRecorded) {
                commandStartedRecorded = true;
                this.options.onPhase?.('starting');
                diagnostics?.record('ssh-command.started', this.commandEvidence());
            }
            this.stdoutBuffer =
                this.stdoutBuffer.byteLength === 0 ? bytes : Buffer.concat([this.stdoutBuffer, bytes]);
            if (this.stdoutBuffer.byteLength > MAX_BOOTSTRAP_BYTES) {
                this.fail(new SshRuntimeError('app_server_protocol_error', 'Oversized daemon bootstrap response.'));
                return;
            }
            if (this.awaitingDiscovery) {
                const end = Buffer.from(`${SSH_BOOTSTRAP_PROBE_END}\n`);
                const index = this.stdoutBuffer.indexOf(end);
                if (index < 0)
                    return;
                const probe = parseProbeOutput(this.options.target.host, this.stdoutBuffer.subarray(0, index).toString('utf8'));
                if (probe.status !== 'ready' ||
                    !probe.mcodePath ||
                    !isSafeAbsoluteRemotePath(probe.mcodePath)) {
                    this.fail(new SshRuntimeError(probe.status === 'cli_missing' ? 'remote_mcode_not_found' : 'ssh_channel_invalid', 'The remote CLI path could not be discovered.'));
                    return;
                }
                this.hostProbe = probe;
                this.stdoutBuffer = this.stdoutBuffer.subarray(index + end.length);
                this.awaitingDiscovery = false;
            }
            // Our fallback record is newline-delimited even when an old CLI writes no stdout.
            while (this.stdoutBuffer[0] === 0x0a)
                this.stdoutBuffer = this.stdoutBuffer.subarray(1);
            const newline = this.stdoutBuffer.indexOf(0x0a);
            if (newline < 0)
                return;
            child.stdout.off('data', onBootstrap);
            child.stdout.pause();
            try {
                const output = JSON.parse(this.stdoutBuffer.subarray(0, newline).toString('utf8'));
                const environment = this.runtimeEnvironment;
                if (isRecord(output) && isRecord(output.state)) {
                    const state = output.state;
                    const fields = Object.fromEntries([
                        'status',
                        'error',
                        'stderrLogPath',
                        'version',
                        'protocolVersion',
                        'authMode',
                        'region',
                        'buildEnv',
                        'instanceId',
                    ]
                        .filter((key) => typeof state[key] === 'string' || typeof state[key] === 'number')
                        .map((key) => [key, state[key]]));
                    this.diagnostics?.record('bootstrap', { ...this.commandEvidence(), ...fields });
                }
                if (isRecord(output) &&
                    output.action === 'bootstrap' &&
                    isRecord(output.state) &&
                    output.state.status === 'failed') {
                    const state = output.state;
                    const stderr = typeof state.stderrBase64 === 'string'
                        ? Buffer.from(state.stderrBase64.slice(0, 16384), 'base64').toString('utf8')
                        : typeof state.error === 'string'
                            ? state.error
                            : this.stderrBuffer;
                    const failure = classifySshFailure(stderr, false, true);
                    failure.details = sshFailureDetails(failure.code, {
                        sshVerified: true,
                        stage: 'bootstrap',
                        stderr,
                        mcodePath: this.hostProbe?.mcodePath ?? this.options.target.mcodePath,
                        version: typeof state.version === 'string' ? state.version : undefined,
                        exitCode: typeof state.exitCode === 'number' ? state.exitCode : undefined,
                    });
                    throw failure;
                }
                if (isRecord(output) &&
                    isRecord(output.state) &&
                    output.state.status === 'ready' &&
                    ((typeof output.state.authMode === 'string' &&
                        output.state.authMode !== 'remote-oauth') ||
                        (typeof output.state.region === 'string' &&
                            output.state.region !== environment.region) ||
                        (typeof output.state.buildEnv === 'string' &&
                            output.state.buildEnv !== environment.buildEnv))) {
                    throw new SshRuntimeError('remote_mcode_profile_mismatch', 'The running MCode service uses a different environment or authentication mode.');
                }
                if (!isRecord(output) ||
                    output.action !== 'bootstrap' ||
                    !isRecord(output.state) ||
                    output.state.status !== 'ready' ||
                    output.state.authMode !== 'remote-oauth' ||
                    output.state.protocolVersion !== protocol.APP_SERVER_PROTOCOL_VERSION ||
                    output.state.region !== environment.region ||
                    output.state.buildEnv !== environment.buildEnv ||
                    typeof output.state.instanceId !== 'string' ||
                    typeof output.state.version !== 'string') {
                    throw new SshRuntimeError('app_server_protocol_mismatch', 'The remote service did not return the required protocol and profile identity.');
                }
                this.bootstrapIdentity = output.state;
                if (this.stdoutBuffer
                    .subarray(newline + 1)
                    .toString('utf8')
                    .trim()) {
                    throw new SshRuntimeError('app_server_protocol_error', 'Unexpected output after daemon bootstrap.');
                }
                this.stdoutBuffer = Buffer.alloc(0);
                this.openWebSocket(child);
            }
            catch (error) {
                this.fail(asProtocolError(error));
            }
        };
        child.stdout.on('data', onBootstrap);
        child.stderr.on('data', (chunk) => {
            stderrBytes += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.byteLength;
            if (this.child !== child)
                return;
            this.stderrBytes = stderrBytes;
            const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
            this.stderrBuffer = `${this.stderrBuffer}${text}`.slice(-MAX_STDERR_BYTES);
            if (!this.remoteStderrObserved && text.trim()) {
                this.remoteStderrObserved = true;
                // Remote stderr can contain credentials or private workspace paths.
                // Only the dev/test diagnostic channel persists a sanitized, bounded tail.
                this.options.logger?.warn('[SshRuntime] remote mcode emitted diagnostics on stderr');
            }
        });
        child.stdin.on('error', (error) => {
            if (this.child === child)
                this.fail(sshSpawnError(error, this.ready));
        });
        child.once('error', (error) => {
            if (this.child === child)
                this.fail(sshSpawnError(error, this.ready));
        });
        child.once('exit', (code, signal) => {
            if (this.stopping || this.child !== child)
                return;
            this.diagnostics?.record('exited', { ...this.commandEvidence(), exitCode: code, signal });
            this.options.logger?.warn(`[SshRuntime] SSH process exited code=${String(code)} signal=${String(signal)}`);
            this.fail(classifySshFailure(this.stderrBuffer, this.ready, this.outputProtocol?.hasStarted()), { exitCode: code, signal });
        });
    }
    /** Standard WebSocket framing over the SSH proxy; no local TCP listener. */
    openWebSocket(child) {
        const protocol = this.protocol;
        if (!protocol)
            return;
        const stream = Duplex.from({ readable: child.stdout, writable: child.stdin });
        const websocketOptions = {
            createConnection: () => stream,
            maxPayload: protocol.DEFAULT_APP_SERVER_MAX_MESSAGE_BYTES,
            perMessageDeflate: false,
            handshakeTimeout: this.options.initializeTimeoutMs ?? DEFAULT_INITIALIZE_TIMEOUT_MS,
            // A jump host can retain stdout after the remote proxy closes. Bound the
            // close handshake so recovery starts without waiting for that SSH EOF.
            closeTimeout: 1000,
        };
        const websocket = new WebSocket('ws://mcode.local/', websocketOptions);
        this.websocket = websocket;
        websocket.once('open', () => {
            if (this.child !== child)
                return;
            this.diagnostics?.record('websocket.open');
            this.options.onPhase?.('initializing');
            if (this.child !== child)
                return;
            void this.sendInitialize().catch((error) => {
                if (this.child === child)
                    this.fail(asProtocolError(error));
            });
        });
        websocket.on('message', (data, isBinary) => {
            if (this.child !== child)
                return;
            const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
            if (isBinary) {
                const result = protocol.readAppServerBinaryFrame(bytes, {
                    maxPayloadBytes: protocol.DEFAULT_APP_SERVER_MAX_MESSAGE_BYTES,
                });
                if (result.status !== 'frame' || result.consumed !== bytes.byteLength) {
                    this.fail(new SshRuntimeError('app_server_protocol_error', 'Invalid binary WebSocket record.'));
                    return;
                }
                this.enqueueBinaryFrame(result.frame);
            }
            else {
                this.enqueueLine(bytes.toString('utf8'));
            }
        });
        websocket.on('pong', (bytes) => {
            const pending = this.pendingHealth.get(bytes.toString('utf8'));
            if (pending?.websocket === websocket && this.websocket === websocket && this.ready)
                pending.finish();
        });
        websocket.once('error', () => {
            if (this.child === child && !this.stopping)
                this.fail(classifySshFailure(this.stderrBuffer, this.ready));
        });
        websocket.once('close', (code, reason) => {
            if (this.child !== child || this.stopping)
                return;
            this.diagnostics?.record('websocket.closed', {
                ...this.commandEvidence(),
                code,
                reason: reason.toString('utf8'),
            });
            this.fail(classifySshFailure(this.stderrBuffer, this.ready));
        });
    }
    /**
     * Binary frames are only accepted once the server named the encoding in its
     * `initialize` result. Anything earlier, or on a base64 connection, is a
     * protocol violation rather than something to decode optimistically.
     */
    enqueueBinaryFrame(frame) {
        const generation = this.generation;
        this.receiveQueue = this.receiveQueue
            .then(() => {
            if (generation !== this.generation)
                return;
            this.processBinaryFrame(frame);
        })
            .catch((error) => {
            if (generation === this.generation)
                this.fail(asProtocolError(error));
        });
    }
    processBinaryFrame(frame) {
        if (this.binaryPayloadEncoding !== 'binaryFrame') {
            this.fail(new SshRuntimeError('app_server_protocol_error', 'The remote app-server sent a binary frame without negotiating binary framing.'));
            return;
        }
        const { type, id, seq } = frame.header;
        if (type !== 'stream-chunk' ||
            typeof id !== 'string' ||
            !id ||
            !Number.isSafeInteger(seq) ||
            seq < 0) {
            this.fail(new SshRuntimeError('app_server_protocol_error', 'The remote app-server sent an invalid binary stream-chunk frame.'));
            return;
        }
        const decoded = {
            type: 'stream-chunk',
            id,
            seq: seq,
            payload: frame.bytes,
        };
        for (const listener of [...this.frameListeners])
            listener(decoded);
    }
    enqueueLine(line) {
        const generation = this.generation;
        if (!isSshPerfEnabled()) {
            this.receiveQueue = this.receiveQueue
                .then(() => (generation === this.generation ? this.processLine(line) : undefined))
                .catch((error) => {
                if (generation === this.generation)
                    this.fail(asProtocolError(error));
            });
            return;
        }
        const enqueuedAt = Date.now();
        this.receiveQueueDepth += 1;
        const depthAtEnqueue = this.receiveQueueDepth;
        this.receiveQueue = this.receiveQueue
            .then(async () => {
            const startedAt = Date.now();
            try {
                if (generation === this.generation)
                    await this.processLine(line);
            }
            finally {
                this.receiveQueueDepth -= 1;
                this.recordReceiveTiming(line.length, depthAtEnqueue, startedAt - enqueuedAt, Date.now() - startedAt);
            }
        })
            .catch((error) => {
            if (generation === this.generation)
                this.fail(asProtocolError(error));
        });
    }
    /**
     * Inbound lines are handled strictly one at a time, so any non-zero wait is
     * direct evidence that an earlier line delayed this one. Individual lines are
     * only logged past a threshold; the rest are folded into a periodic summary
     * so a multi-megabyte transfer cannot flood the log.
     */
    recordReceiveTiming(bytes, queueDepth, waitMs, processMs) {
        this.receiveLines += 1;
        this.receiveBytes += bytes;
        this.receiveWaitTotalMs += waitMs;
        this.receiveProcessTotalMs += processMs;
        if (waitMs > this.receiveWaitMaxMs)
            this.receiveWaitMaxMs = waitMs;
        if (queueDepth > this.receiveDepthMax)
            this.receiveDepthMax = queueDepth;
        if (waitMs >= RECEIVE_SLOW_LINE_MS || processMs >= RECEIVE_SLOW_LINE_MS) {
            recordSshPerf('app-server.receive.slow', {
                lane: 'app-server',
                bytes,
                queueDepth,
                waitMs,
                processMs,
            });
        }
        if (this.receiveLines % RECEIVE_SUMMARY_EVERY_LINES !== 0)
            return;
        recordSshPerf('app-server.receive.summary', {
            lane: 'app-server',
            lines: this.receiveLines,
            bytes: this.receiveBytes,
            waitTotalMs: this.receiveWaitTotalMs,
            waitMaxMs: this.receiveWaitMaxMs,
            processTotalMs: this.receiveProcessTotalMs,
            queueDepthMax: this.receiveDepthMax,
        });
        this.receiveWaitMaxMs = 0;
        this.receiveDepthMax = 0;
    }
    async processLine(line) {
        const protocol = this.protocol;
        if (!protocol)
            return;
        const parsed = protocol.parseAppServerMessage(line);
        if (!parsed.ok) {
            throw new SshRuntimeError('app_server_protocol_error', parsed.error.message);
        }
        const message = parsed.message;
        if (protocol.isAppServerResponse(message)) {
            await this.processResponse(message);
            return;
        }
        if (protocol.isAppServerNotification(message) &&
            message.method === protocol.APP_SERVER_DESKTOP_SERVICE_METHOD) {
            const decoded = protocol.decodeAppServerDesktopServiceServerFrame((message.params ?? {}).frame);
            if (!decoded.ok) {
                throw new SshRuntimeError('app_server_protocol_error', decoded.message);
            }
            for (const listener of [...this.frameListeners])
                listener(decoded.frame);
        }
        if (protocol.isAppServerNotification(message) && message.method === 'account/updated') {
            // Optional account state must never tear down an otherwise healthy SSH transport.
            try {
                const account = decodeRemoteAccount(message.params);
                for (const listener of this.accountListeners) {
                    try {
                        listener(account);
                    }
                    catch {
                        /* Independent account observers. */
                    }
                }
            }
            catch {
                /* Ignore invalid optional projections; account/read exposes actionable errors. */
            }
        }
        // Unknown optional notifications and future server requests are ignored.
    }
    async processResponse(message) {
        const pendingAccount = typeof message.id === 'string' ? this.pendingAccount.get(message.id) : undefined;
        if (pendingAccount) {
            this.pendingAccount.delete(message.id);
            if (message.error)
                pendingAccount.reject(new Error(message.error.message));
            else
                pendingAccount.resolve(message.result);
            return;
        }
        if (message.id !== INITIALIZE_ID || this.ready)
            return;
        const protocol = this.protocol;
        if (!protocol)
            return;
        if (message.error) {
            throw new SshRuntimeError('app_server_protocol_mismatch', `Remote app-server initialization failed: ${message.error.message}`);
        }
        const result = validateInitializeResult(message.result, protocol, this.bootstrapIdentity);
        const generation = this.generation;
        await this.sendMessage({ method: 'initialized' });
        if (generation !== this.generation)
            return;
        this.accountMethods = new Set(result.capabilities.methods);
        // Only trust an encoding the server named for this connection, and only
        // one this build can actually decode.
        this.binaryPayloadEncoding = protocol.negotiateAppServerBinaryPayloadEncoding([
            result.capabilities.desktopService?.negotiatedBinaryPayloadEncoding,
        ]);
        this.ready = true;
        this.diagnostics?.record('ready', {
            ...this.commandEvidence(),
            serverVersion: result.serverInfo.version,
            instanceId: result.hostIdentity?.instanceId,
            binaryPayloadEncoding: this.binaryPayloadEncoding,
        });
        this.clearInitializeTimer();
        const resolve = this.resolveInitialize;
        this.resolveInitialize = null;
        this.rejectInitialize = null;
        resolve?.(result);
        this.options.logger?.info(`[SshRuntime] connected to ${result.serverInfo.name} ${result.serverInfo.version}`);
        recordSshPerf('app-server.negotiated', {
            lane: 'app-server',
            binaryPayloadEncoding: this.binaryPayloadEncoding,
        });
    }
    sendMessage(message) {
        const protocol = this.protocol;
        const child = this.child;
        const websocket = this.websocket;
        if (!protocol || !child || !websocket || websocket.readyState !== WebSocket.OPEN) {
            return Promise.reject(new SshRuntimeError('runtime_connection_lost', 'The SSH Runtime stdin is unavailable.'));
        }
        const line = protocol.serializeAppServerMessage(message);
        const write = this.writeQueue.then(() => new Promise((resolve, reject) => {
            websocket.send(line.trimEnd(), (error) => {
                if (error)
                    reject(error);
                else
                    resolve();
            });
        }));
        this.writeQueue = write.catch(() => undefined);
        return write;
    }
    commandEvidence() {
        return {
            commandStarted: this.outputProtocol?.hasStarted() ?? false,
            stdoutBytes: this.stdoutBytes,
            stderrBytes: this.stderrBytes,
            exitCode: this.child?.exitCode ?? null,
            signal: this.child?.signalCode ?? null,
        };
    }
    fail(error, exit) {
        error.details ?? (error.details = sshFailureDetails(error.code, {
            sshVerified: this.outputProtocol?.hasStarted() ?? false,
            stage: !this.outputProtocol?.hasStarted()
                ? 'ssh'
                : this.bootstrapIdentity
                    ? 'initialize'
                    : 'bootstrap',
            stderr: this.stderrBuffer,
            mcodePath: this.hostProbe?.mcodePath ?? this.options.target.mcodePath,
            version: this.bootstrapIdentity?.version,
            exitCode: exit?.exitCode ?? this.child?.exitCode,
        }));
        Object.assign(error, this.commandEvidence(), exit);
        this.diagnostics?.fail(error, {
            ready: this.ready,
            stderr: this.stderrBuffer,
        });
        if (!this.outputProtocol?.hasStarted() && isSshLaunchModeFailure(error)) {
            sshExecution.invalidateModes(this.options.target.endpoint);
        }
        this.generation += 1;
        this.clearInitializeTimer();
        const wasReady = this.ready;
        this.ready = false;
        this.accountMethods.clear();
        this.binaryPayloadEncoding = 'base64';
        this.startPromise = null;
        this.rejectPendingInitialize(error);
        const child = this.child;
        this.child = null;
        this.closeWebSocket();
        if (child) {
            if (this.options.spawnProcess) {
                if (child.exitCode === null && child.signalCode === null)
                    child.kill('SIGTERM');
            }
            else
                void stopOwnedSsh(child);
        }
        if (wasReady && !this.lostNotified) {
            this.lostNotified = true;
            for (const listener of [...this.lostListeners])
                listener(error);
        }
    }
    rejectPendingInitialize(error) {
        const reject = this.rejectInitialize;
        this.resolveInitialize = null;
        this.rejectInitialize = null;
        reject?.(error);
    }
    closeWebSocket() {
        const websocket = this.websocket;
        this.websocket = null;
        websocket?.terminate();
        for (const pending of this.pendingHealth.values()) {
            pending.finish(new SshRuntimeError(this.stopping ? 'ssh_cancelled' : 'runtime_connection_lost', 'The SSH connection was closed during a health check.'));
        }
        for (const pending of this.pendingAccount.values()) {
            pending.reject(new SshRuntimeError('runtime_connection_lost', 'The SSH connection was closed.'));
        }
        this.pendingAccount.clear();
    }
    clearInitializeTimer() {
        if (!this.initializeTimer)
            return;
        clearTimeout(this.initializeTimer);
        this.initializeTimer = null;
    }
}

function importEsm(specifier) {
    if (process.env.VITEST === 'true')
        return import(specifier);
    // eslint-disable-next-line no-new-func -- Preserve native import in Electron's CommonJS main.
    const dynamicImport = new Function('specifier', 'return import(specifier)');
    return dynamicImport(specifier);
}
async function loadAppServerTransportModule() {
    const [protocol, frames] = await Promise.all([
        importEsm('@minimax/mcode-app-server-protocol'),
        importEsm('@mavis/shared/app-server-transport'),
    ]);
    return { ...protocol, ...frames };
}
function sshSpawnError(error, ready) {
    if (isNodeError(error) &&
        [
            'ECONNRESET',
            'ECONNREFUSED',
            'ECONNABORTED',
            'ETIMEDOUT',
            'EHOSTUNREACH',
            'ENETUNREACH',
            'EPIPE',
        ].includes(error.code ?? '')) {
        return new SshRuntimeError(ready ? 'runtime_connection_lost' : 'ssh_host_unreachable', ready ? 'The SSH Runtime connection was lost.' : 'The SSH host is unreachable.');
    }
    if (isNodeError(error) && error.code === 'ENOENT') {
        return new SshRuntimeError('ssh_not_found', 'The OpenSSH client executable was not found.');
    }
    return new SshRuntimeError('remote_mcode_start_failed', 'Failed to launch the SSH client process.');
}
function asProtocolError(error) {
    if (error instanceof SshRuntimeError)
        return error;
    return new SshRuntimeError('app_server_protocol_error', String(error));
}
function validateInitializeResult(value, protocol, identity) {
    if (!protocol || !isRecord(value)) {
        throw new SshRuntimeError('app_server_protocol_mismatch', 'Remote app-server returned an invalid initialize result.');
    }
    const serverInfo = value.serverInfo;
    const capabilities = value.capabilities;
    const desktopService = isRecord(capabilities) ? capabilities.desktopService : undefined;
    if (value.protocolVersion !== protocol.APP_SERVER_PROTOCOL_VERSION ||
        !identity ||
        !isRecord(value.hostIdentity) ||
        value.hostIdentity.instanceId !== identity.instanceId ||
        value.hostIdentity.version !== identity.version ||
        value.hostIdentity.protocolVersion !== identity.protocolVersion ||
        value.hostIdentity.authMode !== 'remote-oauth' ||
        value.hostIdentity.region !== identity.region ||
        value.hostIdentity.buildEnv !== identity.buildEnv ||
        !isRecord(serverInfo) ||
        typeof serverInfo.name !== 'string' ||
        typeof serverInfo.version !== 'string' ||
        !isRecord(capabilities) ||
        !Array.isArray(capabilities.methods) ||
        !capabilities.methods.every((method) => typeof method === 'string') ||
        !capabilities.methods.includes(protocol.APP_SERVER_DESKTOP_SERVICE_METHOD) ||
        (capabilities.auth !== undefined &&
            (!isRecord(capabilities.auth) || capabilities.auth.mode !== 'remote-oauth')) ||
        (capabilities.clientNotifications !== undefined &&
            (!Array.isArray(capabilities.clientNotifications) ||
                !capabilities.clientNotifications.every((method) => typeof method === 'string'))) ||
        !isRecord(desktopService) ||
        desktopService.transportProtocolVersion !==
            protocol.APP_SERVER_DESKTOP_SERVICE_CAPABILITIES.transportProtocolVersion) {
        throw new SshRuntimeError('app_server_protocol_mismatch', 'Remote MCode app-server uses an incompatible transport protocol.');
    }
    return value;
}
function isNodeError(value) {
    return value instanceof Error && 'code' in value;
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
