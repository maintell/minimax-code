import { readRemoteMessageResult } from '@mavis/agent-tools/desktop';
import { logger } from '../../../../infra/logging/logger.js';
import { abortError, asRecord, portCode, probeDevices, REMOTE_SEND_ERROR_CODES, remoteSendUnconfirmed, remoteSendUnsupported, remoteSessionError, RemoteDeviceUnavailableError, } from './device-source.js';
import { toMavisMessages, toMavisSession } from './wire-mapping.js';
/** Host port failures that describe the project, not this read. */
const UNAVAILABLE_PORT_CODES = new Set(['ssh_not_connected', 'project_not_found']);
/** Broker codes for a send that left this host and never came back. */
const SEND_UNCONFIRMED_PORT_CODES = new Set(['request_timeout', 'request_failed']);
/**
 * SSH project sessions, read through the desktop host. One SSH host runs one
 * remote Runtime, so a session is probed once per host and attributed to the
 * project whose workspace holds it.
 */
export function createSshDeviceSource(host) {
    const requireHost = () => {
        if (host)
            return host;
        throw remoteSessionError(503, 'SSH_SESSIONS_UNAVAILABLE', 'SSH sessions can only be read from the MiniMax Code desktop app');
    };
    /** One DesktopService call through the desktop host, with host failures mapped. */
    const viaHost = async (device, method, run, signal) => {
        let result;
        try {
            result = await run(requireHost());
        }
        catch (error) {
            throw hostRequestFailure(device, method, error, signal);
        }
        return { status: result.status, body: asRecord(result.body) ?? {} };
    };
    const read = (device, request, signal) => viaHost(device, request.method, (desktop) => desktop.readSsh(device.deviceId, request, signal), signal);
    const decorate = (device, session) => ({
        ...session,
        source: 'ssh',
        deviceId: device.deviceId,
        ...(device.name ? { projectName: device.name } : {}),
        ...(device.host ? { host: device.host } : {}),
    });
    /** The sessions of one ListProjectSessions page; a node may wrap its session. */
    const pageSessions = (device, body) => {
        const nodes = Array.isArray(body.sessions) ? body.sessions : [];
        return nodes.flatMap((node) => {
            const session = toMavisSession(asRecord(node)?.session ?? node);
            return session ? [decorate(device, session)] : [];
        });
    };
    const getSession = async (device, sessionId, signal) => {
        const response = await read(device, { method: 'GetSession', sessionId }, signal);
        if (response.status === 404)
            return undefined;
        ensureOk(device, response);
        const session = toMavisSession(response.body.session);
        return session ? decorate(device, session) : undefined;
    };
    return {
        source: 'ssh',
        isDeviceId: (deviceId) => /^ssh-project:\S+$/u.test(deviceId),
        async listDevices(signal) {
            let projects;
            try {
                projects = await requireHost().listSshProjects(signal);
            }
            catch (error) {
                if (portCode(error) === 'aborted' || signal?.aborted)
                    throw abortError(signal);
                throw error;
            }
            return projects.map((project) => ({
                deviceId: project.runtimeId,
                name: project.name,
                host: project.host,
                workspaceDir: project.workspaceDir,
                available: project.connected,
                ...(project.connected ? {} : { reason: project.state ?? 'disconnected' }),
            }));
        },
        async listSessions(device, page, signal) {
            const response = await read(device, projectSessionsRequest(device, page), signal);
            // A registered workspace has no remote Project until its first task.
            if (response.status === 404 && response.body.key === 'PROJECT_NOT_FOUND') {
                return { sessions: [], hasMore: false };
            }
            ensureOk(device, response);
            const nextCursor = text(response.body.next_cursor ?? response.body.nextCursor);
            const hasMore = (response.body.has_more ?? response.body.hasMore) === true && Boolean(nextCursor);
            return {
                sessions: pageSessions(device, response.body),
                hasMore,
                ...(nextCursor ? { nextCursor } : {}),
            };
        },
        getSession,
        async sendMessage(device, send, signal) {
            const response = await viaHost(device, 'SendRemoteMessage', (desktop) => desktop.sendSsh(device.deviceId, send, signal), signal);
            return readRemoteSendResponse(device, response);
        },
        async listMessages(device, sessionId, page, signal) {
            const response = await read(device, {
                method: 'GetMessages',
                sessionId,
                limit: page.limit,
                ...(page.before ? { before: page.before } : {}),
            }, signal);
            if (response.status === 404)
                return undefined;
            ensureOk(device, response);
            const raw = Array.isArray(response.body.messages) ? response.body.messages : [];
            const nextCursor = text(response.body.next_cursor ?? response.body.nextCursor);
            const hasMore = response.body.has_more ?? response.body.hasMore;
            return {
                messages: toMavisMessages(raw),
                hasMore: typeof hasMore === 'boolean' ? hasMore : Boolean(nextCursor),
                ...(nextCursor ? { nextCursor } : {}),
            };
        },
        async probe(devices, sessionId, signal) {
            // One SSH host runs one remote Runtime: ask it once, through its first project.
            const firstByHost = new Map();
            for (const device of devices) {
                if (!device.available)
                    continue;
                const key = hostKey(device);
                if (!firstByHost.has(key))
                    firstByHost.set(key, device);
            }
            const askedIds = new Set([...firstByHost.values()].map((device) => device.deviceId));
            const probeTargets = devices.filter((device) => !device.available || askedIds.has(device.deviceId));
            const result = await probeDevices(probeTargets, async (probed, probeSignal) => {
                const session = await getSession(probed, sessionId, probeSignal);
                if (!session)
                    return [];
                const owner = ownerProject(devices, probed, session.workspaceDir) ?? probed;
                return [{ device: owner, session: decorate(owner, session) }];
            }, signal);
            // An answering host covers all its projects; when it could not be asked,
            // neither were the other projects on it.
            const answeredHosts = new Set(result.searched.map(hostKey));
            const failedHosts = new Set(result.unavailable.filter((device) => askedIds.has(device.deviceId)).map(hostKey));
            const siblings = devices.filter((device) => device.available && !askedIds.has(device.deviceId));
            return {
                hits: result.hits,
                searched: [
                    ...result.searched,
                    ...siblings.filter((device) => answeredHosts.has(hostKey(device))),
                ],
                unavailable: [
                    ...result.unavailable,
                    ...siblings
                        .filter((device) => failedHosts.has(hostKey(device)))
                        .map((device) => ({ ...device, available: false, reason: 'not_checked' })),
                ],
            };
        },
    };
}
function hostKey(device) {
    return device.host ?? device.deviceId;
}
/** ListProjectSessions for one project, under the workspace it was registered with. */
function projectSessionsRequest(device, page) {
    return {
        method: 'ListProjectSessions',
        workspaceDir: device.workspaceDir ?? '',
        ...(page.agentName ? { agentName: page.agentName } : {}),
        limit: page.limit,
        ...(page.cursor ? { cursor: page.cursor } : {}),
    };
}
/**
 * What a call that never reached the remote Runtime means: a cancelled read, an
 * SSH feature the desktop app does not have, a project that is gone, or a
 * failed read or send.
 */
function hostRequestFailure(device, method, error, signal) {
    const code = portCode(error);
    // A cancelled read says nothing about the project; never mark it unavailable.
    if (code === 'aborted' || signal?.aborted)
        return abortError(signal);
    logger.warn({ source: 'ssh', deviceId: device.deviceId, method, portCode: code }, 'SSH session request failed in the desktop host');
    if (code === 'ssh_unavailable') {
        return remoteSessionError(503, 'SSH_SESSIONS_UNAVAILABLE', 'SSH sessions are unavailable in this desktop app');
    }
    if (code && UNAVAILABLE_PORT_CODES.has(code))
        return projectGone(device, code);
    // A send that reached the connected host without an answer may already be
    // running there; a project that is gone was handled above.
    const unconfirmed = method === 'SendRemoteMessage' ? sshSendUnconfirmed(device, code) : undefined;
    if (unconfirmed)
        return unconfirmed;
    return hostCallFailed(method, upstreamDetails(device.deviceId, { code }));
}
/**
 * A send that left this host and never came back: the remote Runtime may already
 * have the message, so it is reported as unconfirmed rather than as a failed send.
 * Undefined for every other port code.
 */
function sshSendUnconfirmed(device, code) {
    if (!code || !SEND_UNCONFIRMED_PORT_CODES.has(code))
        return undefined;
    const what = code === 'request_timeout' ? 'timed out' : 'failed';
    return remoteSendUnconfirmed(`the request ${what} on SSH project ${device.name ?? device.deviceId}`, upstreamDetails(device.deviceId, { code }));
}
/** A project that is no longer connected, so every read of it fails the same way. */
function projectGone(device, code) {
    return new RemoteDeviceUnavailableError(code === 'ssh_not_connected' ? 'disconnected' : 'project_removed', `SSH project ${device.name ?? device.deviceId} is not connected`);
}
function hostCallFailed(method, details) {
    const sending = method === 'SendRemoteMessage';
    return remoteSessionError(502, sending ? 'REMOTE_SEND_FAILED' : 'REMOTE_READ_FAILED', sending ? 'SSH session send failed' : 'SSH session read failed', details);
}
/** The upstream fields an SSH failure reports: always the device, then the wire's own. */
function upstreamDetails(deviceId, fields) {
    return {
        device_id: deviceId,
        ...(fields.status === undefined ? {} : { upstream_status: fields.status }),
        ...(fields.code ? { upstream_code: fields.code } : {}),
    };
}
/** The connected project on the same host whose workspace holds the session. */
function ownerProject(devices, probed, workspaceDir) {
    if (!workspaceDir)
        return undefined;
    const target = trimSlash(workspaceDir);
    return devices.find((device) => device.available &&
        hostKey(device) === hostKey(probed) &&
        device.workspaceDir !== undefined &&
        trimSlash(device.workspaceDir) === target);
}
function ensureOk(device, response) {
    if (response.status >= 200 && response.status < 300)
        return;
    const key = text(response.body.key);
    throw remoteSessionError(502, 'REMOTE_READ_FAILED', `SSH session read failed (HTTP ${response.status})`, upstreamDetails(device.deviceId, { status: response.status, ...(key ? { code: key } : {}) }));
}
/**
 * A SendRemoteMessage answer from the remote DesktopService. A missing session
 * lets the reader probe elsewhere; a runtime without the route is reported as
 * too old instead of as a missing session.
 */
function readRemoteSendResponse(device, response) {
    if (response.status >= 200 && response.status < 300)
        return readRemoteMessageResult(response.body);
    const key = text(response.body.key);
    if (response.status === 404 && key === 'SESSION_NOT_FOUND')
        return undefined;
    if (response.status === 404 || response.status === 501) {
        throw sendRouteUnsupported(device, response.status, key);
    }
    throw sendRejected(device, response, key);
}
/** A send the remote Runtime rejected; a receiver's own code is kept, anything else becomes 502. */
function sendRejected(device, response, key) {
    const passThrough = key && REMOTE_SEND_ERROR_CODES.has(key) ? key : undefined;
    return remoteSessionError(passThrough ? response.status : 502, passThrough ?? 'REMOTE_SEND_FAILED', text(response.body.message) ?? `SSH session send failed (HTTP ${response.status})`, upstreamDetails(device.deviceId, { status: response.status, ...(key ? { code: key } : {}) }));
}
/** A runtime without the SendRemoteMessage route: too old, never a missing session. */
function sendRouteUnsupported(device, status, key) {
    return remoteSendUnsupported(`The runtime on SSH project ${device.name ?? device.deviceId} cannot receive messages yet; update minimax Code there`, upstreamDetails(device.deviceId, { status, ...(key ? { code: key } : {}) }));
}
function trimSlash(value) {
    return value.length > 1 ? value.replace(/\/+$/u, '') : value;
}
function text(value) {
    return typeof value === 'string' && value ? value : undefined;
}
//# sourceMappingURL=ssh-device-source.js.map