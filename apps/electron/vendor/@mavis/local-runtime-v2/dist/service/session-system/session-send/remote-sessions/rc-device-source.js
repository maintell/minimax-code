import { CloudSessionReadError } from '@mavis/agent-tools/desktop';
import { logger } from '../../../../infra/logging/logger.js';
import { abortError, asRecord, fromCloudReadError, fromRemoteSendError, isAbortError, isRemoteSendRouteMissing, portCode, probeDevices, remoteSendUnconfirmed, remoteSendUnsupported, remoteSessionError, RemoteDeviceUnavailableError, } from './device-source.js';
import { decodeProjectWalk, listProjectWalk, PROJECT_CURSOR_PREFIX, ProjectListUnsupported, } from './rc-project-walk.js';
import { sessionActivityMs, toMavisMessages, toMavisSession } from './wire-mapping.js';
const DEVICE_PREFIX = 'rc-binding:';
/** Gateway codes meaning the controlled device cannot answer right now, or the binding is gone. */
const UNAVAILABLE_CODES = new Set([
    'DEVICE_OFFLINE',
    'BINDING_NOT_FOUND',
    'NO_ACTIVE_BINDING',
    'COMMAND_TIMEOUT',
    'LOCAL_RUNTIME_UNAVAILABLE',
    'DAEMON_UNAVAILABLE',
    'RC_STREAM_INTERRUPTED',
]);
const NOT_FOUND_CODES = new Set(['SESSION_NOT_FOUND', 'NOT_FOUND']);
/** A send answered with this: the device took the command and never reported back. */
const SEND_UNCONFIRMED_CODE = 'COMMAND_TIMEOUT';
/**
 * Sessions on devices this desktop controls through Remote Control. Requests go
 * straight to the RC gateway with the managed login; the desktop host only
 * supplies this desktop's RC device id.
 */
export function createRcDeviceSource(input) {
    const consumerDeviceId = async (signal) => {
        if (!input.host) {
            throw remoteSessionError(503, 'RC_SESSIONS_UNAVAILABLE', 'Remote Control sessions can only be read from the MiniMax Code desktop app');
        }
        let deviceId;
        try {
            deviceId = await input.host.getRemoteControlDeviceId(signal);
        }
        catch (error) {
            const code = portCode(error);
            if (code === 'aborted' || signal?.aborted)
                throw abortError(signal);
            // Broker transport codes describe the desktop host, not Remote Control.
            logger.warn({ source: 'rc', portCode: code }, 'Remote Control device id request failed');
        }
        if (deviceId)
            return deviceId;
        throw remoteSessionError(503, 'RC_SESSIONS_UNAVAILABLE', "This desktop's Remote Control identity is unavailable; try again after Remote Control is ready");
    };
    /** Runs one binding request; `undefined` means the device has no such session. */
    const call = async (device, read, signal, mapError = fromCloudReadError) => {
        const consumer = await consumerDeviceId(signal);
        try {
            return await read(consumer, bindingIdOf(device.deviceId));
        }
        catch (error) {
            return onBindingFailure(device, error, signal, mapError);
        }
    };
    const decorate = (device, session) => {
        const projectName = session.workspaceDir && session.isDefaultWorkspace !== true
            ? folderName(session.workspaceDir)
            : undefined;
        return {
            ...session,
            source: 'rc',
            deviceId: device.deviceId,
            ...(device.name ? { deviceName: device.name } : {}),
            ...(projectName ? { projectName } : {}),
        };
    };
    const getSession = async (device, sessionId, signal) => {
        const body = await call(device, (consumer, bindingId) => input.reader.getSession(consumer, bindingId, sessionId, signal), signal);
        const session = toMavisSession(body?.session);
        return session ? decorate(device, session) : undefined;
    };
    const walkDeps = {
        call,
        reader: input.reader,
        // Project lists carry DesktopService session tree nodes and status values.
        toSessions: (device, nodes) => nodes.flatMap((node) => {
            const session = toMavisSession(asRecord(node)?.session ?? node);
            return session ? [decorate(device, session)] : [];
        }),
    };
    /** Older devices answer with their whole sidebar list (the device's first page). */
    const readLegacySidebar = async (device, signal) => {
        const raw = (await call(device, (consumer, bindingId) => input.reader.listSessions(consumer, bindingId, signal), signal)) ?? [];
        return raw.flatMap((item) => {
            const session = toMavisSession(item, { statusScale: 'rc' });
            return session ? [decorate(device, session)] : [];
        });
    };
    return {
        source: 'rc',
        isDeviceId: (deviceId) => /^rc-binding:[1-9]\d*$/u.test(deviceId),
        async listDevices(signal) {
            const consumer = await consumerDeviceId(signal);
            let devices;
            try {
                devices = await input.reader.listDevices(consumer, signal);
            }
            catch (error) {
                if (signal?.aborted)
                    throw abortError(signal);
                const status = error instanceof CloudSessionReadError ? error.status : undefined;
                logger.warn({ source: 'rc', status }, 'Remote Control device list failed');
                throw fromCloudReadError(error);
            }
            return devices.map((device) => ({
                deviceId: `${DEVICE_PREFIX}${device.bindingId}`,
                ...(device.name ? { name: device.name } : {}),
                // Unknown presence is still worth asking; only a known-offline device is skipped.
                available: device.online !== false,
                ...(device.online === false ? { reason: 'offline' } : {}),
            }));
        },
        async listSessions(device, page, signal) {
            if (page.cursor && !page.cursor.startsWith(PROJECT_CURSOR_PREFIX)) {
                return pageLegacySidebar(device, await readLegacySidebar(device, signal), page);
            }
            const walk = page.cursor ? decodeProjectWalk(page.cursor) : {};
            try {
                return await listProjectWalk(walkDeps, { device, limit: page.limit, start: walk, signal });
            }
            catch (error) {
                if (page.cursor || !(error instanceof ProjectListUnsupported))
                    throw error;
                logger.warn({ source: 'rc', deviceId: device.deviceId, reason: error.reason }, 'Remote Control device has no project list; reading its sidebar list instead');
                return pageLegacySidebar(device, await readLegacySidebar(device, signal), page);
            }
        },
        getSession,
        sendMessage(device, send, signal) {
            return call(device, async (consumer, bindingId) => {
                try {
                    return await input.reader.sendRemoteMessage(consumer, bindingId, send, signal);
                }
                catch (error) {
                    // Thrown past `call`, which reads a bare 404 as a missing session.
                    if (isRemoteSendRouteMissing(error))
                        throw rcSendUnsupported(device, error);
                    const unconfirmed = rcSendUnconfirmed(device, error);
                    if (unconfirmed)
                        throw unconfirmed;
                    throw error;
                }
            }, signal, fromRemoteSendError);
        },
        async listMessages(device, sessionId, page, signal) {
            const result = await call(device, (consumer, bindingId) => input.reader.getMessages(consumer, bindingId, sessionId, { limit: page.limit, ...(page.before ? { before: page.before } : {}) }, signal), signal);
            if (!result)
                return undefined;
            return {
                messages: toMavisMessages(result.messages),
                hasMore: result.hasMore,
                ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
            };
        },
        probe(devices, sessionId, signal) {
            return probeDevices(devices, async (device, probeSignal) => {
                const session = await getSession(device, sessionId, probeSignal);
                return session ? [{ device, session }] : [];
            }, signal);
        },
    };
}
/**
 * What a failed binding request means: `undefined` for a session the device
 * does not have, a device that cannot answer, or the caller's own mapping for
 * everything else.
 */
function onBindingFailure(device, error, signal, mapError) {
    // A cancelled read says nothing about the device; never mark it unavailable.
    if (signal?.aborted || isAbortError(error))
        throw abortError(signal);
    if (!(error instanceof CloudSessionReadError))
        throw error;
    const code = error.upstreamCode;
    if (isMissingSession(error))
        return undefined;
    logger.warn({
        source: 'rc',
        deviceId: device.deviceId,
        status: error.status,
        key: error.key,
        upstreamCode: code,
    }, 'Remote Control device read failed');
    if (code && UNAVAILABLE_CODES.has(code)) {
        throw new RemoteDeviceUnavailableError(code.toLowerCase(), `Remote Control device ${device.name ?? device.deviceId} cannot answer (${code})`);
    }
    throw mapError(error);
}
/** The device answered that it has no such session, by code or by a bare 404. */
function isMissingSession(error) {
    const code = error.upstreamCode;
    if (code)
        return NOT_FOUND_CODES.has(code);
    return error.status === 404;
}
/**
 * A send the device took and never reported back. It may already be running
 * there, so it is neither a failed send nor an unavailable device, and the
 * route stays. Undefined for every other failure.
 */
function rcSendUnconfirmed(device, error) {
    const code = error instanceof CloudSessionReadError ? error.upstreamCode : undefined;
    if (code !== SEND_UNCONFIRMED_CODE)
        return undefined;
    logger.warn({ source: 'rc', deviceId: device.deviceId, upstreamCode: code }, 'Remote Control send was not confirmed; the device may already be running it');
    return remoteSendUnconfirmed(`the Remote Control command timed out on device ${device.name ?? device.deviceId}`, { device_id: device.deviceId, upstream_code: code });
}
/**
 * The archon_biz in front of the device has no RCSendRemoteMessage route, or
 * the Remote Control gateway does not forward it.
 */
function rcSendUnsupported(device, error) {
    logger.warn({
        source: 'rc',
        deviceId: device.deviceId,
        status: error.status,
        upstreamCode: error.upstreamCode,
    }, 'Remote Control send route unavailable; reporting REMOTE_SEND_UNSUPPORTED');
    return remoteSendUnsupported(`Remote Control cannot deliver messages to device ${device.name ?? device.deviceId} yet; MiniMax Code there or the Remote Control service needs an update`, {
        device_id: device.deviceId,
        upstream_status: error.status,
        ...(error.upstreamCode ? { upstream_code: error.upstreamCode } : {}),
    });
}
/**
 * Pages an older device's sidebar list here, by the last session ID. That list
 * is only the device's latest batch (its session tree default, 50), so every
 * page says the list may be incomplete.
 */
function pageLegacySidebar(device, listed, page) {
    const sessions = listed.sort((left, right) => sessionActivityMs(right) - sessionActivityMs(left));
    const start = page.cursor
        ? sessions.findIndex((session) => session.sessionId === page.cursor) + 1
        : 0;
    if (page.cursor && start === 0) {
        throw remoteSessionError(400, 'INVALID_CURSOR', 'cursor is not a session in this device list');
    }
    const items = sessions.slice(start, start + page.limit);
    const hasMore = start + page.limit < sessions.length;
    const last = items.at(-1)?.sessionId;
    return {
        sessions: items,
        hasMore,
        ...(hasMore && last ? { nextCursor: last } : {}),
        note: `Remote Control device ${device.name ?? device.deviceId} runs an older MiniMax Code that lists only its latest sidebar sessions (about 50), so this list may be incomplete.`,
    };
}
function bindingIdOf(deviceId) {
    return Number(deviceId.slice(DEVICE_PREFIX.length));
}
function folderName(workspaceDir) {
    const parts = workspaceDir.split(/[\\/]+/u).filter(Boolean);
    return parts.at(-1);
}
//# sourceMappingURL=rc-device-source.js.map