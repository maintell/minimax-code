import { CloudSessionReadError } from '@mavis/agent-tools/desktop';
/** The device itself could not answer: disconnected, offline, or its binding is gone. */
export class RemoteDeviceUnavailableError extends Error {
    reason;
    constructor(reason, message) {
        super(message);
        this.reason = reason;
        this.name = 'RemoteDeviceUnavailableError';
    }
}
/**
 * A model-facing failure. `modelDetails` reaches the mavis tool output under
 * `error.details`; no other field of the error is copied there.
 */
export function remoteSessionError(status, code, message, modelDetails) {
    return Object.assign(new Error(message), {
        status,
        code,
        ...(modelDetails ? { modelDetails } : {}),
    });
}
/** Login and endpoint failures stop the whole read instead of marking one device. */
const HOST_LEVEL_CODES = new Set([
    'CLOUD_LOGIN_REQUIRED',
    'CLOUD_LOGIN_CHANGED',
    'UNSUPPORTED_CLOUD_ENDPOINT',
    'SSH_SESSIONS_UNAVAILABLE',
    'RC_SESSIONS_UNAVAILABLE',
]);
export function isHostLevelError(error) {
    if (!error || typeof error !== 'object')
        return false;
    const { code, status } = error;
    // A rejected login fails every device the same way; report it once.
    return status === 401 || (typeof code === 'string' && HOST_LEVEL_CODES.has(code));
}
/** Receiver codes a remote send keeps as its own code: the same names a local session send uses. */
export const REMOTE_SEND_ERROR_CODES = new Set([
    'SESSION_NOT_FOUND',
    'SESSION_ARCHIVED',
    'SESSION_BUSY',
    'SESSION_SEND_REJECTED',
    'REMOTE_MESSAGE_INVALID',
]);
/** What the model does with an unconfirmed send: check the target, never resend blind. */
const UNCONFIRMED_GUIDANCE = 'The message may already have reached the target session. Read that session with session messages before sending again: a resend would deliver a second copy and run the work twice.';
/**
 * A send whose outcome is unknown: a request timeout, a connection that broke
 * after the request went out, or a Remote Control command that timed out. The
 * message can already be running there, so this is neither a failed send nor an
 * unavailable device, and no route is dropped: the device answered before, only
 * this answer is missing.
 */
export function remoteSendUnconfirmed(reason, details) {
    return remoteSessionError(504, 'REMOTE_SEND_UNCONFIRMED', `The message send was not confirmed (${reason}). ${UNCONFIRMED_GUIDANCE}`, details);
}
/**
 * A failed Remote Control or cloud send. Receiver codes are kept; a 404 (HTTP
 * or `base_resp`) is a missing or foreign session and a 400 a rejected
 * argument; anything else, such as the cloud's `SEND_MESSAGE_FAILED`, is a send
 * failure that keeps the upstream code. A send route that is not there at all
 * is told apart first (`isRemoteSendRouteMissing`).
 */
export function fromRemoteSendError(error) {
    if (!(error instanceof CloudSessionReadError))
        return error;
    // The request left this host and no answer came back, so the target may have it.
    if (error.key === 'CLOUD_READ_UNAVAILABLE') {
        return remoteSendUnconfirmed('the request timed out or the connection broke');
    }
    if (error.key !== 'CLOUD_READ_FAILED')
        return fromCloudReadError(error);
    const upstream = error.upstreamCode;
    const details = upstream ? { upstream_code: upstream } : undefined;
    const message = error.message.replace('conversation read', 'message send');
    if (upstream !== undefined && REMOTE_SEND_ERROR_CODES.has(upstream)) {
        return receiverSendError(error, upstream, message, details);
    }
    return semanticSendError(error, message, details);
}
/** The receiver named the failure with a local send's own code, so it keeps it. */
function receiverSendError(error, upstream, message, details) {
    const status = upstream === 'SESSION_NOT_FOUND' ? 404 : (error.baseStatusCode ?? error.status);
    return remoteSessionError(status, upstream, message, details);
}
/** No receiver code to keep: the answer's own status decides what the send failed with. */
function semanticSendError(error, message, details) {
    const semantic = error.baseStatusCode ?? error.status;
    if (semantic === 404)
        return remoteSessionError(404, 'SESSION_NOT_FOUND', message, details);
    if (semantic === 400)
        return remoteSessionError(400, 'REMOTE_MESSAGE_INVALID', message, details);
    return remoteSessionError(502, 'REMOTE_SEND_FAILED', message, details);
}
/**
 * Remote Control gateway policy codes for a route it does not forward (archon_biz
 * errorcode catalog: `GENERIC_FORWARD_DISABLED` 40066, `ROUTE_NOT_ALLOWED` 40067);
 * the Remote Control UI reads `ROUTE_NOT_ALLOWED` as unsupported too.
 */
const ROUTE_NOT_FORWARDED_CODES = new Set(['GENERIC_FORWARD_DISABLED', 'ROUTE_NOT_ALLOWED']);
/**
 * A send answered like a service without the SendRemoteMessage route: an HTTP
 * 404 without an error code (a receiver reports a missing session as
 * `SESSION_NOT_FOUND`; the cloud as a `base_resp` code on HTTP 200), or a
 * Remote Control gateway that does not forward the route.
 */
export function isRemoteSendRouteMissing(error) {
    if (!(error instanceof CloudSessionReadError) || error.key !== 'CLOUD_READ_FAILED')
        return false;
    const code = error.upstreamCode;
    return code === undefined ? error.status === 404 : ROUTE_NOT_FORWARDED_CODES.has(code);
}
/**
 * The target side cannot take cross-device messages yet. Never a missing
 * session: the route stays and no other device is asked.
 */
export function remoteSendUnsupported(message, details) {
    return remoteSessionError(501, 'REMOTE_SEND_UNSUPPORTED', message, details);
}
/**
 * `base_resp.status_code` of archon_biz CloudSendRemoteMessage for a target
 * session that is missing or not the user's (HTTP 200, no string code):
 * STATUS_MATRIX_ARCHON_SESSION_NOT_FOUND, product/status_code `matrix_archon.go:21`.
 */
const CLOUD_SESSION_NOT_FOUND_STATUS = 1406010051;
/** A cloud send failure; a cloud without the send route is unsupported, not a missing session. */
export function fromCloudSendError(error) {
    if (error instanceof CloudSessionReadError &&
        error.baseStatusCode === CLOUD_SESSION_NOT_FOUND_STATUS) {
        return remoteSessionError(404, 'SESSION_NOT_FOUND', 'Cloud session not found', {
            upstream_status: error.baseStatusCode,
        });
    }
    if (!isRemoteSendRouteMissing(error))
        return fromRemoteSendError(error);
    return remoteSendUnsupported('The cloud service cannot deliver messages to cloud sessions yet; it needs an update', {
        upstream_status: error.status,
        ...(error.upstreamCode ? { upstream_code: error.upstreamCode } : {}),
    });
}
export function isAbortError(error) {
    return error instanceof Error && error.name === 'AbortError';
}
/** The caller's abort reason when it is an abort, otherwise a fresh AbortError. */
export function abortError(signal) {
    const reason = signal?.reason;
    return isAbortError(reason)
        ? reason
        : new DOMException('The remote session read was aborted', 'AbortError');
}
/** A wire value that is an object, never an array; undefined for anything else. */
export function asRecord(value) {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value
        : undefined;
}
/** The stable `code` a host port or gateway failure carries, when it has one. */
export function portCode(error) {
    const code = error && typeof error === 'object' && 'code' in error
        ? error.code
        : undefined;
    return typeof code === 'string' && code ? code : undefined;
}
/** The reason recorded when one device fails without being unavailable. */
export function deviceFailureReason(error) {
    if (error instanceof RemoteDeviceUnavailableError)
        return error.reason;
    return portCode(error)?.toLowerCase() ?? 'read_failed';
}
/** Cloud API failures keep their stable key as the tool error code. */
export function fromCloudReadError(error) {
    if (!(error instanceof CloudSessionReadError))
        return error;
    return remoteSessionError(error.status, error.key, error.message, error.upstreamCode ? { upstream_code: error.upstreamCode } : undefined);
}
/**
 * Runs one read per available device. A device that fails is recorded with
 * its reason; a login failure or an abort stops the other in-flight reads and
 * fails the whole call once.
 */
export async function eachDevice(devices, read, signal) {
    const stop = new AbortController();
    const scoped = signal ? AbortSignal.any([signal, stop.signal]) : stop.signal;
    const answered = [];
    const failed = [];
    await Promise.all(devices
        .filter((device) => device.available)
        .map(async (device) => {
        try {
            answered.push({ device, value: await read(device, scoped) });
        }
        catch (error) {
            if (signal?.aborted)
                throw abortError(signal);
            if (isHostLevelError(error) || isAbortError(error) || stop.signal.aborted) {
                stop.abort();
                throw error;
            }
            failed.push({ device, error });
        }
    }));
    return { answered, failed };
}
/** Probes every available device, collecting hits, answered devices and devices that could not answer. */
export async function probeDevices(devices, ask, signal) {
    const { answered, failed } = await eachDevice(devices, ask, signal);
    return {
        hits: answered.flatMap((entry) => entry.value),
        searched: answered.map((entry) => entry.device),
        unavailable: [
            ...devices.filter((device) => !device.available),
            ...failed.map(({ device, error }) => ({
                ...device,
                available: false,
                reason: deviceFailureReason(error),
            })),
        ],
    };
}
const REMOTE_MESSAGE_MODES = new Set([
    'started',
    'queued',
    'activated',
    'steered',
    'duplicate',
]);
export function toRemoteSendResult(source, result) {
    if (!result.mode || !REMOTE_MESSAGE_MODES.has(result.mode)) {
        throw remoteSessionError(502, 'INVALID_REMOTE_RESPONSE', 'The remote runtime answered the message send without a delivery mode', { source });
    }
    return {
        source,
        mode: result.mode,
        ...(result.turnId ? { turnId: result.turnId } : {}),
        ...(result.queueItemId ? { queueItemId: result.queueItemId } : {}),
    };
}
// ─── Locate errors ──────────────────────────────────────────────────────
function deviceLabel(device) {
    return {
        device_id: device.deviceId,
        ...(device.name ? { name: device.name } : {}),
        ...(device.host ? { host: device.host } : {}),
        ...(device.reason ? { reason: device.reason } : {}),
    };
}
export function deviceUnavailable(source, device) {
    const label = source === 'ssh' ? 'SSH project' : 'Remote Control device';
    return remoteSessionError(503, 'REMOTE_DEVICE_UNAVAILABLE', `${label} ${device.name ?? device.deviceId} is unavailable (${device.reason ?? 'unavailable'})`, deviceLabel(device));
}
export function notFound(source, sessionId, probe) {
    const searched = probe.searched.map(deviceLabel);
    const unavailable = probe.unavailable.map(deviceLabel);
    const label = source === 'ssh' ? 'connected SSH project' : 'reachable Remote Control device';
    const suffix = unavailable.length
        ? `; ${unavailable.length} device(s) could not be checked: see unavailable_devices`
        : '';
    return remoteSessionError(404, 'SESSION_NOT_FOUND', searched.length
        ? `Session ${sessionId} was not found on any ${label}${suffix}`
        : `No ${label} could be checked for session ${sessionId}${suffix}`, { source, session_id: sessionId, searched_devices: searched, unavailable_devices: unavailable });
}
export function ambiguous(source, sessionId, hits) {
    return remoteSessionError(409, 'SESSION_ID_AMBIGUOUS', `Session ID ${sessionId} exists on ${hits.length} ${source} devices; pass one device_id from candidates`, {
        source,
        session_id: sessionId,
        candidates: hits.map(({ device, session }) => ({
            ...deviceLabel(device),
            ...(session.title ? { title: session.title } : {}),
            ...(session.workspaceDir ? { workspace_dir: session.workspaceDir } : {}),
        })),
    });
}
//# sourceMappingURL=device-source.js.map