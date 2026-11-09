import { randomUUID } from "node:crypto";
import { isSafeBrokerRequestId, isStrictStructuredCloneValue } from "./control";
let sshSource;
let rcDeviceIdProvider;
/** Registered by the SSH projects IPC once its registry exists; cleared on shutdown. */
export function registerRemoteSessionSshSource(source) {
    sshSource = source;
}
/** Registered by the Remote Control bridge, which owns this desktop's RC identity. */
export function registerRemoteSessionRcDeviceIdProvider(provider) {
    rcDeviceIdProvider = provider;
}
const MAX_TEXT = 4096;
const SSH_RUNTIME_ORIGIN = 'http://ssh-runtime';
const DESKTOP_API = '/minimax-desktop/api/v1';
const REQUEST_TIMEOUT_MS = 30000;
/** Upper bound on a forwarded message, well above any model-written session send. */
const MAX_REMOTE_MESSAGE = 256 * 1024;
/**
 * The only SSH reads the broker forwards. The one write, SendRemoteMessage, is
 * built separately by {@link remoteMessageRequest}.
 */
const SSH_READS = {
    ListProjectSessions: (read) => {
        if (read.method !== 'ListProjectSessions' || !isText(read.workspaceDir))
            return undefined;
        if (read.agentName !== undefined && !isText(read.agentName))
            return undefined;
        if (read.cursor !== undefined && !isText(read.cursor))
            return undefined;
        if (read.limit !== undefined && !isPageSize(read.limit))
            return undefined;
        const url = new URL(`${DESKTOP_API}/project/sessions`, SSH_RUNTIME_ORIGIN);
        url.searchParams.set('workspace_dir', read.workspaceDir);
        if (read.agentName)
            url.searchParams.set('agent_name', read.agentName);
        if (read.limit !== undefined)
            url.searchParams.set('limit', String(read.limit));
        if (read.cursor)
            url.searchParams.set('cursor', read.cursor);
        return url;
    },
    GetSession: (read) => {
        if (read.method !== 'GetSession' || !isSessionId(read.sessionId))
            return undefined;
        return new URL(`${DESKTOP_API}/session/${encodeURIComponent(read.sessionId)}`, SSH_RUNTIME_ORIGIN);
    },
    GetMessages: (read) => {
        if (read.method !== 'GetMessages' || !isSessionId(read.sessionId))
            return undefined;
        if (read.before !== undefined && !isText(read.before))
            return undefined;
        if (read.limit !== undefined && !isPageSize(read.limit))
            return undefined;
        const url = new URL(`${DESKTOP_API}/session/${encodeURIComponent(read.sessionId)}/message`, SSH_RUNTIME_ORIGIN);
        if (read.limit !== undefined)
            url.searchParams.set('limit', String(read.limit));
        if (read.before)
            url.searchParams.set('before', read.before);
        return url;
    },
};
/** Main-side handler; one per utility process manager. */
export class MainOwnedRemoteSessionBroker {
    constructor(options = {}) {
        this.pending = new Map();
        this.options = {
            getSshSource: options.getSshSource ?? (() => sshSource),
            getRcDeviceId: options.getRcDeviceId ?? (() => rcDeviceIdProvider?.()),
            ...(options.logger ? { logger: options.logger } : {}),
        };
    }
    handleMessage(target, value) {
        if (!isRecord(value))
            return false;
        if (value.type === 'remote-session-abort') {
            if (isSafeBrokerRequestId(value.requestId))
                this.take(target, value.requestId)?.abort();
            return true;
        }
        if (value.type !== 'remote-session-request')
            return false;
        if (!isSafeBrokerRequestId(value.requestId))
            return true;
        const requestId = value.requestId;
        if (!isRequestMessage(value) || this.pending.get(target)?.has(requestId)) {
            this.warn(`refused request ${requestId}: invalid_request (malformed or duplicate)`);
            post(target, { type: 'remote-session-error', requestId, code: 'invalid_request' });
            return true;
        }
        const controller = new AbortController();
        let byTarget = this.pending.get(target);
        if (!byTarget)
            this.pending.set(target, (byTarget = new Map()));
        byTarget.set(requestId, controller);
        void this.run(value, controller.signal).then((result) => {
            if (this.take(target, requestId) !== controller)
                return;
            post(target, isStrictStructuredCloneValue(result)
                ? { type: 'remote-session-result', requestId, result }
                : { type: 'remote-session-error', requestId, code: 'request_failed' });
        }, (error) => {
            if (this.take(target, requestId) !== controller)
                return;
            const code = controller.signal.aborted ? 'aborted' : brokerErrorCode(error);
            if (code !== 'aborted') {
                const reason = isRecord(error) && isText(error.reason) ? ` (${error.reason})` : '';
                this.warn(`${describeRequest(value)} failed: ${code}${reason}`);
            }
            post(target, { type: 'remote-session-error', requestId, code });
        });
        return true;
    }
    /** The utility process went away; abort its in-flight reads. */
    releaseTarget(target) {
        const byTarget = this.pending.get(target);
        this.pending.delete(target);
        for (const controller of byTarget?.values() ?? [])
            controller.abort();
    }
    async run(message, signal) {
        if (message.op === 'rc-device-id') {
            const deviceId = await this.options.getRcDeviceId();
            return isText(deviceId) ? deviceId : null;
        }
        const source = this.options.getSshSource();
        if (!source)
            throw brokerError('ssh_unavailable');
        const projects = source.listProjects();
        if (message.op === 'ssh-projects')
            return projects;
        const project = projects.find((item) => item.runtimeId === message.runtimeId);
        if (!project)
            throw brokerError('project_not_found');
        if (message.op === 'ssh-send') {
            const request = remoteMessageRequest(message.send, signal);
            if (!request)
                throw brokerError('invalid_request', 'arguments_rejected');
            return forwardSend(source, message.runtimeId, request);
        }
        // A project may only list its own workspace, never another path on the same host.
        // A missing workspace is rejected below with the other malformed arguments.
        if (message.read.method === 'ListProjectSessions' &&
            isText(message.read.workspaceDir) &&
            trimSlash(message.read.workspaceDir) !== trimSlash(project.workspaceDir))
            throw brokerError('invalid_request', 'workspace_mismatch');
        const url = SSH_READS[message.read.method]?.(message.read);
        if (!url)
            throw brokerError('invalid_request', 'arguments_rejected');
        return forward(source, message.runtimeId, new Request(url, {
            signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
        }));
    }
    warn(message) {
        try {
            this.options.logger?.warn(`[RemoteSessionBroker] ${message}`);
        }
        catch {
            // Logging never changes the reply.
        }
    }
    take(target, requestId) {
        const byTarget = this.pending.get(target);
        const controller = byTarget?.get(requestId);
        byTarget?.delete(requestId);
        if (byTarget?.size === 0)
            this.pending.delete(target);
        return controller;
    }
}

/** Utility-side client; its `host` is the Runtime's remote session port. */
export class UtilityRemoteSessionBrokerClient {
    constructor(options) {
        this.options = options;
        this.pending = new Map();
        this.closed = false;
        this.host = {
            listSshProjects: async (signal) => (await this.request({ op: 'ssh-projects' }, signal)),
            readSsh: async (runtimeId, read, signal) => (await this.request({ op: 'ssh-read', runtimeId, read }, signal)),
            sendSsh: async (runtimeId, send, signal) => (await this.request({ op: 'ssh-send', runtimeId, send }, signal)),
            getRemoteControlDeviceId: async (signal) => {
                const deviceId = await this.request({ op: 'rc-device-id' }, signal);
                return typeof deviceId === 'string' && deviceId ? deviceId : undefined;
            },
        };
    }
    handleMessage(value) {
        if (!isRecord(value))
            return false;
        if (value.type !== 'remote-session-result' && value.type !== 'remote-session-error')
            return false;
        if (!isSafeBrokerRequestId(value.requestId))
            return true;
        const pending = this.pending.get(value.requestId);
        if (!pending)
            return true;
        this.pending.delete(value.requestId);
        pending.cleanup();
        if (value.type === 'remote-session-result')
            pending.resolve(value.result);
        else
            pending.reject(brokerError(isBrokerErrorCode(value.code) ? value.code : 'request_failed'));
        return true;
    }
    close() {
        this.closed = true;
        for (const [requestId, pending] of this.pending) {
            pending.cleanup();
            pending.reject(brokerError('ssh_unavailable'));
            this.pending.delete(requestId);
        }
    }
    request(operation, signal) {
        if (this.closed)
            return Promise.reject(brokerError('ssh_unavailable'));
        if (signal?.aborted)
            return Promise.reject(brokerError('aborted'));
        const requestId = (this.options.createRequestId ?? randomUUID)();
        const message = { type: 'remote-session-request', requestId, ...operation };
        if (!isSafeBrokerRequestId(requestId) ||
            this.pending.has(requestId) ||
            !isRequestMessage(message))
            return Promise.reject(brokerError('invalid_request'));
        return new Promise((resolve, reject) => {
            const settle = (code) => {
                if (this.pending.get(requestId) !== pending)
                    return;
                this.pending.delete(requestId);
                pending.cleanup();
                try {
                    this.options.postMessage({ type: 'remote-session-abort', requestId });
                }
                catch {
                    // Main may already be gone; the local result still settles.
                }
                reject(brokerError(code));
            };
            const onAbort = () => settle('aborted');
            const timer = setTimeout(() => settle('request_failed'), this.options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS + 5000);
            timer.unref?.();
            const pending = {
                resolve,
                reject,
                cleanup: () => {
                    clearTimeout(timer);
                    signal?.removeEventListener('abort', onAbort);
                },
            };
            this.pending.set(requestId, pending);
            signal?.addEventListener('abort', onAbort, { once: true });
            try {
                this.options.postMessage(message);
            }
            catch {
                this.pending.delete(requestId);
                pending.cleanup();
                reject(brokerError('ssh_unavailable'));
            }
        });
    }
}

function isRequestMessage(value) {
    if (!isRecord(value) || value.type !== 'remote-session-request')
        return false;
    if (value.op === 'ssh-projects' || value.op === 'rc-device-id')
        return true;
    if ((value.op !== 'ssh-read' && value.op !== 'ssh-send') ||
        !isText(value.runtimeId) ||
        !value.runtimeId.startsWith('ssh-project:'))
        return false;
    // Field-level checks run in Main when the request is built.
    if (value.op === 'ssh-send')
        return isRecord(value.send);
    const read = value.read;
    return (isRecord(read) &&
        typeof read.method === 'string' &&
        Object.prototype.hasOwnProperty.call(SSH_READS, read.method));
}
function brokerError(code, reason) {
    return Object.assign(new Error(`Remote session broker: ${code}`), {
        code,
        ...(reason ? { reason } : {}),
    });
}
/** Operation, runtime and method only: workspace paths and session content stay out of logs. */
function describeRequest(message) {
    if (message.op === 'ssh-send') {
        return `ssh-send SendRemoteMessage on ${message.runtimeId} request ${message.requestId}`;
    }
    if (message.op !== 'ssh-read')
        return `${message.op} request ${message.requestId}`;
    return `ssh-read ${message.read.method} on ${message.runtimeId} request ${message.requestId}`;
}
/**
 * One SendRemoteMessage through the project's connected host. A timeout is
 * reported apart from every other failure: the remote Runtime may already have
 * the message, so the caller must not answer as if the send failed.
 */
async function forwardSend(source, runtimeId, request) {
    try {
        return await forward(source, runtimeId, request);
    }
    catch (error) {
        if (isTimeoutError(error))
            throw brokerError('request_timeout');
        throw error;
    }
}
/** What AbortSignal.timeout rejects with once its deadline passes. */
function isTimeoutError(error) {
    return (typeof error === 'object' &&
        error !== null &&
        error.name === 'TimeoutError');
}
/** One request through the project's connected host; the DesktopService response is forwarded as-is. */
async function forward(source, runtimeId, request) {
    const response = await source.readConnected(runtimeId, request);
    if (!response)
        throw brokerError('ssh_not_connected');
    return { status: response.status, body: parseJson(response.text) };
}
/**
 * Builds the SendRemoteMessage request from validated fields only, so the
 * Runtime can neither pick another path nor add fields the contract lacks. Main
 * builds its own body instead of taking one from the Runtime for that reason;
 * the field set itself is the same one `remoteMessageBody` builds for the cloud and
 * Remote Control routes, and `remote-session-broker.test.ts` holds the two equal.
 */
function remoteMessageRequest(send, signal) {
    if (!isRecord(send) || !isSessionId(send.sessionId))
        return undefined;
    if (typeof send.content !== 'string' || !send.content.trim())
        return undefined;
    if (send.content.length > MAX_REMOTE_MESSAGE)
        return undefined;
    const sender = send.sender;
    if (!isRecord(sender) || !isText(sender.sessionId))
        return undefined;
    for (const field of ['deviceName', 'agentName', 'title']) {
        if (sender[field] !== undefined && !isText(sender[field]))
            return undefined;
    }
    if (send.delivery !== undefined && send.delivery !== 'auto' && send.delivery !== 'steer')
        return undefined;
    if (send.idempotencyKey !== undefined && !isText(send.idempotencyKey))
        return undefined;
    const body = {
        content: send.content,
        sender: {
            session_id: sender.sessionId,
            ...(sender.deviceName ? { device_name: sender.deviceName } : {}),
            ...(sender.agentName ? { agent_name: sender.agentName } : {}),
            ...(sender.title ? { title: sender.title } : {}),
        },
        ...(send.delivery ? { delivery: send.delivery } : {}),
        ...(send.idempotencyKey ? { idempotency_key: send.idempotencyKey } : {}),
    };
    return new Request(new URL(`${DESKTOP_API}/session/${encodeURIComponent(send.sessionId)}/remote-message`, SSH_RUNTIME_ORIGIN), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
    });
}
function trimSlash(value) {
    return value.length > 1 ? value.replace(/\/+$/u, '') : value;
}
function brokerErrorCode(error) {
    const code = isRecord(error) ? error.code : undefined;
    return isBrokerErrorCode(code) ? code : 'request_failed';
}
function isBrokerErrorCode(value) {
    return (value === 'invalid_request' ||
        value === 'ssh_unavailable' ||
        value === 'project_not_found' ||
        value === 'ssh_not_connected' ||
        value === 'request_failed' ||
        value === 'request_timeout' ||
        value === 'aborted');
}
function parseJson(text) {
    try {
        return JSON.parse(text);
    }
    catch {
        return null;
    }
}
function post(target, message) {
    try {
        target.postMessage(message);
    }
    catch {
        // The utility process exited while the reply was in transit.
    }
}
function isRecord(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
function isText(value) {
    return typeof value === 'string' && value.length > 0 && value.length <= MAX_TEXT;
}
function isSessionId(value) {
    return isText(value) && value !== '.' && value !== '..';
}
function isPageSize(value) {
    return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 100;
}
