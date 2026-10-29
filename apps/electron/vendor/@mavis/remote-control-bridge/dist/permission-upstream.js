/**
 * T3 — event upstream: local-runtime bus → evt.* frames.
 *
 * Forwards the public desktop event catalog, not just permission.*. Every
 * decoded event is sent upstream:
 *   - permission.ask / permission.resolved  → dedicated frames (below)
 *   - every other admitted Global Event
 *     → verbatim evt.<domain>.<action> frame: either a payload-shaped one
 *       from event-frame-mapper (mapBusEventToFrame) or the generic
 *       frame-codec.makeBusEventFrame fallback — both keep the bus event
 *       type verbatim with an `evt.` prefix, dots preserved, so the
 *       domain/action hierarchy matches the desktop bus (session.finish →
 *       evt.session.finish). The gateway strips the `evt.` prefix on its
 *       RC-events outlet, so the phone receives the bare desktop bus type.
 *
 * Bus subscription surface: a host-injected stream of events already admitted
 * by the shared frontend Global Event catalog. The Electron adapter owns the
 * generated DesktopService client, wire decoding, and stream close semantics.
 *
 * Events consumed (train choke points @ api/routes/permissions.ts):
 *   permission.ask      payload = serializePermissionRequest(record):
 *     {requestId, sessionId, agentName, toolName, ruleContents: string[],
 *      toolInput?, toolDescription?, reason, allowAlwaysSupported, createdAt}
 *   permission.resolved payload = {requestId, sessionId, decision}
 *     (single settle choke point: UI reply / IM reply / DELETE dismiss /
 *      session abort — preview_train ccf895f00)
 *
 * Outbound permission frames (type parity: bare bus type + evt. prefix; the
 * gateway strips the prefix so the phone sees `permission.ask` /
 * `permission.resolved` — its isPermissionEventType bypass matches these
 * exact evt.permission.* strings, renamed in lockstep):
 *   evt.permission.ask
 *     {session_id, request_id, tool_name, tool_input, rule_contents?,
 *      tool_description?, reason?, ts_ms}
 *     — bus ruleContents is string[]; rule_contents is a single string →
 *       joined with '\n' (reported). tool_input is required → '' when absent.
 *   evt.permission.resolved
 *     {session_id, request_id, decision} — the daemon-native decision string
 *     is passed verbatim (allowAlways|allowOnce|deny; the IDL comment's
 *     "allow | deny" wording vs daemon strings is reported as ambiguity).
 *
 * in_reply_to rule (IDL WsEnvelope note): permission_* born from an
 * RC-cmd-triggered turn carries in_reply_to = that cmd.id — resolved via the
 * stream-pump's session→cmd registry (getActiveCmdId). Anything else (a
 * local desktop turn) goes out WITHOUT in_reply_to as a broadcast frame.
 *
 * Delivery semantics: most frames are only sent while the WS is connected.
 * Notification-trigger events (permission.ask, questionnaire.ask,
 * session.finish, and a thread_goal.updated that completes a Goal or needs
 * the user) use a bounded in-memory buffer across transient WS reconnects that
 * keeps only the newest pending event per session. A Goal Turn's
 * session.finish (it carries `goalId`) is never buffered: the Goal notifies
 * through its own state instead. stop() clears that buffer, so deliberate
 * disconnect, unbind, account switch, and process shutdown cannot replay an
 * old account's events. Terminal permission/questionnaire events invalidate
 * their matching buffered ask before delivery, and a later state of the same
 * Goal that needs no notification (resumed, user-paused, cleared) invalidates
 * its buffered Goal notification, so reconnect cannot resurrect an
 * already-settled UI or a stale Goal state. Online forwarding is unchanged.
 * The bus subscription itself stays open from start() to stop() and reconnects
 * with a fixed delay if the runtime restarts.
 *
 * Audit redaction: tool_input / rule_contents / reason NEVER hit the log —
 * only event type + ids and drop/sent counters (plan §10 data_json rule).
 */
import { FRAME_TYPES, makeFrame, makeBusEventFrame } from './frame-codec.js';
import { mapBusEventToFrame } from './event-frame-mapper.js';
export const EVENTS_RETRY_DELAY_MS = 5_000;
export const NOTIFICATION_EVENT_BUFFER_LIMIT = 100;
const NOTIFICATION_TRIGGER_EVENT_TYPES = new Set([
    'permission.ask',
    'questionnaire.ask',
    'session.finish',
    'thread_goal.updated',
]);
/** Goal states the user is told about: completion, or needing the user. */
const GOAL_ATTENTION_STATUSES = new Set(['complete', 'blocked', 'usage_limited', 'budget_limited']);
const GOAL_USER_PAUSE_REASON = 'paused(user_requested)';
const SESSION_MUTATION_EVENT_TYPES = new Set([
    'session.title_updated',
    'session.model_updated',
    'session.pinned_updated',
    'session.deleted',
    'session.interaction_mode.changed',
]);
export class PermissionUpstream {
    deps;
    controller = null;
    running = false;
    generation = 0;
    pendingNotificationEvents = new Map();
    constructor(deps) {
        this.deps = deps;
    }
    isRunning() {
        return this.running;
    }
    /** Idempotent: opens the events bus subscription loop. */
    start() {
        if (this.running)
            return;
        this.running = true;
        const generation = ++this.generation;
        void this.loop(generation);
    }
    /** Aborts the in-flight events stream and stops the retry loop. */
    stop() {
        this.clearPendingNotifications('stop');
        if (!this.running)
            return;
        this.running = false;
        this.generation += 1;
        this.controller?.abort();
        this.controller = null;
    }
    /** Flush notification-trigger events after a successful WS handshake. */
    onConnected() {
        if (!this.running || !this.deps.sender.isConnected())
            return;
        while (this.deps.sender.isConnected()) {
            const next = this.pendingNotificationEvents.entries().next();
            if (next.done)
                return;
            const [key, event] = next.value;
            this.pendingNotificationEvents.delete(key);
            this.handleGlobalEvent(event);
            // A send failure re-buffers the same event. Stop until the next
            // successful handshake rather than spinning on a broken sender.
            if (this.pendingNotificationEvents.has(key))
                return;
        }
    }
    isActive(generation) {
        return this.running && this.generation === generation;
    }
    async loop(generation) {
        const retryDelayMs = this.deps.retryDelayMs ?? EVENTS_RETRY_DELAY_MS;
        while (this.isActive(generation)) {
            const controller = new AbortController();
            this.controller = controller;
            try {
                this.deps.logger.info('[rc.permission] events bus subscription open');
                for await (const event of this.deps.eventSource(controller.signal)) {
                    if (!this.isActive(generation))
                        break;
                    this.handleGlobalEvent(event);
                }
                this.deps.logger.info('[rc.permission] events bus stream ended');
            }
            catch (err) {
                if (this.isActive(generation)) {
                    this.deps.logger.warn(`[rc.permission] events stream error: ${err instanceof Error ? err.message : String(err)}`);
                }
            }
            if (!this.isActive(generation))
                return;
            await sleep(retryDelayMs, controller.signal);
            if (this.controller === controller)
                this.controller = null;
        }
    }
    handleGlobalEvent(event) {
        const { type, timestamp } = event;
        const { payload } = event;
        this.cancelBufferedAskForTerminalEvent(event);
        this.cancelBufferedGoalStateForNewerState(event);
        if (type === 'permission.ask' || type === 'permission.resolved') {
            this.handlePermissionEvent(type, payload, timestamp);
            return;
        }
        this.forwardGenericEvent(type, payload, timestamp);
    }
    /**
     * Non-permission Global Events → verbatim evt.* frames.
     *
     * event-frame-mapper entries shape the payload (field pruning, JSON
     * carriers); the remaining public catalog falls back to makeBusEventFrame.
     * Admission already happened in the host adapter, so backend-internal event
     * types cannot reach this method in production.
     *
     * All of these go out as broadcast frames WITHOUT in_reply_to: the
     * gateway's turn relay drops non-permission evt.* frames that carry
     * in_reply_to (translateTurnFrameToRespData → skipped), so an in_reply_to
     * would make turn-time events vanish. They are out-of-band activity
     * notifications and semantically belong on the broadcast events stream, not
     * a turn's response stream. (permission frames keep in_reply_to — the relay
     * has a dedicated bypass for them.)
     */
    forwardGenericEvent(type, payload, timestamp) {
        const sessionId = readString(payload.sessionId);
        const turnId = readString(payload.turnId);
        const requestId = readString(payload.requestId);
        if (!this.deps.sender.isConnected()) {
            if (this.bufferNotificationEvent({ type, payload, timestamp }, 'ws_down'))
                return;
            this.logGenericEventDelivery(type, `evt.${type}`, 'dropped_ws_down', sessionId, turnId, requestId);
            return;
        }
        const mapped = mapBusEventToFrame(type, payload, timestamp);
        const frame = mapped
            ? makeFrame(mapped.type, mapped.payload)
            : makeBusEventFrame(type, payload, timestamp);
        const sent = this.deps.sender.sendFrame(frame);
        this.logGenericEventDelivery(type, frame.type, sent ? 'sent' : 'send_failed', sessionId, turnId, requestId);
        if (!sent)
            this.bufferNotificationEvent({ type, payload, timestamp }, 'send_failed');
    }
    logGenericEventDelivery(type, wsType, status, sessionId, turnId, requestId) {
        // Redaction: correlation IDs only — never payload/title contents.
        const message = `component=rc_event_upstream event=event_forward event_type=${type} ws_type=${wsType}${sessionId ? ` session_id=${sessionId}` : ''}${turnId ? ` turn_id=${turnId}` : ''}${requestId ? ` request_id=${requestId}` : ''} status=${status}`;
        if (status === 'sent') {
            this.deps.logger.info(message);
            return;
        }
        if (SESSION_MUTATION_EVENT_TYPES.has(type) || status === 'send_failed') {
            this.deps.logger.warn(message);
            return;
        }
        this.deps.logger.debug(message);
    }
    handlePermissionEvent(type, payload, timestamp) {
        const sessionId = readString(payload.sessionId);
        const requestId = readString(payload.requestId);
        const turnId = readString(payload.turnId);
        if (!sessionId || !requestId) {
            this.deps.logger.warn(`[rc.permission] ${type} missing sessionId/requestId — dropped`);
            return;
        }
        if (!this.deps.sender.isConnected()) {
            if (this.bufferNotificationEvent({ type, payload, timestamp }, 'ws_down'))
                return;
            this.deps.logger.debug(`[rc.permission] ${type} while WS down — dropped`);
            return;
        }
        // IDL WsEnvelope in_reply_to rule: RC-cmd-triggered turn → tie the frame
        // back to the cmd; local desktop turns broadcast without it.
        const activeCmdId = this.deps.getActiveCmdId(sessionId);
        const frame = type === 'permission.ask'
            ? makeFrame(FRAME_TYPES.EVT_PERMISSION_ASK, buildAskPayload(sessionId, requestId, payload), activeCmdId ? { inReplyTo: activeCmdId } : {})
            : makeFrame(FRAME_TYPES.EVT_PERMISSION_RESOLVED, {
                session_id: sessionId,
                request_id: requestId,
                // daemon-native decision string verbatim (allowAlways|allowOnce|deny)
                decision: readString(payload.decision) ?? '',
            }, activeCmdId ? { inReplyTo: activeCmdId } : {});
        const sent = this.deps.sender.sendFrame(frame);
        if (!sent)
            this.bufferNotificationEvent({ type, payload, timestamp }, 'send_failed');
        // Redaction: ids only — never tool_input/rule_contents/reason contents.
        this.deps.logger.info(`[rc.permission] ${type} → ${frame.type} request_id=${requestId} session=${sessionId}${turnId ? ` turn_id=${turnId}` : ''}${activeCmdId ? ` in_reply_to=${activeCmdId}` : ' (broadcast)'} sent=${sent}`);
    }
    bufferNotificationEvent(event, reason) {
        if (!NOTIFICATION_TRIGGER_EVENT_TYPES.has(event.type))
            return false;
        if (event.type === 'thread_goal.updated' && !isGoalNotificationState(event.payload)) {
            return false;
        }
        const key = notificationEventSessionId(event);
        const sessionId = key;
        const turnId = readString(event.payload.turnId);
        const requestId = readString(event.payload.requestId);
        const identity = `${sessionId ? ` session_id=${sessionId}` : ''}${turnId ? ` turn_id=${turnId}` : ''}${requestId ? ` request_id=${requestId}` : ''}`;
        if (!key) {
            this.deps.logger.warn(`component=rc_event_upstream event=notification_buffer event_type=${event.type}${identity} status=dropped_missing_identity`);
            return true;
        }
        if (event.type === 'session.finish' && readString(event.payload.goalId)) {
            this.deps.logger.info(`component=rc_event_upstream event=notification_buffer event_type=${event.type}${identity} status=dropped_goal_turn_end`);
            return true;
        }
        // One pending notification per session: the newest replaces the older one.
        this.pendingNotificationEvents.delete(key);
        const limit = Math.max(1, this.deps.pendingNotificationLimit ?? NOTIFICATION_EVENT_BUFFER_LIMIT);
        if (this.pendingNotificationEvents.size >= limit) {
            const oldest = this.pendingNotificationEvents.keys().next();
            if (!oldest.done)
                this.pendingNotificationEvents.delete(oldest.value);
            this.deps.logger.warn(`component=rc_event_upstream event=notification_buffer event_type=${event.type}${identity} status=evicted_oldest limit=${limit}`);
        }
        this.pendingNotificationEvents.set(key, {
            type: event.type,
            timestamp: event.timestamp,
            payload: { ...event.payload },
        });
        this.deps.logger.info(`component=rc_event_upstream event=notification_buffer event_type=${event.type}${identity} status=buffered reason=${reason} pending=${this.pendingNotificationEvents.size}`);
        return true;
    }
    cancelBufferedAskForTerminalEvent(event) {
        const askType = terminalNotificationAskType(event);
        const sessionId = readString(event.payload.sessionId);
        const requestId = readString(event.payload.requestId);
        if (!askType || !sessionId || !requestId)
            return;
        const pending = this.pendingNotificationEvents.get(sessionId);
        if (pending?.type !== askType || readString(pending.payload.requestId) !== requestId)
            return;
        this.pendingNotificationEvents.delete(sessionId);
        this.deps.logger.info(`component=rc_event_upstream event=notification_buffer event_type=${event.type}${sessionId ? ` session_id=${sessionId}` : ''}${requestId ? ` request_id=${requestId}` : ''} status=cancelled_terminal pending=${this.pendingNotificationEvents.size}`);
    }
    /**
     * A buffered Goal notification is stale once the same Goal moves on without
     * needing the user (resumed, user-paused) or is cleared, and once another
     * Goal updates in that Session: creating a Goal replaces a finished one
     * without a cleared event, and the client applies a replayed update as the
     * Session's current Goal. Drop it so reconnect cannot replay an old
     * completion/attention state; a buffered ask stays.
     */
    cancelBufferedGoalStateForNewerState(event) {
        const succession = goalStateSuccession(event);
        if (!succession)
            return;
        const pending = this.pendingNotificationEvents.get(succession.sessionId);
        if (pending?.type !== 'thread_goal.updated')
            return;
        const pendingGoal = pending.payload.goal;
        const pendingGoalId = pendingGoal && typeof pendingGoal === 'object'
            ? readString(Reflect.get(pendingGoal, 'goalId'))
            : undefined;
        if (pendingGoalId === succession.goalId && !succession.supersedesSameGoal)
            return;
        this.pendingNotificationEvents.delete(succession.sessionId);
        this.deps.logger.info(`component=rc_event_upstream event=notification_buffer event_type=${event.type} session_id=${succession.sessionId} status=cancelled_superseded_goal pending=${this.pendingNotificationEvents.size}`);
    }
    clearPendingNotifications(reason) {
        const count = this.pendingNotificationEvents.size;
        this.pendingNotificationEvents.clear();
        if (count > 0) {
            this.deps.logger.info(`component=rc_event_upstream event=notification_buffer status=cleared reason=${reason} count=${count}`);
        }
    }
}
/** Session a notification-trigger event belongs to; the buffer keeps one per session. */
function notificationEventSessionId(event) {
    if (event.type === 'thread_goal.updated') {
        const goal = event.payload.goal;
        return goal && typeof goal === 'object'
            ? readString(Reflect.get(goal, 'sessionId'))
            : undefined;
    }
    const sessionId = readString(event.payload.sessionId);
    if (!sessionId)
        return undefined;
    // An ask is only replayable with its request identity; a Turn end with its Turn.
    const identity = event.type === 'session.finish'
        ? readString(event.payload.turnId)
        : readString(event.payload.requestId);
    return identity ? sessionId : undefined;
}
function isGoalNotificationState(payload) {
    const goal = payload.goal;
    if (!goal || typeof goal !== 'object')
        return false;
    const status = readString(Reflect.get(goal, 'status'));
    if (status && GOAL_ATTENTION_STATUSES.has(status))
        return true;
    if (status !== 'paused')
        return false;
    const reason = readString(Reflect.get(goal, 'statusReason'));
    return reason !== undefined && reason !== GOAL_USER_PAUSE_REASON;
}
/**
 * The Session Goal a Goal event reports. It supersedes a buffered state of
 * another Goal in any case; of the same Goal only as a clear or an update that
 * no longer needs the user.
 */
function goalStateSuccession(event) {
    if (event.type === 'thread_goal.cleared') {
        const sessionId = readString(event.payload.sessionId);
        const goalId = readString(event.payload.goalId);
        return sessionId && goalId ? { sessionId, goalId, supersedesSameGoal: true } : undefined;
    }
    if (event.type !== 'thread_goal.updated')
        return undefined;
    const goal = event.payload.goal;
    if (!goal || typeof goal !== 'object')
        return undefined;
    const sessionId = readString(Reflect.get(goal, 'sessionId'));
    const goalId = readString(Reflect.get(goal, 'goalId'));
    if (!sessionId || !goalId)
        return undefined;
    return { sessionId, goalId, supersedesSameGoal: !isGoalNotificationState(event.payload) };
}
function terminalNotificationAskType(event) {
    if (event.type === 'permission.resolved')
        return 'permission.ask';
    if (event.type === 'questionnaire.dismiss' || event.type === 'questionnaire.superseded') {
        return 'questionnaire.ask';
    }
    return undefined;
}
/** Bus serializePermissionRequest → IDL EvtSessionPermissionAskPayload. */
function buildAskPayload(sessionId, requestId, payload) {
    const ruleContents = Array.isArray(payload.ruleContents)
        ? payload.ruleContents.filter((entry) => typeof entry === 'string')
        : [];
    const toolDescription = readString(payload.toolDescription);
    const reason = readString(payload.reason);
    const turnId = readString(payload.turnId);
    const createdAt = typeof payload.createdAt === 'number' ? payload.createdAt : Date.now();
    return {
        session_id: sessionId,
        request_id: requestId,
        ...(turnId ? { turn_id: turnId } : {}),
        tool_name: readString(payload.toolName) ?? '',
        tool_input: readString(payload.toolInput) ?? '',
        ...(ruleContents.length > 0 ? { rule_contents: ruleContents.join('\n') } : {}),
        ...(toolDescription ? { tool_description: toolDescription } : {}),
        ...(reason ? { reason } : {}),
        ts_ms: createdAt,
    };
}
function readString(value) {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}
function sleep(ms, signal) {
    return new Promise((resolve) => {
        if (signal.aborted) {
            resolve();
            return;
        }
        const onAbort = () => {
            clearTimeout(timer);
            resolve();
        };
        const timer = setTimeout(() => {
            signal.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        signal.addEventListener('abort', onAbort, { once: true });
    });
}
//# sourceMappingURL=permission-upstream.js.map