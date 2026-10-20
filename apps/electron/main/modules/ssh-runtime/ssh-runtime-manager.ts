import { randomUUID } from "node:crypto";
import { createRuntimeTransportFetch } from "@mavis/shared/runtime-transport";
import { RUNTIME_FAILED_CHANNEL, RUNTIME_TRANSPORT_PORT_CHANNEL, RUNTIME_READY_CHANNEL, RUNTIME_TRANSPORT_LOST_CHANNEL } from "../local-runtime/utility/control";
import { SshAppServerClient } from "./app-server-client";
import { SshRuntimeError } from "./errors";
import { isSshPerfEnabled, payloadByteLength, recordSshPerf, sshPerfPathKey } from "./perf";
import { SharedSshGlobalEvents } from "./shared-global-events.js";
const MAIN_PROCESS_REQUEST_OWNER = 'main-process';
/** Owns one SSH app-server connection and renderer-scoped MessagePorts. */
export class SshRuntimeManager {
    constructor(options) {
        this.options = options;
        this.client = null;
        this.connectPromise = null;
        this.connectionGeneration = 0;
        this.retired = false;
        this.rendererAttempts = new Map();
        this.lastError = null;
        this.rendererConnections = new Map();
        this.requestOwners = new Map();
        this.mainFrameListeners = new Set();
        this.mainLostListeners = new Set();
        this.mainFetch = null;
        this.inflightPerf = new Map();
        this.globalEvents = new SharedSshGlobalEvents((request) => this.fetch(request), (frame) => this.forwardServerFrame(frame));
    }
    isReady() {
        return !this.connectPromise && this.client?.isReady() === true;
    }
    getDaemonInstanceId() {
        return this.isReady() ? (this.client?.getDaemonInstanceId?.() ?? null) : null;
    }
    isConnecting() {
        return this.connectPromise !== null;
    }
    getFailReason() {
        return this.lastError
            ? {
                type: this.lastError.code,
                reasonCode: this.lastError.code,
                message: this.lastError.message,
            }
            : null;
    }
    /** Main host controller owns scheduling; the manager performs one attempt. */
    getHostProbe() {
        return this.client?.getHostProbe?.();
    }
    async connect() {
        const result = await this.ensureConnected();
        if (!result.connected)
            throw result.error ?? new SshRuntimeError('ssh_cancelled', 'SSH connection cancelled.');
        this.assertCurrentClient(result.client, result.generation);
    }
    async healthCheck(signal) {
        const client = this.client;
        if (!client?.isReady())
            throw new SshRuntimeError('runtime_connection_lost', 'SSH transport is unavailable.');
        const generation = this.connectionGeneration;
        await client.healthCheck?.(signal);
        this.assertCurrentClient(client, generation);
    }
    async remoteAccount(input) {
        const result = this.readyConnection();
        if (!result.connected) {
            throw (result.error ??
                new SshRuntimeError('runtime_connection_lost', 'The SSH connection is unavailable.'));
        }
        this.assertCurrentClient(result.client, result.generation);
        return result.client.remoteAccount(input);
    }
    async connectRenderer(target) {
        const rendererAttempt = {};
        this.rendererAttempts.set(target.id, rendererAttempt);
        try {
            const result = await this.readyConnection();
            if (this.rendererAttempts.get(target.id) !== rendererAttempt) {
                return { enabled: true, connected: false };
            }
            if (!result.connected) {
                if (result.error &&
                    result.error.code !== 'ssh_cancelled' &&
                    result.generation === this.connectionGeneration) {
                    safeSend(target, RUNTIME_FAILED_CHANNEL, {
                        type: result.error.code,
                        reasonCode: result.error.code,
                        message: result.error.message,
                    });
                }
                return { enabled: true, connected: false };
            }
            let createChannel = this.options.createMessageChannel;
            if (!createChannel) {
                const electron = await import('electron');
                createChannel = () => new electron.MessageChannelMain();
            }
            if (this.rendererAttempts.get(target.id) !== rendererAttempt ||
                this.connectionGeneration !== result.generation ||
                this.client !== result.client ||
                !result.client.isReady()) {
                return { enabled: true, connected: false };
            }
            this.releaseRenderer(target.id);
            const connectionId = randomUUID();
            const { port1, port2 } = createChannel();
            const connection = {
                connectionId,
                target,
                port: port1,
                requestIds: new Set(),
            };
            this.rendererConnections.set(target.id, connection);
            port1.on('message', (event) => {
                void this.forwardRendererFrame(connection, event.data);
            });
            port1.once('close', () => this.releaseRenderer(target.id, connectionId));
            port1.start();
            try {
                target.postMessage(RUNTIME_TRANSPORT_PORT_CHANNEL, { connectionId }, [port2]);
                safeSend(target, RUNTIME_READY_CHANNEL);
                return { enabled: true, connected: true };
            }
            catch {
                this.releaseRenderer(target.id, connectionId);
                safeClosePort(port2);
                this.options.logger?.warn('[SshRuntime] renderer port delivery failed');
                return { enabled: true, connected: false };
            }
        }
        finally {
            if (this.rendererAttempts.get(target.id) === rendererAttempt)
                this.rendererAttempts.delete(target.id);
        }
    }
    /** Fetch-compatible Main-owned connection used by app:// media responses. */
    async fetch(request) {
        const result = await this.readyConnection();
        if (!result.connected ||
            result.generation !== this.connectionGeneration ||
            this.client !== result.client) {
            return new Response(JSON.stringify({ error: 'project_runtime_unavailable' }), {
                status: 503,
                headers: { 'Content-Type': 'application/json' },
            });
        }
        this.mainFetch ?? (this.mainFetch = createRuntimeTransportFetch({ link: this.createMainLink() }));
        return this.mainFetch(request);
    }
    disconnectRenderer(rendererId, _reason) {
        this.rendererAttempts.delete(rendererId);
        this.releaseRenderer(rendererId);
    }
    async stop() {
        this.retired = true;
        this.connectionGeneration += 1;
        this.rendererAttempts.clear();
        this.lastError = null;
        // Closing MessagePortMain alone does not notify preload's fetch streams.
        // Explicit disconnect must invalidate renderer transports just like a loss.
        for (const connection of this.rendererConnections.values()) {
            safeSend(connection.target, RUNTIME_TRANSPORT_LOST_CHANNEL, {
                message: 'The SSH Runtime connection was stopped.',
                reasonCode: 'runtime_connection_stopped',
                connectionId: connection.connectionId,
            });
        }
        for (const rendererId of [...this.rendererConnections.keys()]) {
            this.releaseRenderer(rendererId);
        }
        this.globalEvents.close();
        const client = this.client;
        this.client = null;
        this.connectPromise = null;
        this.notifyMainLost({ message: 'The SSH Runtime connection was stopped.' });
        this.requestOwners.clear();
        if (client)
            await client.stop();
    }
    createMainLink() {
        return {
            post: (frame) => {
                void this.forwardMainFrame(frame);
            },
            subscribe: (listener) => {
                this.mainFrameListeners.add(listener);
                return () => this.mainFrameListeners.delete(listener);
            },
            subscribeLost: (listener) => {
                this.mainLostListeners.add(listener);
                return () => this.mainLostListeners.delete(listener);
            },
        };
    }
    /** Business callers may use a ready generation, but never acquire a new one. */
    readyConnection() {
        if (!this.retired && !this.connectPromise && this.client?.isReady()) {
            return { connected: true, client: this.client, generation: this.connectionGeneration };
        }
        return {
            connected: false,
            generation: this.connectionGeneration,
            ...(this.retired
                ? {}
                : {
                    error: this.lastError ??
                        new SshRuntimeError('runtime_connection_lost', 'The SSH connection is unavailable.'),
                }),
        };
    }
    ensureConnected() {
        if (this.retired)
            return Promise.resolve({ connected: false });
        if (this.connectPromise)
            return this.connectPromise;
        if (this.client?.isReady()) {
            return Promise.resolve({
                connected: true,
                client: this.client,
                generation: this.connectionGeneration,
            });
        }
        const client = this.options.createClient?.() ??
            new SshAppServerClient({
                target: this.options.target,
                clientVersion: this.options.appVersion,
                attemptId: this.options.attemptId,
                diagnosticId: this.options.diagnosticId,
                onPhase: this.options.onPhase,
                executionOptions: this.options.executionOptions,
                initializeTimeoutMs: this.options.executionOptions?.timeoutMs,
                ...(this.options.logger ? { logger: this.options.logger } : {}),
            });
        const generation = ++this.connectionGeneration;
        const isCurrent = () => this.client === client && this.connectionGeneration === generation;
        this.client = client;
        this.lastError = null;
        client.onAccountUpdated?.((account) => {
            if (isCurrent())
                this.options.onAccountUpdated?.(account);
        });
        client.onFrame((frame) => {
            if (isCurrent())
                this.forwardServerFrame(frame);
        });
        client.onLost((error) => {
            if (isCurrent())
                this.handleConnectionLost(client, error);
        });
        const attempt = Promise.resolve()
            .then(() => {
            if (isCurrent())
                return client.start();
        })
            .then(() => {
            if (!isCurrent())
                return { connected: false };
            this.lastError = null;
            this.options.onReady?.();
            return { connected: true, client, generation };
        })
            .catch((error) => {
            const failure = asSshRuntimeError(error);
            const current = isCurrent();
            if (current) {
                this.client = null;
                this.lastError = failure.code === 'ssh_cancelled' ? null : failure;
            }
            // A cancelled attempt may settle after a fresh attempt has already started.
            if (this.client !== client)
                void client.stop().catch(() => undefined);
            if (!current || failure.code === 'ssh_cancelled')
                return { connected: false };
            this.options.logger?.warn(`[SshRuntime] connection failed: ${failure.message}`);
            return { connected: false, error: failure, generation };
        })
            .finally(() => {
            if (this.connectPromise === attempt)
                this.connectPromise = null;
        });
        this.connectPromise = attempt;
        return attempt;
    }
    assertCurrentClient(client, generation = this.connectionGeneration) {
        if (this.client !== client || generation !== this.connectionGeneration || !client.isReady()) {
            throw new SshRuntimeError('runtime_connection_lost', 'The SSH connection changed before the request could be sent.');
        }
    }
    async forwardRendererFrame(connection, value) {
        if (this.rendererConnections.get(connection.target.id) !== connection)
            return;
        const metadata = frameMetadata(value);
        if (!metadata)
            return;
        if (metadata.type === 'request') {
            const currentOwner = this.requestOwners.get(metadata.id);
            if (currentOwner !== undefined && currentOwner !== connection.target.id) {
                postServerFrame(connection.port, transportErrorFrame(metadata.id, 'duplicate_request_id'));
                return;
            }
            this.requestOwners.set(metadata.id, connection.target.id);
            connection.requestIds.add(metadata.id);
            this.beginRequestPerf(value, 'renderer');
        }
        else if (this.requestOwners.get(metadata.id) !== connection.target.id) {
            return;
        }
        try {
            const client = this.client;
            if (!client) {
                throw new SshRuntimeError('runtime_connection_lost', 'The SSH Runtime connection is unavailable.');
            }
            if (metadata.type === 'request') {
                this.assertCurrentClient(client);
                if (this.rendererConnections.get(connection.target.id) !== connection)
                    return;
            }
            if (this.globalEvents.handle(value))
                return;
            await client.sendFrame(value);
        }
        catch (error) {
            if (metadata.type === 'request')
                this.releaseRequest(metadata.id);
            postServerFrame(connection.port, transportErrorFrame(metadata.id, 'runtime_connection_lost'));
            this.options.logger?.warn(`[SshRuntime] frame forwarding failed: ${String(error)}`);
        }
    }
    async forwardMainFrame(frame) {
        const metadata = frameMetadata(frame);
        if (!metadata)
            return;
        if (metadata.type === 'request') {
            if (this.requestOwners.has(metadata.id)) {
                this.emitMainFrame(transportErrorFrame(metadata.id, 'duplicate_request_id'));
                return;
            }
            this.requestOwners.set(metadata.id, MAIN_PROCESS_REQUEST_OWNER);
            this.beginRequestPerf(frame, 'main');
        }
        else if (this.requestOwners.get(metadata.id) !== MAIN_PROCESS_REQUEST_OWNER) {
            return;
        }
        try {
            const client = this.client;
            if (!client) {
                throw new SshRuntimeError('runtime_connection_lost', 'The SSH Runtime connection is unavailable.');
            }
            if (metadata.type === 'request')
                this.assertCurrentClient(client);
            await client.sendFrame(frame);
        }
        catch (error) {
            if (metadata.type === 'request')
                this.releaseRequest(metadata.id);
            this.emitMainFrame(transportErrorFrame(metadata.id, 'runtime_connection_lost'));
            this.options.logger?.warn(`[SshRuntime] Main fetch forwarding failed: ${String(error)}`);
        }
    }
    /**
     * Start timing one DesktopService round trip.
     *
     * The remote workspace path is recorded as a short digest instead of the raw
     * value so a diagnostic log can be grouped per file without carrying the
     * user's remote directory layout.
     */
    beginRequestPerf(frame, origin) {
        if (!isSshPerfEnabled() || !isRecord(frame) || typeof frame.id !== 'string')
            return;
        const method = typeof frame.method === 'string' ? frame.method : 'UNKNOWN';
        const rawUrl = typeof frame.url === 'string' ? frame.url : '';
        const described = describeRequestUrl(rawUrl);
        const body = frame.body;
        const requestBytes = payloadByteLength(typeof body === 'string' || body instanceof Uint8Array ? body : undefined);
        const route = `${method}:${described.path}`;
        this.inflightPerf.set(frame.id, {
            route,
            startedAt: Date.now(),
            requestBytes,
            firstFrameAt: null,
            chunks: 0,
            responseBytes: 0,
            status: null,
        });
        recordSshPerf('app-server.request.start', {
            lane: 'app-server',
            id: frame.id,
            route,
            origin,
            target: described.target,
            offset: described.offset,
            length: described.length,
            requestBytes,
            inflight: this.inflightPerf.size,
        });
    }
    observeServerFramePerf(frame) {
        if (this.inflightPerf.size === 0)
            return;
        const record = this.inflightPerf.get(frame.id);
        if (!record)
            return;
        const now = Date.now();
        if (record.firstFrameAt === null)
            record.firstFrameAt = now;
        if (frame.type === 'response-start') {
            record.status = frame.status;
            recordSshPerf('app-server.response.start', {
                lane: 'app-server',
                id: frame.id,
                route: record.route,
                status: frame.status,
                ttfbMs: now - record.startedAt,
                inflight: this.inflightPerf.size,
            });
            return;
        }
        if (frame.type === 'stream-chunk') {
            record.chunks += 1;
            record.responseBytes += payloadByteLength(frame.payload);
            return;
        }
        if (frame.type === 'stream-done') {
            this.finishRequestPerf(frame.id, 'ok');
            return;
        }
        if (frame.type === 'stream-error') {
            this.finishRequestPerf(frame.id, 'error', frame.code);
        }
    }
    finishRequestPerf(id, outcome, code) {
        const record = this.inflightPerf.get(id);
        if (!record)
            return;
        this.inflightPerf.delete(id);
        recordSshPerf('app-server.request.end', {
            lane: 'app-server',
            id,
            route: record.route,
            outcome,
            code,
            status: record.status ?? undefined,
            ttfbMs: record.firstFrameAt === null ? undefined : record.firstFrameAt - record.startedAt,
            totalMs: Date.now() - record.startedAt,
            chunks: record.chunks,
            requestBytes: record.requestBytes,
            responseBytes: record.responseBytes,
            inflight: this.inflightPerf.size,
        });
    }
    forwardServerFrame(frame) {
        this.observeServerFramePerf(frame);
        const owner = this.requestOwners.get(frame.id);
        if (owner === undefined) {
            this.options.logger?.warn(`[SshRuntime] response for unknown request ${frame.id}`);
            return;
        }
        if (owner === MAIN_PROCESS_REQUEST_OWNER) {
            this.emitMainFrame(frame);
            if (frame.type === 'stream-done' || frame.type === 'stream-error') {
                this.releaseRequest(frame.id);
            }
            return;
        }
        const rendererId = owner;
        const connection = this.rendererConnections.get(rendererId);
        if (!connection) {
            this.releaseRequest(frame.id);
            return;
        }
        postServerFrame(connection.port, frame);
        if (frame.type === 'stream-done' || frame.type === 'stream-error') {
            this.releaseRequest(frame.id);
        }
    }
    handleConnectionLost(client, error) {
        if (this.client !== client)
            return;
        this.globalEvents.close();
        this.connectionGeneration += 1;
        this.client = null;
        this.connectPromise = null;
        this.lastError = error;
        const connections = [...this.rendererConnections.values()];
        this.rendererConnections.clear();
        this.requestOwners.clear();
        for (const requestId of [...this.inflightPerf.keys()]) {
            this.finishRequestPerf(requestId, 'dropped', error.code);
        }
        this.notifyMainLost({ message: error.message });
        for (const connection of connections) {
            safeSend(connection.target, RUNTIME_TRANSPORT_LOST_CHANNEL, {
                message: error.message,
                reasonCode: error.code,
                connectionId: connection.connectionId,
            });
            safeClosePort(connection.port);
        }
        this.options.onLost?.(error);
    }
    releaseRenderer(rendererId, expectedConnectionId) {
        const connection = this.rendererConnections.get(rendererId);
        if (!connection || (expectedConnectionId && connection.connectionId !== expectedConnectionId)) {
            return;
        }
        this.rendererConnections.delete(rendererId);
        for (const requestId of connection.requestIds) {
            if (this.requestOwners.get(requestId) !== rendererId)
                continue;
            if (this.globalEvents.release(requestId)) {
                this.releaseRequest(requestId);
                continue;
            }
            this.requestOwners.delete(requestId);
            void this.client
                ?.sendFrame({ type: 'abort', id: requestId, reason: 'renderer disconnected' })
                .catch(() => undefined);
        }
        safeClosePort(connection.port);
    }
    releaseRequest(requestId) {
        this.finishRequestPerf(requestId, 'dropped');
        const owner = this.requestOwners.get(requestId);
        this.requestOwners.delete(requestId);
        if (typeof owner === 'number') {
            this.rendererConnections.get(owner)?.requestIds.delete(requestId);
        }
    }
    emitMainFrame(frame) {
        for (const listener of this.mainFrameListeners)
            listener(frame);
    }
    notifyMainLost(info) {
        for (const listener of this.mainLostListeners)
            listener(info);
    }
}

function safeSend(target, channel, message) {
    try {
        if (message === undefined)
            target.send(channel);
        else
            target.send(channel, message);
    }
    catch {
        // A destroyed WebContents is already disconnected from the product.
    }
}
/**
 * Split one RuntimeTransport request URL into perf-safe labels.
 *
 * Only the route and the range parameters are kept verbatim; anything that can
 * carry a remote path is reduced to a stable short digest.
 */
function describeRequestUrl(rawUrl) {
    if (!rawUrl)
        return { path: 'unknown', target: undefined, offset: undefined, length: undefined };
    const queryStart = rawUrl.indexOf('?');
    const path = stripOrigin(queryStart < 0 ? rawUrl : rawUrl.slice(0, queryStart));
    if (queryStart < 0) {
        return { path, target: undefined, offset: undefined, length: undefined };
    }
    const params = new URLSearchParams(rawUrl.slice(queryStart + 1));
    const identity = `${params.get('workspace') ?? ''}:${params.get('path') ?? ''}`;
    return {
        path,
        target: identity === ':' ? undefined : sshPerfPathKey(identity),
        offset: params.get('offset') ?? undefined,
        length: params.get('length') ?? undefined,
    };
}
/**
 * Drop the scheme and authority so records group by route. Callers build URLs
 * against several different origins for the same logical route, which would
 * otherwise split one route across multiple aggregation buckets.
 */
function stripOrigin(value) {
    const schemeEnd = value.indexOf('://');
    if (schemeEnd < 0)
        return value;
    const pathStart = value.indexOf('/', schemeEnd + 3);
    return pathStart < 0 ? '/' : value.slice(pathStart);
}
function frameMetadata(value) {
    if (!isRecord(value) || typeof value.id !== 'string')
        return null;
    if (value.type !== 'request' && value.type !== 'stream-credit' && value.type !== 'abort') {
        return null;
    }
    return { type: value.type, id: value.id };
}
function transportErrorFrame(id, code) {
    return {
        type: 'stream-error',
        id,
        seq: 0,
        code,
        message: code === 'duplicate_request_id' ? 'Duplicate request id.' : 'SSH Runtime unavailable.',
    };
}
function postServerFrame(port, frame) {
    try {
        port.postMessage(frame);
    }
    catch {
        // The renderer lifecycle handler owns connection cleanup.
    }
}
function safeClosePort(port) {
    try {
        port.close();
    }
    catch {
        // MessagePorts may already be closed by their renderer context.
    }
}
function asSshRuntimeError(error) {
    if (error instanceof Error && error.name === 'AbortError') {
        return new SshRuntimeError('ssh_cancelled', 'The SSH connection attempt was cancelled.');
    }
    return error instanceof SshRuntimeError
        ? error
        : new SshRuntimeError('remote_mcode_start_failed', String(error));
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
