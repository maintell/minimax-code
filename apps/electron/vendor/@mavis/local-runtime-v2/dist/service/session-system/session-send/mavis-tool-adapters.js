import { createSessionWithFirstMessage } from './mavis-session-create.js';
import { interruptLocalSession } from './mavis-session-interrupt.js';
import { sendToLocalSession } from './mavis-session-send.js';
import { isAbortError } from './remote-sessions/device-source.js';
import { countRemoteSessionOp, localDeviceName, sendToRemoteSession, } from './remote-sessions/remote-session-send.js';
export function buildMavisSessionAdapter(deps) {
    return {
        listSessions: async (req, signal) => {
            if (isRemoteSource(req.source)) {
                const source = req.source;
                return countRemoteOp(deps, { op: 'list', source, signal }, () => requireRemote(deps, source).listSessions({ ...req, source }, signal));
            }
            let archived;
            if (req.archiveFilter === 'Archived')
                archived = true;
            else if (req.archiveFilter === 'Unarchived')
                archived = false;
            const scope = req.agentName && deps.resolveAgentReadScope
                ? await deps.resolveAgentReadScope(req.agentName)
                : undefined;
            const sessions = (await deps.listAllSessions(scope ? undefined : req.agentName, {
                archived,
                ...(scope ? { agentNames: scope.compatibleNames } : {}),
            })).filter((session) => req.parentSessionId === undefined || session.parentSessionId === req.parentSessionId);
            const page = pageBySessionCursor(sessions, req.cursor, req.limit);
            return {
                sessions: await deps.serializeSessions(page.items),
                hasMore: page.hasMore,
                ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
            };
        },
        getSession: async (req, signal) => {
            if (isRemoteSource(req.source)) {
                const source = req.source;
                return countRemoteOp(deps, { op: 'get', source, signal }, () => requireRemote(deps, source).getSession({ ...req, source }, signal));
            }
            const session = await deps.getSessionById(req.sessionId);
            return { ...(session ? { session: await deps.serializeSession(session) } : {}) };
        },
        updateSession: async (req) => {
            const invalid = invalidUpdateField(req);
            if (invalid) {
                throw Object.assign(new Error(`${invalid} is not a valid value`), {
                    status: 400,
                    code: 'SESSION_UPDATE_INVALID_FIELD',
                    field: invalid,
                });
            }
            const current = await deps.getSessionById(req.sessionId);
            if (!current) {
                throw Object.assign(new Error(`Session not found: ${req.sessionId}`), {
                    status: 404,
                    code: 'SESSION_NOT_FOUND',
                });
            }
            const updated = await writeSessionUpdate(deps, req);
            return { session: await deps.serializeSession(updated ?? current), success: true };
        },
        listMessages: async (req, signal) => {
            if (isRemoteSource(req.source)) {
                const source = req.source;
                return countRemoteOp(deps, { op: 'messages', source, signal }, () => requireRemote(deps, source).listMessages({ ...req, source }, signal));
            }
            const page = await deps.listDisplayMessages(req.sessionId, {
                ...(req.limit !== undefined ? { limit: req.limit } : {}),
                ...(req.before ? { before: req.before } : {}),
            });
            return {
                messages: page.messages,
                hasMore: page.hasMore,
                ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
            };
        },
        sendSession: async (req, signal) => {
            if (!isRemoteSource(req.source))
                return sendToLocalSession(deps, req, signal);
            const source = req.source;
            return countRemoteOp(deps, { op: 'send', source, signal }, async () => {
                const remote = requireRemote(deps, source);
                return sendToRemoteSession({ remote, ...(deps.metrics ? { metrics: deps.metrics } : {}) }, {
                    source,
                    sessionId: req.sessionId,
                    ...(req.deviceId ? { deviceId: req.deviceId } : {}),
                    content: req.content,
                    ...(req.sync !== undefined ? { sync: req.sync } : {}),
                    ...(req.forceSteer !== undefined ? { forceSteer: req.forceSteer } : {}),
                    sender: await remoteSender(deps, req.callerSessionId),
                }, signal);
            });
        },
        interruptSession: (req) => interruptLocalSession(deps, req),
        createSession: (req, signal) => createSessionWithFirstMessage(deps, req, signal),
    };
}
function isRemoteSource(source) {
    return source !== undefined && source !== 'local';
}
/**
 * One mavis session command against a ssh / rc / cloud session, counted once
 * when it settles. A sync send that waited and then answered with its ACK is an
 * `ok` call: the target took the message. The caller's own cancel is
 * `aborted`, never a failure of the remote side. The result and the thrown
 * error are passed through untouched.
 */
async function countRemoteOp(deps, call, run) {
    const { op, source, signal } = call;
    try {
        const result = await run();
        countRemoteSessionOp(deps.metrics, { op, source, status: 'ok' });
        return result;
    }
    catch (error) {
        const aborted = isAbortError(error) || signal?.aborted === true;
        countRemoteSessionOp(deps.metrics, {
            op,
            source,
            status: aborted ? 'aborted' : 'error',
            error,
        });
        throw error;
    }
}
/** A remote read never falls back to local storage, even when the host cannot serve it. */
function requireRemote(deps, source) {
    if (deps.remoteSessions)
        return deps.remoteSessions;
    throw Object.assign(new Error(`${source} session reading is unavailable on this host`), {
        status: 503,
        code: 'REMOTE_SESSIONS_UNAVAILABLE',
    });
}
/**
 * Who the remote session sees as the sender: this session, this desktop and the
 * session's agent and title. A missing record still names the caller by id.
 */
async function remoteSender(deps, callerSessionId) {
    const caller = await callerSession(deps, callerSessionId);
    const deviceName = localDeviceName();
    const title = caller?.title?.trim();
    return {
        sessionId: callerSessionId,
        ...(deviceName ? { deviceName } : {}),
        ...(caller?.agentName ? { agentName: caller.agentName } : {}),
        ...(title ? { title } : {}),
    };
}
/** The caller's own record, or nothing when this desktop cannot read it. */
async function callerSession(deps, callerSessionId) {
    try {
        return await deps.getSessionById(callerSessionId);
    }
    catch {
        return undefined;
    }
}
/**
 * The model-facing values the lifecycle does not reject on its own. A failure
 * here happens before any write, so the rest of the update never lands.
 */
function invalidUpdateField(req) {
    if (req.model !== undefined && !/^[^/\s]+\/[^/\s]+$/.test(req.model))
        return 'model';
    return undefined;
}
function writeSessionUpdate(deps, req) {
    return deps.updateSession(req.sessionId, {
        ...(Object.hasOwn(req, 'title') ? { title: req.title } : {}),
        ...(Object.hasOwn(req, 'archived') ? { archived: req.archived } : {}),
        ...(Object.hasOwn(req, 'model') ? { effectiveModel: req.model } : {}),
    });
}
function pageBySessionCursor(items, cursor, limit) {
    const start = cursor === undefined
        ? 0
        : Math.max(0, items.findIndex((item) => item.sessionId === cursor) + 1);
    return pageItems(items.slice(start), limit, (item) => item.sessionId);
}
function pageItems(items, limit, cursorFor) {
    if (limit === undefined || limit <= 0)
        return { items, hasMore: false };
    const page = items.slice(0, limit);
    const hasMore = items.length > limit;
    const lastItem = page.at(-1);
    const nextCursor = hasMore && lastItem ? cursorFor(lastItem) : undefined;
    return {
        items: page,
        hasMore,
        ...(nextCursor ? { nextCursor } : {}),
    };
}
//# sourceMappingURL=mavis-tool-adapters.js.map