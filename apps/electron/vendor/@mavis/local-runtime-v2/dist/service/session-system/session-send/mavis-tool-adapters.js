import { isBunnyAgentName } from '@mavis/shared/agent-avatar';
import { logger } from '../../../infra/logging/logger.js';
import { NESTED_TASK_REFUSAL, SESSION_FOREIGN_TARGET, TASK_TO_COORDINATOR_REFUSAL, } from '../../coordinator-text/index.js';
import { createSessionWithFirstMessage } from './mavis-session-create.js';
import { interruptLocalSession } from './mavis-session-interrupt.js';
import { unreadableDispatchAttachments } from '../../../infra/conversation/dispatch-attachments.js';
import { sendToLocalSession } from './mavis-session-send.js';
import { sessionSendError } from './mavis-session-send-errors.js';
import { isAbortError } from './remote-sessions/device-source.js';
import { countRemoteSessionOp, localDeviceName, sendToRemoteSession, } from './remote-sessions/remote-session-send.js';
export function buildMavisSessionAdapter(deps) {
    const { isBunnyTask, confirmBunnyTask, ...assignmentTools } = deps.assignmentTools ?? {};
    /**
     * Bunny reads every Session but stops, edits and messages only its own task
     * Sessions. Checked here, on the server side, so no permission mode or tool
     * path can widen it; without the Bunny owner a Bunny caller may target none.
     */
    const requireBunnyTarget = async (callerSessionId, sessionId) => {
        if (!callerSessionId)
            return;
        const caller = await deps.getSessionById(callerSessionId);
        if (!isBunnyAgentName(caller?.agentName))
            return;
        if ((confirmBunnyTask ?? isBunnyTask)?.(sessionId))
            return;
        throw sessionSendError(SESSION_FOREIGN_TARGET, {
            status: 403,
            code: 'BUNNY_TARGET_NOT_OWN_TASK',
            sessionId,
            reason: 'bunny-foreign-target',
        });
    };
    /** Reads nothing, so a caller that is not one of Bunny's tasks pays nothing for the task rules. */
    const isTask = (sessionId) => sessionId !== undefined && isBunnyTask?.(sessionId) === true;
    /**
     * A task's results reach Bunny only as its report (3.3). A message from the
     * task to a Bunny conversation would wake Bunny outside its wake sources.
     */
    const requireNotToBunny = async (callerSessionId, sessionId) => {
        if (!isTask(callerSessionId))
            return;
        const target = await deps.getSessionById(sessionId);
        if (!isBunnyAgentName(target?.agentName) || isTask(sessionId))
            return;
        throw sessionSendError(TASK_TO_COORDINATOR_REFUSAL, {
            status: 403,
            code: 'ASSIGNMENT_TASK_TO_BUNNY',
            sessionId,
            reason: 'task-to-bunny',
        });
    };
    /** A task never starts Sessions beside it (3.1); the refusal points to its sub-Agents. */
    const sessionCreateRefusal = async (callerSessionId) => isTask(callerSessionId)
        ? { code: 'ASSIGNMENT_NESTED_TASK', message: NESTED_TASK_REFUSAL }
        : undefined;
    return {
        ...assignmentTools,
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
            await requireBunnyTarget(req.callerSessionId, req.sessionId);
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
            await requireBunnyTarget(req.callerSessionId, req.sessionId);
            await requireNotToBunny(req.callerSessionId, req.sessionId);
            if (isRemoteSource(req.source)) {
                const source = req.source;
                // Attachments are this device's local paths; a remote target cannot read them, and
                // silently dropping them would report a delivery that lost its files.
                if (req.attachments?.length)
                    throw Object.assign(new Error('attachments cannot be sent to a Session on another device'), { status: 400, code: 'SESSION_SEND_ATTACHMENTS_UNSUPPORTED' });
                return countRemoteOp(deps, { op: 'send', source, signal }, async () => {
                    const remote = requireRemote(deps, source);
                    return sendToRemoteSession({ remote, ...(deps.metrics ? { metrics: deps.metrics } : {}) }, {
                        source,
                        sessionId: req.sessionId,
                        ...(req.deviceId ? { deviceId: req.deviceId } : {}),
                        content: req.content,
                        ...(req.sync !== undefined ? { sync: req.sync } : {}),
                        sender: await remoteSender(deps, req.callerSessionId),
                    }, signal);
                });
            }
            // Refused before delivery, so a bad path is a clear error instead of a failed admission
            // that rolls the assignment back.
            // Readability only, the pre-existing behaviour, and deliberately so: this entry cannot
            // tell a path the user attached in this Turn from one the model picked off disk, and
            // `assignment_send` has no auto-inherit, so the model has to name even the user's own file.
            // Applying the secret deny-list here refused a user's `.key` or 100 MiB recording outright
            // (F-05d60f). Wiring the deny-list in needs a Turn reader first; until then the tool
            // description says readability only rather than promising a defence that is not here.
            const unreadable = await unreadableDispatchAttachments(req.attachments);
            if (unreadable.length)
                throw Object.assign(new Error(`attachments must be readable files: ${unreadable.join(', ')}`), { status: 400, code: 'SESSION_SEND_ATTACHMENT_UNREADABLE' });
            if (req.reportBack !== true)
                return sendToLocalSession(deps, req, signal);
            if (!assignmentTools.prepareAssignment)
                throw new Error('Session assignment is unavailable on this host');
            const { origin, rollback, admittedHook, ...info } = withRollback(await assignmentTools.prepareAssignment(req, signal));
            let admitted = false;
            try {
                const result = await sendToLocalSession(deps, {
                    ...req,
                    assignmentOrigin: origin,
                    onAdmitted: () => {
                        admitted = true;
                        admittedHook?.();
                    },
                }, signal);
                return { ...result, ...info };
            }
            catch (error) {
                // A rejected delivery must not cost the task the assignment, and the
                // report, it had before this send.
                if (!admitted)
                    await rollBackAssignment(rollback, req.sessionId);
                throw error;
            }
        },
        interruptSession: async (req) => {
            await requireBunnyTarget(req.callerSessionId, req.sessionId);
            return interruptLocalSession(deps, req);
        },
        sessionCreateRefusal,
        createSession: async (req, signal) => {
            const refusal = await sessionCreateRefusal(req.callerSessionId);
            if (refusal)
                throw Object.assign(new Error(refusal.message), { status: 403, ...refusal });
            return createSessionWithFirstMessage(deps, req, signal);
        },
    };
}
async function rollBackAssignment(rollback, sessionId) {
    try {
        await rollback?.();
    }
    catch (error) {
        logger.warn({ sessionId, error: error instanceof Error ? error.message : String(error) }, 'Assignment rollback after a rejected send failed');
    }
}
function withRollback(prepared) {
    // `admitted` is heard once the message was admitted, so a send rolled back is never counted.
    const { rollback, admitted, ...rest } = prepared;
    return {
        ...rest,
        rollback: typeof rollback === 'function' ? rollback : undefined,
        admittedHook: typeof admitted === 'function' ? admitted : undefined,
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