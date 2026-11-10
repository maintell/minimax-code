import { CloudSessionReadError, readManagedCloudJson, readRemoteMessageResult, remoteMessageBody, } from './cloud-session-reader.js';
const RC_BASE = '/minimax-cloud/api/v1/remote-control';
/** Multi-device binding protocol the desktop controller speaks (same as the desktop UI). */
const RC_PROTOCOL_VERSION = '3';
/**
 * Opts into archon_biz's catalogued errors, as the Remote Control UI does: an
 * offline device answers `409 DEVICE_OFFLINE` instead of `202 {state: 'connecting'}`.
 */
const RC_ERROR_CONTRACT_HEADER = { 'X-RC-Error-Contract': 'v2' };
/**
 * Read-only Remote Control access for this desktop acting as the controller.
 * Uses the host's managed login; every data request names the target binding
 * and this desktop's device id, exactly as the desktop UI does.
 */
export class RcSessionReader {
    options;
    constructor(options) {
        this.options = options;
    }
    async listDevices(consumerDeviceId, signal) {
        const body = await readManagedCloudJson(this.options, `${RC_BASE}/phone/bindings`, {
            query: new URLSearchParams({
                device_id: consumerDeviceId,
                consumer_type: 'desktop',
                rc_protocol_version: RC_PROTOCOL_VERSION,
            }),
            ...(signal ? { signal } : {}),
        });
        if (!Array.isArray(body.bindings))
            throw invalidResponse();
        return body.bindings.flatMap((value) => {
            const item = asRecord(value);
            const bindingId = item?.binding_id;
            if (typeof bindingId !== 'number' || !Number.isSafeInteger(bindingId) || bindingId <= 0)
                return [];
            const name = nonBlank(item?.display_name) ?? nonBlank(item?.device_name);
            const platform = nonBlank(item?.platform);
            return [
                {
                    bindingId,
                    ...(name ? { name } : {}),
                    ...(platform ? { platform } : {}),
                    online: typeof item?.online === 'boolean' ? item.online : null,
                },
            ];
        });
    }
    /** The controlled device's sidebar session list (flat, one page). */
    async listSessions(consumerDeviceId, bindingId, signal) {
        const body = await this.read(consumerDeviceId, bindingId, '/sidebar/session', signal);
        const sessions = body.sessions ?? [];
        if (!Array.isArray(sessions))
            throw invalidResponse();
        return sessions;
    }
    /**
     * One page of the controlled device's projects, each with its first sessions
     * (`ListProjects`, the paged list the Remote Control UI uses). `cursor` pages
     * projects; a project's further sessions continue with `listProjectSessions`.
     */
    async listProjects(consumerDeviceId, bindingId, options, signal) {
        const query = new URLSearchParams({
            limit: String(options.limit),
            session_limit: String(options.sessionLimit),
        });
        if (options.agentName)
            query.set('agent_name', options.agentName);
        if (options.cursor)
            query.set('cursor', options.cursor);
        const body = await this.read(consumerDeviceId, bindingId, '/projects', signal, query);
        const projects = body.projects ?? [];
        if (!Array.isArray(projects))
            throw invalidResponse();
        const page = readPage(body);
        return {
            projects: projects.map((value) => {
                const group = asRecord(value);
                if (!group)
                    throw invalidResponse();
                const project = asRecord(group.project) ?? {};
                const sessions = group.sessions ?? [];
                if (!Array.isArray(sessions))
                    throw invalidResponse();
                const more = readPage(group, 'has_more_sessions', 'hasMoreSessions', 'next_session_cursor', 'nextSessionCursor');
                const workspaceDir = nonBlank(project.workspace_dir) ?? nonBlank(project.workspaceDir);
                const projectKey = nonBlank(project.key);
                return {
                    ...(workspaceDir ? { workspaceDir } : {}),
                    ...(projectKey ? { projectKey } : {}),
                    sessions,
                    hasMoreSessions: more.hasMore,
                    ...(more.nextCursor ? { nextSessionCursor: more.nextCursor } : {}),
                };
            }),
            hasMore: page.hasMore,
            ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
        };
    }
    /** One page of a project's sessions on the controlled device (`ListProjectSessions`). */
    async listProjectSessions(consumerDeviceId, bindingId, options, signal) {
        const query = new URLSearchParams({ limit: String(options.limit) });
        if (options.workspaceDir)
            query.set('workspace_dir', options.workspaceDir);
        else if (options.projectKey)
            query.set('project_key', options.projectKey);
        else
            throw new CloudSessionReadError(400, 'INVALID_PROJECT', 'A project identity is required');
        if (options.agentName)
            query.set('agent_name', options.agentName);
        if (options.cursor)
            query.set('cursor', options.cursor);
        const body = await this.read(consumerDeviceId, bindingId, '/project/sessions', signal, query);
        const sessions = body.sessions ?? [];
        if (!Array.isArray(sessions))
            throw invalidResponse();
        const page = readPage(body);
        return {
            sessions,
            hasMore: page.hasMore,
            ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
        };
    }
    /** The controlled device's `GetSession` response. */
    getSession(consumerDeviceId, bindingId, sessionId, signal) {
        return this.read(consumerDeviceId, bindingId, `/session/${sessionPath(sessionId)}`, signal);
    }
    /** One history page of a session on the controlled device. */
    async getMessages(consumerDeviceId, bindingId, sessionId, options = {}, signal) {
        const query = new URLSearchParams();
        if (options.limit !== undefined)
            query.set('limit', String(options.limit));
        if (options.before)
            query.set('before', options.before);
        const body = await this.read(consumerDeviceId, bindingId, `/session/${sessionPath(sessionId)}/message`, signal, query);
        const messages = readMessages(body);
        const hasMore = body.has_more ?? body.hasMore;
        if (hasMore !== undefined && typeof hasMore !== 'boolean')
            throw invalidResponse();
        const nextCursor = nonBlank(body.next_cursor) ??
            nonBlank(body.nextCursor) ??
            (hasMore === true ? nonBlank(body.oldest_msg_id) : undefined);
        return {
            messages,
            hasMore: hasMore ?? Boolean(nextCursor),
            ...(nextCursor ? { nextCursor } : {}),
        };
    }
    /** Delivers one message to a session on the controlled device (RCSendRemoteMessage). */
    async sendRemoteMessage(consumerDeviceId, bindingId, send, signal) {
        const body = await this.read(consumerDeviceId, bindingId, `/session/${sessionPath(send.sessionId)}/remote-message`, signal, undefined, remoteMessageBody(send));
        return readRemoteMessageResult(body);
    }
    async read(consumerDeviceId, bindingId, suffix, signal, query, body) {
        const answer = await readManagedCloudJson(this.options, `${RC_BASE}${suffix}`, {
            headers: {
                'X-Binding-Id': String(bindingId),
                'X-Consumer-Device-Id': consumerDeviceId,
                'X-Mobile-Device-Id': consumerDeviceId,
                ...RC_ERROR_CONTRACT_HEADER,
            },
            ...(body ? { method: 'POST', body } : {}),
            ...(query ? { query } : {}),
            ...(signal ? { signal } : {}),
        });
        // A gateway without the v2 contract still answers an offline device this way; never a result.
        if (answer.state === 'connecting') {
            throw new CloudSessionReadError(409, 'CLOUD_READ_FAILED', 'Remote Control device is offline (connecting)', 'DEVICE_OFFLINE');
        }
        return answer;
    }
}
/** History arrives either as the desktop message array or as the gateway's JSON text. */
function readMessages(body) {
    if (Array.isArray(body.messages))
        return body.messages;
    const text = body.messages_json ?? body.messagesJson;
    if (typeof text === 'string') {
        let parsed;
        try {
            parsed = JSON.parse(text);
        }
        catch {
            throw invalidResponse();
        }
        if (Array.isArray(parsed))
            return parsed;
        throw invalidResponse();
    }
    if (body.messages === undefined)
        return [];
    throw invalidResponse();
}
function sessionPath(sessionId) {
    if (!sessionId.trim() || sessionId === '.' || sessionId === '..')
        throw new CloudSessionReadError(400, 'INVALID_SESSION_ID', 'A concrete session ID is required');
    return encodeURIComponent(sessionId);
}
/** Paging fields of a desktop list answer, in either wire casing; `hasMore` needs a cursor. */
function readPage(body, moreKey = 'has_more', moreAlias = 'hasMore', cursorKey = 'next_cursor', cursorAlias = 'nextCursor') {
    const hasMore = body[moreKey] ?? body[moreAlias];
    if (hasMore !== undefined && typeof hasMore !== 'boolean')
        throw invalidResponse();
    const nextCursor = nonBlank(body[cursorKey]) ?? nonBlank(body[cursorAlias]);
    if (hasMore === true && !nextCursor)
        throw invalidResponse();
    return { hasMore: hasMore === true, ...(hasMore === true && nextCursor ? { nextCursor } : {}) };
}
function asRecord(value) {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value
        : undefined;
}
function nonBlank(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
function invalidResponse() {
    return new CloudSessionReadError(502, 'INVALID_REMOTE_CONTROL_RESPONSE', 'Remote Control response is invalid');
}
//# sourceMappingURL=rc-session-reader.js.map