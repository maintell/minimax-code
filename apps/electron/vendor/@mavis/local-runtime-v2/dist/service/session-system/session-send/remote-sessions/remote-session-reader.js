import { randomUUID } from 'node:crypto';
import { logger } from '../../../../infra/logging/logger.js';
import { abortError, toRemoteSendResult, ambiguous, deviceFailureReason, deviceUnavailable, eachDevice, fromCloudReadError, fromCloudSendError, notFound, remoteSessionError, RemoteDeviceUnavailableError, } from './device-source.js';
import { RemoteSessionRouteTable } from './route-table.js';
import { sessionActivityMs, toMavisMessages } from './wire-mapping.js';
const DEFAULT_PAGE = 20;
const MAX_PAGE = 100;
/** The only agent whose sessions a Remote Control device lists (its sidebar). */
const RC_AGENT = 'mavis';
const RC_NO_DEVICES_NOTE = 'This desktop has no Remote Control devices bound.';
/**
 * Live reads of ssh / rc / cloud sessions for the mavis `session` commands.
 * Only the route table is kept in memory; session data and history are read
 * from their owner every time.
 */
export class RemoteSessionReader {
    options;
    routes;
    constructor(options) {
        this.options = options;
        this.routes = options.routes ?? new RemoteSessionRouteTable();
    }
    async listSessions(req, signal) {
        const limit = pageLimit(req.limit);
        if (req.source === 'cloud')
            return this.listCloudSessions(req, limit, signal);
        const src = this.deviceSource(req.source);
        rejectNonMavisRcAgent(src.source, req.agentName);
        const query = {
            source: src,
            limit,
            ...(src.source === 'ssh' && req.agentName ? { agentName: req.agentName } : {}),
            ...(req.cursor ? { cursor: req.cursor } : {}),
            ...(signal ? { signal } : {}),
        };
        if (req.deviceId)
            return this.listOnDevice({ ...query, deviceId: req.deviceId });
        return this.listAcrossDevices(query);
    }
    async listCloudSessions(req, limit, signal) {
        const cloud = this.requireCloud();
        // Without agent_name, list the account's Mavis agent, as the cloud app does.
        const page = await this.cloudCall(async () => cloud.listSessions(req.agentName ?? (await cloud.defaultAgentName(signal)), { limit, ...(req.cursor ? { cursor: req.cursor } : {}) }, signal), signal);
        return {
            sessions: page.sessions.map((session) => ({ ...session, source: 'cloud' })),
            hasMore: page.hasMore,
            ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
        };
    }
    /** One device the caller named; it answers for itself and never seeds a route. */
    async listOnDevice(query) {
        const { source: src, deviceId, limit, agentName, cursor, signal } = query;
        const device = await this.resolveDevice(src, deviceId, signal);
        const page = {
            ...(agentName ? { agentName } : {}),
            limit,
            ...(cursor ? { cursor } : {}),
        };
        const result = await this.onDevice(src, device, () => src.listSessions(device, page, signal));
        return {
            sessions: result.sessions,
            hasMore: result.hasMore,
            ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
            ...(result.note ? { note: result.note } : {}),
        };
    }
    /** Every available device, each with its own page, merged into one list. */
    async listAcrossDevices(query) {
        const { source: src, limit, agentName, signal } = query;
        const page = { ...(agentName ? { agentName } : {}), limit };
        const devices = await this.listDevices(src, signal);
        const { answered, failed } = await eachDevice(devices, (device, deviceSignal) => src.listSessions(device, page, deviceSignal), signal);
        for (const { device, error } of failed) {
            if (error instanceof RemoteDeviceUnavailableError)
                this.routes.deleteDevice(src.source, device.deviceId);
        }
        const sessions = answered
            .flatMap(({ value }) => value.sessions)
            .sort((left, right) => sessionActivityMs(right) - sessionActivityMs(left));
        const note = listNote(src.source, devices.length, answered.map(({ value }) => value));
        return {
            sessions,
            hasMore: answered.some(({ value }) => value.hasMore),
            devices: deviceSummaries(src.source, devices, answered, failed),
            ...(note ? { note } : {}),
        };
    }
    async getSession(req, signal) {
        if (req.source === 'cloud') {
            const result = await this.cloudCall(() => this.requireCloud().getSession(req.sessionId, signal), signal);
            return { session: { ...result.session, source: 'cloud' } };
        }
        const src = this.deviceSource(req.source);
        const { value } = await this.readLocated({
            source: src,
            sessionId: req.sessionId,
            ...(req.deviceId ? { deviceId: req.deviceId } : {}),
            ...(signal ? { signal } : {}),
            read: (device, known) => known ? Promise.resolve(known) : src.getSession(device, req.sessionId, signal),
        });
        return { session: value };
    }
    async listMessages(req, signal) {
        const limit = pageLimit(req.limit);
        if (req.source === 'cloud') {
            const page = await this.cloudCall(() => this.requireCloud().getMessages(req.sessionId, { limit, ...(req.before ? { before: req.before } : {}) }, signal), signal);
            return {
                messages: toMavisMessages(page.messages),
                hasMore: page.hasMore,
                ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
                source: 'cloud',
            };
        }
        const src = this.deviceSource(req.source);
        const { device, value } = await this.readLocated({
            source: src,
            sessionId: req.sessionId,
            ...(req.deviceId ? { deviceId: req.deviceId } : {}),
            ...(signal ? { signal } : {}),
            read: (target) => src.listMessages(target, req.sessionId, { limit, ...(req.before ? { before: req.before } : {}) }, signal),
        });
        return {
            messages: value.messages,
            hasMore: value.hasMore,
            ...(value.nextCursor ? { nextCursor: value.nextCursor } : {}),
            source: src.source,
            deviceId: device.deviceId,
        };
    }
    /**
     * Delivers one message through SendRemoteMessage on the target's runtime.
     * ssh / rc locate the device like a read; one idempotency key covers the
     * whole call, so the retry after a stale route cannot deliver twice.
     */
    async sendMessage(req, signal) {
        const message = {
            sessionId: req.sessionId,
            content: req.content,
            sender: req.sender,
            delivery: req.delivery,
        };
        if (req.source === 'cloud') {
            const cloud = this.requireCloud();
            const result = await this.cloudCall(() => cloud.sendRemoteMessage(message, signal), signal, fromCloudSendError);
            return toRemoteSendResult('cloud', result);
        }
        const src = this.deviceSource(req.source);
        const idempotencyKey = randomUUID();
        const { device, value } = await this.readLocated({
            source: src,
            sessionId: req.sessionId,
            ...(req.deviceId ? { deviceId: req.deviceId } : {}),
            ...(signal ? { signal } : {}),
            read: (target) => src.sendMessage(target, { ...message, idempotencyKey }, signal),
        });
        return { ...toRemoteSendResult(src.source, value), deviceId: device.deviceId };
    }
    /**
     * Finds the device holding `sessionId` and reads from it: an explicit
     * device first, then the route table, then a probe of every device. A stale
     * route is dropped and probed again once. Only a probe that finds the session
     * on exactly one device writes a route, so same-ID sessions stay detectable.
     */
    async readLocated(input) {
        const { source: src, sessionId, deviceId, signal, read } = input;
        if (deviceId) {
            const device = await this.resolveDevice(src, deviceId, signal);
            const value = await this.onDevice(src, device, () => read(device));
            if (value === undefined) {
                throw notFound(src.source, sessionId, { hits: [], searched: [device], unavailable: [] });
            }
            return { device, value };
        }
        const routed = await this.readOnRoute(src, sessionId, signal, read);
        if (routed)
            return routed;
        return this.probeForSession(src, sessionId, signal, read);
    }
    /**
     * The read through the remembered device, or undefined when that route no
     * longer holds the session: the route is dropped and the devices are probed
     * again.
     */
    async readOnRoute(src, sessionId, signal, read) {
        const route = this.routes.get(src.source, sessionId);
        if (!route)
            return undefined;
        const device = {
            deviceId: route.deviceId,
            ...(route.name ? { name: route.name } : {}),
            ...(route.host ? { host: route.host } : {}),
            available: true,
        };
        let staleReason = 'session_not_found';
        try {
            const value = await read(device);
            if (value !== undefined) {
                logger.info({ source: src.source, sessionId, deviceId: route.deviceId }, 'Remote session route hit');
                this.routes.set(src.source, sessionId, device);
                return { device, value };
            }
        }
        catch (error) {
            if (!(error instanceof RemoteDeviceUnavailableError))
                throw error;
            staleReason = error.reason;
            this.routes.deleteDevice(src.source, route.deviceId);
        }
        this.routes.delete(src.source, sessionId);
        logger.info({ source: src.source, sessionId, deviceId: route.deviceId, reason: staleReason }, 'Remote session route stale; probing devices again');
        return undefined;
    }
    /** Asks every available device; only a session found on exactly one writes a route. */
    async probeForSession(src, sessionId, signal, read) {
        const devices = await this.listDevices(src, signal);
        const probe = await src.probe(devices, sessionId, signal);
        logger.info({
            source: src.source,
            sessionId,
            hits: probe.hits.map((hit) => hit.device.deviceId),
            searched: probe.searched.map((device) => device.deviceId),
            unavailable: probe.unavailable.map((device) => ({
                deviceId: device.deviceId,
                reason: device.reason,
            })),
        }, 'Remote session probe finished');
        const [hit, ...others] = probe.hits;
        if (!hit)
            throw notFound(src.source, sessionId, probe);
        if (others.length > 0)
            throw ambiguous(src.source, sessionId, probe.hits);
        this.routes.set(src.source, sessionId, hit.device);
        const value = await this.onDevice(src, hit.device, () => read(hit.device, hit.session));
        if (value === undefined)
            throw notFound(src.source, sessionId, probe);
        return { device: hit.device, value };
    }
    async resolveDevice(src, deviceId, signal) {
        if (!src.isDeviceId(deviceId)) {
            throw remoteSessionError(400, 'INVALID_DEVICE_ID', `device_id is not a ${src.source} device; use one returned by session list with source ${src.source}`, { device_id: deviceId });
        }
        const device = (await this.listDevices(src, signal)).find((item) => item.deviceId === deviceId);
        if (!device) {
            throw remoteSessionError(404, 'REMOTE_DEVICE_NOT_FOUND', `No ${src.source} device ${deviceId}; list sessions again to get current device IDs`, { device_id: deviceId });
        }
        if (!device.available)
            throw deviceUnavailable(src.source, device);
        return device;
    }
    /** Lists devices and drops routes to any device no longer present and available. */
    async listDevices(src, signal) {
        const devices = await src.listDevices(signal);
        this.routes.retainDevices(src.source, new Set(devices.filter((device) => device.available).map((device) => device.deviceId)));
        return devices;
    }
    /** Runs a read on a known device; a device that cannot answer loses its routes. */
    async onDevice(src, device, run) {
        try {
            return await run();
        }
        catch (error) {
            if (!(error instanceof RemoteDeviceUnavailableError))
                throw error;
            logger.warn({ source: src.source, deviceId: device.deviceId, reason: error.reason }, 'Remote session device unavailable');
            this.routes.deleteDevice(src.source, device.deviceId);
            throw deviceUnavailable(src.source, { ...device, available: false, reason: error.reason });
        }
    }
    deviceSource(source) {
        return source === 'ssh' ? this.options.ssh : this.options.rc;
    }
    requireCloud() {
        if (this.options.cloud)
            return this.options.cloud;
        throw remoteSessionError(503, 'CLOUD_READ_UNAVAILABLE', 'Cloud session reading is unavailable on this host');
    }
    async cloudCall(run, signal, mapError = fromCloudReadError) {
        try {
            return await run();
        }
        catch (error) {
            // The cloud reader reports a cancelled request as a 502; the caller cancelled it.
            if (signal?.aborted)
                throw abortError(signal);
            throw mapError(error);
        }
    }
}
/** A Remote Control device lists only the Mavis sidebar sessions, so any other agent is refused up front. */
function rejectNonMavisRcAgent(source, agentName) {
    if (source !== 'rc' || !agentName)
        return;
    if (agentName.trim().toLowerCase() === RC_AGENT)
        return;
    throw remoteSessionError(400, 'RC_AGENT_UNSUPPORTED', 'Remote Control lists only the Mavis sidebar sessions of each controlled device; omit agent_name for source rc', { agent_name: agentName });
}
/** What each device contributed to a multi-device list, and why the others could not. */
function deviceSummaries(source, devices, answered, failed) {
    const reasons = new Map(failed.map(({ device, error }) => [device.deviceId, deviceFailureReason(error)]));
    const pages = new Map(answered.map(({ device, value }) => [device.deviceId, value]));
    const summaries = devices.map((device) => {
        const summary = deviceSummary(device);
        const result = pages.get(device.deviceId);
        if (result) {
            return {
                ...summary,
                status: 'ok',
                hasMore: result.hasMore,
                ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
            };
        }
        const reason = reasons.get(device.deviceId) ?? device.reason;
        return { ...summary, status: 'unavailable', ...(reason ? { reason } : {}) };
    });
    const unavailable = summaries.filter((entry) => entry.status === 'unavailable');
    if (unavailable.length) {
        logger.warn({
            source,
            devices: unavailable.map((entry) => ({ deviceId: entry.deviceId, reason: entry.reason })),
        }, 'Remote session list skipped unavailable devices');
    }
    return summaries;
}
/** What a multi-device list says beyond its rows: no bound device, or devices with partial lists. */
function listNote(source, deviceCount, pages) {
    if (source === 'rc' && deviceCount === 0)
        return RC_NO_DEVICES_NOTE;
    const notes = pages.flatMap((page) => (page.note ? [page.note] : []));
    return notes.length > 0 ? notes.join(' ') : undefined;
}
function pageLimit(limit) {
    const value = limit ?? DEFAULT_PAGE;
    if (Number.isInteger(value) && value >= 1 && value <= MAX_PAGE)
        return value;
    throw remoteSessionError(400, 'INVALID_PAGE_SIZE', `limit must be between 1 and ${MAX_PAGE} for ssh, rc and cloud reads`);
}
function deviceSummary(device) {
    return {
        deviceId: device.deviceId,
        ...(device.name ? { name: device.name } : {}),
        ...(device.host ? { host: device.host } : {}),
        status: device.available ? 'ok' : 'unavailable',
        ...(device.reason ? { reason: device.reason } : {}),
    };
}
//# sourceMappingURL=remote-session-reader.js.map