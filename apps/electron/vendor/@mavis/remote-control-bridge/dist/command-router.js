/**
 * T2 — cmd.* → localRuntime command router (plan §4, 10 mappings).
 *
 * Decodes the envelope `type` + `payload` and drives the in-process
 * `handleLocalRuntimeRequest(new Request(...))` entrypoint (injected as
 * `invoke` — zero network, identity inherited from the desktop login via
 * setLocalRuntimeAuthContext; the bridge never mints its own auth).
 *
 * Downstream path map (verified against the generated desktop-service route
 * table + /mavis/api routes on this tree):
 *   1  cmd.session.list        GET  /minimax-desktop/api/v1/agent/:name/session/tree
 *                              (keyword → GET /minimax-desktop/api/v1/session/search)
 *                              + GET /minimax-desktop/api/v1/preferences/pinned-items-order
 *                              (concurrent pin-roster read — pin facts live in
 *                              PinService only, the session wire carries none)
 *                              → AckSessionListPayload projection (IDL)
 *   2  cmd.session.history     GET  /minimax-desktop/api/v1/session/:id/message
 *                              → AckSessionHistoryPayload projection (IDL)
 *   3  cmd.session.send        POST /minimax-desktop/api/v1/session/:id/message (Desktop SSE)
 *                              404 → legacy /mavis/api/session/:id/message;
 *                              busy 409 → POST /minimax-desktop/api/v1/session/:id/queue
 *                              (queue 404 → legacy /mavis/api/session/:id/queue)
 *                              attachments: URL download leg (attachment-fetch)
 *                              → Desktop AttachmentInput wire; any
 *                              failure fails the whole send (no partial sends)
 *   4  cmd.session.new         POST /minimax-desktop/api/v1/agent/:name/session
 *   5  cmd.session.resume      POST /minimax-desktop/api/v1/session/:id/resume (Desktop SSE)
 *                              (404 → legacy /mavis/api/session/:id/resume)
 *   6  cmd.session.stop        POST /minimax-desktop/api/v1/session/:id/abort
 *   7  cmd.session.pin         POST /minimax-desktop/api/v1/pin/session
 *                              (plan names /mavis/api/session/:id/pin — that route
 *                              does not exist on this tree; PinSession is the
 *                              generated DesktopService route)
 *   8  cmd.permission.respond  POST /minimax-desktop/api/v1/permission/batch-reply
 *   9  cmd.workspace.list      GET  /minimax-desktop/api/v1/projects
 *                              → 简化 workspaces 投影(路径列表 + 名字,保 wire 兼容老 phone)
 *  10  cmd.model.list          GET  /minimax-desktop/api/v1/models/list (BYOK-face
 *                              live: DesktopService.listModels → /mavis/api/models)
 *  11  cmd.projects.list       GET  /minimax-desktop/api/v1/projects
 *                              → 完整 typed ListProjectsResp(project + 内嵌 session tree),
 *                              对齐 weaver/idl MR !12566 + !12567 + archon_biz MR !138
 *                              + remote_gateway MR !4 的手机端 web 契约。与 workspace.list
 *                              并存:workspace.list 保 wire 兼容,projects.list 返 typed
 *                              完整结构给新版 phone client 消费。
 *  12  cmd.pinned.list         GET  /minimax-desktop/api/v1/preferences/pinned-items-order
 *                              → pin.thrift GetPinnedItemsOrderResp verbatim
 *                              (items:list<PinnedItem>,mirror desktop wire)。独立于 §1
 *                              sessionList 里 fetchPinnedSessionIds 的 pin-fact 合并逻辑
 *                              (那里只提取 session-typed id 集合;这里 verbatim 整批含
 *                              agent 混排 + hydrated payload)。上游 weaver/idl !12574
 *                              CommandType_PINNED_ITEMS_ORDER_GET=9 + archon_biz
 *                              RCGetPinnedItemsOrder + remote_gateway mapCommandType
 *                              9 → 'cmd.pinned.list'。
 *  13  cmd.pinned.reorder      PUT  /minimax-desktop/api/v1/preferences/pinned-items-order
 *                              → pin.thrift PutPinnedItemsOrderResp verbatim(items 携
 *                              hydrated payload);body items:list<PinnedItemRef>{item_type,id}
 *                              原样透传。上游 CommandType_PINNED_ITEMS_ORDER_PUT=10 →
 *                              'cmd.pinned.reorder';archon_biz RCPutPinnedItemsOrder。
 *
 * One-shot ack payload = the downstream web-shape response body verbatim
 * (§4 细则), EXCEPT the explicitly projected ones: send (disposition is
 * desktop-computed), workspace.list and model.list (§4-9/§4-10 projections),
 * and session.list / session.history — the plan §4-L155 verbatim rule for
 * those two contradicts the frozen IDL Ack*Payload shapes the rgw
 * translate.go parses (wire frozen, desktop follows): T6 real-device tests
 * showed rgw reading `{id,title,pinned,status,last_msg_at_ms,…}` /
 * `{messages_json,has_more,oldest_msg_id}` out of the web bodies → all-empty
 * sidebar rows and empty history. Both are projected to the IDL shapes here.
 *
 * Streaming cmds (send/resume) ack first, then hand the SSE Response to the
 * injected RcStreamPump (T3) — the router never reads stream bodies.
 *
 * cmd dedupe: 5-min LRU on cmd.id — a duplicate re-sends the cached ack/err
 * and never re-invokes downstream (protocol §5; prevents double send/create).
 * While the original is still in flight the duplicate is dropped (logged).
 *
 * Failures map to err.<domain>.<action> {code, message, retryable} with
 * in_reply_to = cmd.id; codes are UPPER_SNAKE domain codes aligned to the
 * downstream error bodies (`local_session_busy` → SESSION_BUSY, 503 →
 * DAEMON_UNAVAILABLE, …).
 */
import { ackTypeForCmd, errTypeForCmd, makeFrame } from './frame-codec.js';
/** V1 agent scoping (plan §4 defaultAgent): list/create fall to 'mavis'. */
export const DEFAULT_AGENT_NAME = 'mavis';
export const CMD_DEDUP_TTL_MS = 5 * 60 * 1000;
export const CMD_DEDUP_MAX_ENTRIES = 512;
/** Synthetic origin for in-process Requests — routing is pathname-only. */
const LOCAL_ORIGIN = 'http://rc-bridge.local';
const DESKTOP_API = '/minimax-desktop/api/v1';
const LEGACY_MAVIS_API = '/mavis/api';
const RC_REQUEST_SOURCE_HEADER = 'X-MCode-Request-Source';
const RC_REQUEST_SOURCE_VALUE = 'remote-control';
const RC_FILE_CONTENT_MAX_BYTES_HEADER = 'X-MCode-Remote-Control-File-Content-Max-Bytes';
const ROUTE_HEADER_ALLOWLIST = new Set([RC_FILE_CONTENT_MAX_BYTES_HEADER.toLowerCase()]);
export function createCommandRouter(deps) {
    const nowMs = deps.nowMs ?? Date.now;
    // cmd.id → cached reply frame (ack or err), 5min TTL LRU (Map keeps
    // insertion order; refreshed entries are re-inserted at the tail).
    const replyCache = new Map();
    const inFlight = new Set();
    function cacheReply(cmdId, frame) {
        replyCache.delete(cmdId);
        replyCache.set(cmdId, { frame, expiresAtMs: nowMs() + CMD_DEDUP_TTL_MS });
        while (replyCache.size > CMD_DEDUP_MAX_ENTRIES) {
            const oldest = replyCache.keys().next().value;
            if (oldest === undefined)
                break;
            replyCache.delete(oldest);
        }
    }
    function cachedReply(cmdId) {
        const entry = replyCache.get(cmdId);
        if (!entry)
            return undefined;
        if (entry.expiresAtMs <= nowMs()) {
            replyCache.delete(cmdId);
            return undefined;
        }
        return entry.frame;
    }
    return {
        async handleCommand(cmd, reply, context) {
            const startedAtMs = nowMs();
            const traceId = cmd.trace_id;
            const correlation = correlationForCmd(cmd);
            const caseIds = caseIdsForCommand(cmd);
            const caseBase = {
                case_ids: caseIds,
                cmd_type: cmd.type,
                rc_cmd_id: cmd.id,
                ...(traceId ? { trace_id: traceId } : {}),
                ...(correlation.rcOperationId ? { rc_operation_id: correlation.rcOperationId } : {}),
                ...(correlation.sessionId ? { session_id: correlation.sessionId } : {}),
                ...(correlation.requestId ? { request_id: correlation.requestId } : {}),
            };
            logRcCase(deps.logger, 'info', {
                ...caseBase,
                stage: 'command_received',
                outcome: 'started',
            });
            const cached = cachedReply(cmd.id);
            if (cached) {
                logRcCase(deps.logger, 'info', {
                    ...caseBase,
                    stage: 'command_deduplicated',
                    outcome: 'cached_reply',
                    elapsed_ms: Math.max(0, nowMs() - startedAtMs),
                });
                deps.logger.info(`[rc.router] duplicate cmd id=${cmd.id} → re-sending cached ${cached.type}`);
                reply(cached);
                return;
            }
            if (inFlight.has(cmd.id)) {
                logRcCase(deps.logger, 'warn', {
                    ...caseBase,
                    stage: 'command_deduplicated',
                    outcome: 'in_flight_drop',
                    elapsed_ms: Math.max(0, nowMs() - startedAtMs),
                });
                deps.logger.warn(`[rc.router] duplicate cmd id=${cmd.id} still in flight → dropped`);
                return;
            }
            inFlight.add(cmd.id);
            if (!traceId) {
                deps.logger.warn(`[rc.router] event=missing_trace_id trace_id= rc_cmd_id=${cmd.id} rc_operation_id=${correlation.rcOperationId ?? ''} session_id=${correlation.sessionId ?? ''} cmd_type=${cmd.type}`);
            }
            const replyOnce = (frame) => {
                cacheReply(cmd.id, frame);
                reply(frame);
            };
            try {
                const outcome = await dispatch(deps, cmd, context);
                const elapsedMs = Math.max(0, nowMs() - startedAtMs);
                if (outcome.kind === 'ack') {
                    const disposition = readString(outcome.payload.disposition);
                    logRcCase(deps.logger, 'info', {
                        ...caseBase,
                        stage: 'command_completed',
                        outcome: 'ack',
                        elapsed_ms: elapsedMs,
                        ...(disposition === 'sent' || disposition === 'queued' ? { disposition } : {}),
                    });
                }
                else {
                    const safeErrorCode = errorCodeForCaseLog(outcome.err.code);
                    logRcCase(deps.logger, 'warn', {
                        ...caseBase,
                        stage: 'command_completed',
                        outcome: 'error',
                        elapsed_ms: elapsedMs,
                        error_code: safeErrorCode,
                    });
                }
                const safeErrorCode = outcome.kind === 'err' ? errorCodeForCaseLog(outcome.err.code) : undefined;
                deps.logger.info(`[rc.router] event=${outcome.kind === 'ack' ? 'ack_out' : 'err_out'} trace_id=${traceId ?? ''} rc_cmd_id=${cmd.id} rc_operation_id=${correlation.rcOperationId ?? ''} session_id=${correlation.sessionId ?? ''} cmd_type=${cmd.type}${safeErrorCode ? ` error_code=${safeErrorCode}` : ''}`);
                if (outcome.kind === 'ack') {
                    replyOnce(makeFrame(ackTypeForCmd(cmd.type), outcome.payload, {
                        inReplyTo: cmd.id,
                        traceId,
                    }));
                    // Ack precedes the final stream (§6 rule 1). Each outcome carries
                    // one final response, so the pump starts once after the disposition.
                    if (outcome.stream) {
                        deps.pump.start({
                            sessionId: outcome.stream.sessionId,
                            cmdId: cmd.id,
                            cmdType: cmd.type,
                            response: outcome.stream.response,
                            traceId,
                            streamScope: context?.streamScope,
                        });
                    }
                }
                else {
                    replyOnce(makeFrame(errTypeForCmd(cmd.type), { ...outcome.err }, { inReplyTo: cmd.id, traceId }));
                }
            }
            catch (err) {
                const message = redactLogValue(err instanceof Error ? err.message : String(err));
                logRcCase(deps.logger, 'error', {
                    ...caseBase,
                    stage: 'command_completed',
                    outcome: 'error',
                    elapsed_ms: Math.max(0, nowMs() - startedAtMs),
                    error_code: 'INTERNAL_ERROR',
                });
                deps.logger.error(`[rc.router] event=err_out trace_id=${traceId ?? ''} rc_cmd_id=${cmd.id} rc_operation_id=${correlation.rcOperationId ?? ''} session_id=${correlation.sessionId ?? ''} cmd_type=${cmd.type} error_code=INTERNAL_ERROR error=${message}`);
                replyOnce(makeFrame(errTypeForCmd(cmd.type), { code: 'INTERNAL_ERROR', message, retryable: true }, { inReplyTo: cmd.id, traceId }));
            }
            finally {
                inFlight.delete(cmd.id);
            }
        },
    };
}
async function dispatch(deps, cmd, context) {
    const payload = cmd.payload ?? {};
    // Generic-channel bypass (dual-channel; additive). When the gateway stamps
    // a `route` on the envelope we run the generic executor ahead of the
    // 17-case switch — the existing arms are untouched when `route` is absent.
    if (cmd.route) {
        return genericExecute(deps, cmd);
    }
    switch (cmd.type) {
        case 'cmd.session.list':
            return sessionList(deps, cmd, payload);
        case 'cmd.session.history':
            return sessionHistory(deps, cmd, payload);
        case 'cmd.session.send':
            return sessionSend(deps, cmd, payload);
        case 'cmd.session.new':
            return sessionNew(deps, cmd, payload);
        case 'cmd.session.resume':
            return sessionResume(deps, cmd, payload);
        case 'cmd.session.stop':
            return sessionStop(deps, cmd, payload, context);
        case 'cmd.session.pin':
            return sessionPin(deps, cmd, payload);
        case 'cmd.permission.respond':
            return permissionRespond(deps, cmd, payload);
        case 'cmd.workspace.list':
            return workspaceList(deps, cmd, payload);
        case 'cmd.model.list':
            return modelList(deps, cmd, payload);
        case 'cmd.projects.list':
            return projectsList(deps, cmd, payload);
        case 'cmd.pinned.list':
            return pinnedList(deps, cmd, payload);
        case 'cmd.pinned.reorder':
            return pinnedReorder(deps, cmd, payload);
        case 'cmd.session.get':
            return sessionGet(deps, cmd, payload);
        case 'cmd.session.update':
            return sessionUpdate(deps, cmd, payload);
        case 'cmd.session.delete':
            return sessionDelete(deps, cmd, payload);
        case 'cmd.skill.list':
            return skillList(deps, cmd, payload);
        default:
            return {
                kind: 'err',
                err: {
                    code: 'UNSUPPORTED_COMMAND',
                    message: `unsupported command type: ${cmd.type}`,
                    retryable: false,
                },
            };
    }
}
// ─── 1. cmd.session.list (IDL AckSessionListPayload projection) ─────────
/** IDL remote_gateway_base SessionStatus: 1=IDLE 2=THINKING 3=RUNNING 4=AWAITING_PERMISSION. */
const IDL_SESSION_STATUS_IDLE = 1;
const IDL_SESSION_STATUS_RUNNING = 3;
async function sessionList(deps, cmd, payload) {
    const agent = readString(payload.agent) ?? DEFAULT_AGENT_NAME;
    const keyword = readString(payload.keyword) ?? readString(payload.search);
    const url = keyword
        ? withQuery(`${DESKTOP_API}/session/search`, {
            keyword,
            agent_name: agent,
            limit: payload.limit,
            cursor: payload.cursor,
        })
        : withQuery(`${DESKTOP_API}/agent/${encodeURIComponent(agent)}/session/tree`, {
            limit: payload.limit,
            cursor: payload.cursor,
        });
    // Pin facts live in PinService only (preference-backed ordered roster) —
    // the session tree/search wire structurally carries none (SessionInfoView
    // declares no pin fields), so the roster is read concurrently and merged
    // into the projection below. Roster failure degrades to "nothing pinned":
    // the list itself must never be blocked by pin state.
    const [response, pinnedSessionIds] = await Promise.all([
        invokeLocal(deps, cmd, new Request(url)),
        fetchPinnedSessionIds(deps),
    ]);
    if (!response.ok)
        return { kind: 'err', err: await toErrShape(response, 'session') };
    const body = await readJson(response);
    // rgw translate.go parses AckSessionListPayload per IDL — never the web
    // body (T6: verbatim web bodies came back as N all-empty SessionSummary
    // rows). Tree nodes and search hits share one element mapper below.
    const rawSessions = Array.isArray(body.sessions) ? body.sessions : [];
    const sessions = rawSessions.flatMap((entry) => toSessionSummary(entry, pinnedSessionIds));
    deps.logger.info(`[rc.router] ${cmd.type} id=${cmd.id} route=${routeForLog(url)} status=${response.status} raw_count=${rawSessions.length} filtered_count=${sessions.length} returned_count=${sessions.length}`);
    // IDL SessionSummary sort contract: pinned first, then last_msg_at_ms desc.
    sessions.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.last_msg_at_ms - a.last_msg_at_ms);
    // Tree route emits no pagination cursor today (raw /mavis/api tree is
    // unpaged); search does. Pass through whichever wire key shows up.
    const cursor = readString(body.next_cursor) ?? readString(body.nextCursor);
    return { kind: 'ack', payload: { sessions, ...(cursor ? { cursor } : {}) } };
}
/**
 * One tree node (`{session:{…}, child_sessions:[…]}`) or one flat search hit
 * (SessionInfoView wire shape) → IDL SessionSummary.
 *
 * - Only top-level nodes are projected — `child_sessions` are NOT descended
 *   into (V1 phone sidebar renders a flat list, no session tree).
 * - `visibility !== 'visible'` rows are filtered (missing field defaults to
 *   visible, mirroring toDaemonSession's `?? 'visible'`).
 * - pinned: pin facts live in PinService only — the desktop-service session
 *   wire carries none (SessionInfoView declares no pin fields, and the raw
 *   tree serializer never emits one; T6 confirmed absence), so pinned =
 *   membership in the concurrently-fetched pinned-items-order roster, OR-ed
 *   with the tolerant wire read (kept in case a future serializer starts
 *   emitting pin facts inline). pinned_at_ms is NOT synthesized from the
 *   roster (it is an ordered reference list without timestamps — rgw
 *   translate falls back to last_msg_at_ms for the web pinned_at); the
 *   tolerant wire read stays for forward-compat.
 * - status: local SessionStatusView (0=Idle 1=Started 2=Error 3=Abort;
 *   desktop-session-mappers SESSION_STATUS_VIEW) → IDL SessionStatus.
 *   Started is the only in-flight state → RUNNING(3); Idle/Error/Abort are
 *   all settled → IDLE(1). The session record level has no THINKING /
 *   AWAITING_PERMISSION distinction (permission waits ride evt.permission).
 * - last_msg_at_ms: tree/search responses carry no per-message timestamps —
 *   `updated_at` is the closest available proxy (bumps on session activity).
 */
function toSessionSummary(entry, pinnedIds) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry))
        return [];
    const node = entry;
    const nested = node.session;
    const session = (nested && typeof nested === 'object' && !Array.isArray(nested) ? nested : node);
    const id = readString(session.session_id) ?? readString(session.sessionId);
    if (!id)
        return [];
    const visibility = readString(session.visibility);
    if (visibility && visibility !== 'visible')
        return [];
    const status = session.status && typeof session.status === 'object' && !Array.isArray(session.status)
        ? session.status
        : {};
    const statusType = status.status_type ?? status.statusType;
    const pinnedAtMs = readNumber(session.pinned_at_ms) ??
        readNumber(session.pinnedAt) ??
        readNumber(session.pinned_at);
    const workspaceDir = readString(session.workspace_dir) ?? readString(session.workspaceDir);
    return [
        {
            id,
            title: readString(session.title) ?? '',
            pinned: pinnedIds.has(id) || session.pinned === true,
            ...(pinnedAtMs !== undefined ? { pinned_at_ms: pinnedAtMs } : {}),
            status: statusType === 1 ? IDL_SESSION_STATUS_RUNNING : IDL_SESSION_STATUS_IDLE,
            last_msg_at_ms: readNumber(session.updated_at) ?? readNumber(session.updatedAt) ?? 0,
            ...(workspaceDir ? { workspace_dir: workspaceDir } : {}),
        },
    ];
}
/** Generated desktop-service PinnedItemType enum: Session=1, Agent=2. */
const PINNED_ITEM_TYPE_SESSION = 1;
/**
 * Pinned-session roster for the session.list projection: GET the generated
 * GetPinnedItemsOrder route (LocalPinService's preference-backed ordered
 * reference list — the ONLY place pin facts live) and collect the ids of
 * Session-typed entries. Wire elements are `{item_type|itemType, id,
 * session?, agent?}` (generated encoder emits snake_case; camel tolerated
 * per this file's tolerant-read idiom); Agent entries (2) are ignored —
 * an agent id must never pin a same-named session row.
 *
 * Failure containment: any failure (non-2xx, invoke throw, malformed JSON)
 * degrades to an empty set with one warn — pin state is cosmetic next to
 * the list itself, so the roster read must never fail a session.list.
 */
async function fetchPinnedSessionIds(deps) {
    const ids = new Set();
    try {
        const response = await invokeLocal(deps, undefined, new Request(`${LOCAL_ORIGIN}${DESKTOP_API}/preferences/pinned-items-order`));
        if (!response.ok) {
            deps.logger.warn(`[rc.router] pinned-items-order returned HTTP ${response.status} — session.list degrades to unpinned`);
            return ids;
        }
        // response.json() (not readJson) on purpose: a malformed body should
        // land in the catch below and be logged, not silently read as {}.
        const parsed = (await response.json());
        const body = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
        for (const entry of Array.isArray(body.items) ? body.items : []) {
            if (!entry || typeof entry !== 'object' || Array.isArray(entry))
                continue;
            const item = entry;
            const itemType = item.item_type ?? item.itemType;
            if (itemType !== PINNED_ITEM_TYPE_SESSION && itemType !== 'session')
                continue;
            const id = readString(item.id);
            if (id)
                ids.add(id);
        }
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        deps.logger.warn(`[rc.router] pinned-items-order read failed (${message}) — session.list degrades to unpinned`);
    }
    return ids;
}
// ─── 2. cmd.session.history (IDL AckSessionHistoryPayload projection) ───
async function sessionHistory(deps, cmd, payload) {
    const sessionId = readString(payload.session_id);
    if (!sessionId)
        return missingField('session_id');
    const url = withQuery(`${DESKTOP_API}/session/${encodeURIComponent(sessionId)}/message`, {
        before: payload.before_msg_id,
        limit: payload.limit,
    });
    const response = await invokeLocal(deps, cmd, new Request(url));
    if (!response.ok)
        return { kind: 'err', err: await toErrShape(response, 'session') };
    const body = await readJson(response);
    const messages = Array.isArray(body.messages) ? body.messages : [];
    deps.logger.info(`[rc.router] ${cmd.type} id=${cmd.id} route=${routeForLog(url)} status=${response.status} count=${messages.length}`);
    // GetMessages pages come back ascending/chronological — the sqlite reader
    // (listDisplayMessageRows) selects newest-first then reverses, and sets
    // its own nextCursor to messages[0].msg_id. So the page's oldest row is
    // messages[0]; its msg_id is the IDL oldest_msg_id (next before_msg_id).
    const first = messages[0];
    const oldestMsgId = first && typeof first === 'object' && !Array.isArray(first)
        ? (readString(first.msg_id) ?? readString(first.msgId))
        : undefined;
    return {
        kind: 'ack',
        payload: {
            // AgentMessageProtocol[] passed through verbatim — rgw re-embeds
            // messages_json byte-for-byte into `messages`; individual message
            // objects are never reshaped here.
            messages_json: JSON.stringify(messages),
            has_more: readBoolean(body.has_more) ?? readBoolean(body.hasMore) ?? false,
            oldest_msg_id: oldestMsgId ?? '',
        },
    };
}
// ─── 3. cmd.session.send (SSE; disposition sent|queued) ────────────────
async function sessionSend(deps, cmd, payload) {
    const sessionId = readString(payload.session_id);
    if (!sessionId)
        return missingField('session_id');
    const content = readString(payload.content);
    if (content === undefined)
        return missingField('content');
    // The Desktop and legacy endpoints deliberately receive separately-built
    // bodies: their attachment contracts are not prefix-compatible.
    const desktopBody = { content, ...modelBody(payload.model) };
    const legacyBody = { content, ...modelBody(payload.model) };
    const clientIntent = readString(payload.client_intent);
    if (clientIntent === 'plan-entry' ||
        clientIntent === 'plan-exit' ||
        clientIntent === 'retry-continuation') {
        desktopBody.client_intent = clientIntent;
        legacyBody.client_intent = clientIntent;
    }
    if (Array.isArray(payload.attachments) && payload.attachments.length > 0) {
        if (!deps.attachments) {
            // No download leg wired (headless harness): silently dropping the files
            // would corrupt the user's message → err instead (form unsupported).
            return {
                kind: 'err',
                err: {
                    code: 'ATTACHMENT_UNSUPPORTED',
                    message: 'attachments are not supported by this desktop build',
                    retryable: false,
                },
            };
        }
        // §4-3 download leg: CDN URL → bytes on disk → Desktop AttachmentInput wire.
        // Any single failure fails the whole send (no partial sends).
        const fetched = await deps.attachments.fetchAll(payload.attachments);
        if (!fetched.ok)
            return { kind: 'err', err: fetched.failure };
        // Fetch exactly once: a Desktop 404 retry must reuse the downloaded files.
        desktopBody.attachments = fetched.attachments.map((file) => toDesktopAttachment(file));
        legacyBody.attachments = fetched.attachments.map(toLegacyAttachment);
    }
    const desktopMessagePath = `${DESKTOP_API}/session/${encodeURIComponent(sessionId)}/message`;
    const legacyMessagePath = `${LEGACY_MAVIS_API}/session/${encodeURIComponent(sessionId)}/message`;
    const send = await postDesktopThenLegacyOnNotFound(deps, cmd, postJson(desktopMessagePath, desktopBody), `${DESKTOP_API}/session/:id/message`, postJson(legacyMessagePath, legacyBody), `${LEGACY_MAVIS_API}/session/:id/message`);
    const sendResponse = send.response;
    if (sendResponse.ok) {
        deps.logger.info(`[rc.router] ${cmd.type} id=${cmd.id} route=${send.route} status=${sendResponse.status} disposition=sent`);
        // D-8: idle path — the final Desktop or legacy-fallback response accepted
        // the turn; SSE stream follows the ack.
        return {
            kind: 'ack',
            payload: { disposition: 'sent' },
            stream: { sessionId, response: sendResponse },
        };
    }
    const sendErr = await readErrorBody(sendResponse);
    if (sendResponse.status === 409 && isBusyCode(sendErr.rawCode)) {
        // D-8: busy path — enqueue instead (Desktop queue keeps turn ordering).
        const desktopQueuePath = `${DESKTOP_API}/session/${encodeURIComponent(sessionId)}/queue`;
        const legacyQueuePath = `${LEGACY_MAVIS_API}/session/${encodeURIComponent(sessionId)}/queue`;
        const queue = await postDesktopThenLegacyOnNotFound(deps, cmd, postJson(desktopQueuePath, desktopBody), `${DESKTOP_API}/session/:id/queue`, postJson(legacyQueuePath, legacyBody), `${LEGACY_MAVIS_API}/session/:id/queue`);
        const queueResponse = queue.response;
        if (queueResponse.ok) {
            deps.logger.info(`[rc.router] ${cmd.type} id=${cmd.id} route=${queue.route} status=${queueResponse.status} disposition=queued`);
            const queued = await readJson(queueResponse);
            const itemId = readString(queued.itemId) ?? readString(queued.item_id);
            return {
                kind: 'ack',
                payload: { disposition: 'queued', ...(itemId ? { item_id: itemId } : {}) },
            };
        }
        return { kind: 'err', err: await toErrShape(queueResponse, 'session') };
    }
    return { kind: 'err', err: errShapeFrom(sendResponse.status, sendErr, 'session') };
}
// ─── 4. cmd.session.new (create-only, AD-5 — no content leg) ────────────
async function sessionNew(deps, cmd, payload) {
    const agent = readString(payload.agent) ?? DEFAULT_AGENT_NAME;
    const workspace = readString(payload.workspace) ?? readString(payload.workspace_dir);
    const title = readString(payload.title);
    const parentSessionId = readString(payload.parent_session_id) ?? readString(payload.parentSessionId);
    const visibility = readString(payload.visibility);
    const purpose = readString(payload.purpose);
    const enableTeam = readBoolean(payload.enable_team);
    const teamModeOff = readBoolean(payload.team_mode_off);
    const projectId = readNumber(payload.project_id) ?? readNumber(payload.projectId);
    const runLocation = payload.run_location ?? payload.runLocation;
    const body = {
        // Generated-route wire names (CreateSessionReq).
        ...(workspace ? { workspace_dir: workspace } : {}),
        ...(parentSessionId ? { parent_session_id: parentSessionId } : {}),
        ...(title ? { title } : {}),
        ...(visibility ? { visibility } : {}),
        ...(purpose ? { purpose } : {}),
        ...(teamModeOff !== undefined
            ? { team_mode_off: teamModeOff }
            : enableTeam !== undefined
                ? { team_mode_off: !enableTeam }
                : {}),
        ...(projectId !== undefined ? { project_id: projectId } : {}),
        ...(runLocation && typeof runLocation === 'object' && !Array.isArray(runLocation)
            ? { run_location: runLocation }
            : {}),
        ...modelBody(payload.model),
    };
    return oneShot(deps, cmd, postJson(`${DESKTOP_API}/agent/${encodeURIComponent(agent)}/session`, body), 'session');
}
// ─── 5. cmd.session.resume (SSE, true resume) ───────────────────────────
async function sessionResume(deps, cmd, payload) {
    const sessionId = readString(payload.session_id);
    if (!sessionId)
        return missingField('session_id');
    const afterMsgId = readString(payload.after_msg_id);
    const afterCursor = readString(payload.after_cursor);
    const drainQueued = readBoolean(payload.drain_queued);
    const desktopBody = {
        ...(afterMsgId ? { after_msg_id: afterMsgId } : {}),
        ...(afterCursor ? { after_cursor: afterCursor } : {}),
        ...(drainQueued !== undefined ? { drain_queued: drainQueued } : {}),
    };
    // Legacy resume parses the original camelCase + snake_case aliases; keep
    // them separate from the generated Desktop wire, which is snake_case only.
    const legacyBody = {
        ...(afterMsgId ? { afterMsgId, after_msg_id: afterMsgId, after_message_id: afterMsgId } : {}),
        ...(afterCursor ? { afterCursor, after_cursor: afterCursor } : {}),
        ...(drainQueued !== undefined ? { drainQueued, drain_queued: drainQueued } : {}),
    };
    const resume = await postDesktopThenLegacyOnNotFound(deps, cmd, postJson(`${DESKTOP_API}/session/${encodeURIComponent(sessionId)}/resume`, desktopBody), `${DESKTOP_API}/session/:id/resume`, postJson(`${LEGACY_MAVIS_API}/session/${encodeURIComponent(sessionId)}/resume`, legacyBody), `${LEGACY_MAVIS_API}/session/:id/resume`);
    const response = resume.response;
    if (!response.ok)
        return { kind: 'err', err: await toErrShape(response, 'session') };
    deps.logger.info(`[rc.router] ${cmd.type} id=${cmd.id} route=${resume.route} status=${response.status}`);
    return { kind: 'ack', payload: {}, stream: { sessionId, response } };
}
// ─── 6. cmd.session.stop ────────────────────────────────────────────────
async function sessionStop(deps, cmd, payload, context) {
    const sessionId = readString(payload.session_id);
    if (!sessionId)
        return missingField('session_id');
    // Abort cascade (§6 rule 3): end our pump for this session first so the
    // phone gets a deterministic turn_end{ABORTED}, then stop the daemon turn.
    if (context?.streamScope) {
        deps.pump.abortSession(sessionId, 'cmd.session.stop', context.streamScope);
    }
    else {
        deps.pump.abortSession(sessionId, 'cmd.session.stop');
    }
    const turnId = readString(payload.turn_id);
    return oneShot(deps, cmd, postJson(`${DESKTOP_API}/session/${encodeURIComponent(sessionId)}/abort`, {
        ...(turnId ? { turn_id: turnId } : {}),
        // Explicit stop source. Without it the daemon defaults to `unknown`, which
        // neither pauses the Thread Goal nor cascades into background work, so a
        // phone stop would behave differently from the desktop Stop button.
        reason: 'user_stop',
    }), 'session');
}
// ─── 7. cmd.session.pin ─────────────────────────────────────────────────
async function sessionPin(deps, cmd, payload) {
    const sessionId = readString(payload.session_id);
    if (!sessionId)
        return missingField('session_id');
    if (typeof payload.pinned !== 'boolean')
        return missingField('pinned');
    return oneShot(deps, cmd, postJson(`${DESKTOP_API}/pin/session`, { session_id: sessionId, pinned: payload.pinned }), 'session');
}
// ─── 8. cmd.permission.respond ──────────────────────────────────────────
async function permissionRespond(deps, cmd, payload) {
    const groups = normalizePermissionResponses(payload);
    if (groups === undefined) {
        return {
            kind: 'err',
            err: {
                code: 'INVALID_ARGUMENT',
                message: 'permission.respond requires request_ids (or responses[]) and a decision',
                retryable: false,
            },
        };
    }
    // batch-reply takes one decision per call — group ids by decision and merge.
    const processed = [];
    const skipped = [];
    for (const [decision, requestIds] of groups) {
        const desktopDecision = toDesktopBatchPermissionDecision(decision);
        if (desktopDecision === undefined) {
            return {
                kind: 'err',
                err: {
                    code: 'INVALID_ARGUMENT',
                    message: 'unsupported permission decision',
                    retryable: false,
                },
            };
        }
        const response = await invokeLocal(deps, cmd, postJson(`${DESKTOP_API}/permission/batch-reply`, {
            request_ids: requestIds,
            decision: desktopDecision,
        }));
        if (!response.ok)
            return { kind: 'err', err: await toErrShape(response, 'permission') };
        const body = await readJson(response);
        if (Array.isArray(body.processed))
            processed.push(...body.processed);
        if (Array.isArray(body.skipped))
            skipped.push(...body.skipped);
        deps.logger.info(`[rc.router] ${cmd.type} id=${cmd.id} route=/minimax-desktop/api/v1/permission/batch-reply status=${response.status} decision=${desktopDecision} processed_count=${Array.isArray(body.processed) ? body.processed.length : 0} skipped_count=${Array.isArray(body.skipped) ? body.skipped.length : 0}`);
    }
    // Downstream web shape: processed/skipped are request-id ARRAYS (IDL
    // AckPermissionRespondPayload declares i32 counts — reported as drift;
    // ack keeps the web body shape per §4 verbatim rule).
    return { kind: 'ack', payload: { processed, skipped } };
}
/**
 * Accepts both the IDL CmdPermissionRespondPayload shape
 * `{request_ids[], decision(1=ALLOW|2=DENY), remember?(1=ALWAYS|2=SESSION|3=ONCE)}`
 * and the plan §4-8 web shape `{responses:[{permission_id|request_id, decision, remember?}]}`.
 * Returns decision(local string) → request id list, or undefined if unusable.
 */
export function normalizePermissionResponses(payload) {
    const groups = new Map();
    const push = (id, decision) => {
        if (!id || !decision)
            return;
        const list = groups.get(decision) ?? [];
        list.push(id);
        groups.set(decision, list);
    };
    if (Array.isArray(payload.responses)) {
        for (const entry of payload.responses) {
            if (!entry || typeof entry !== 'object')
                continue;
            const item = entry;
            const id = readString(item.permission_id) ?? readString(item.request_id);
            push(id, mapPermissionDecision(item.decision, item.remember));
        }
    }
    else if (Array.isArray(payload.request_ids)) {
        const decision = mapPermissionDecision(payload.decision, payload.remember);
        for (const id of payload.request_ids)
            push(readString(id), decision);
    }
    return groups.size > 0 ? groups : undefined;
}
/**
 * IDL PermissionDecision/PermissionRemember → canonical local decision.
 * `allow` / `allow-always` aliases remain accepted for phone compatibility;
 * the Desktop batch route converts them to its numeric enum below.
 * remember=SESSION(2) has no desktop-side equivalent → allowOnce.
 */
export function mapPermissionDecision(decision, remember) {
    if (typeof decision === 'string') {
        switch (decision) {
            case 'allow':
            case 'allow-for-agent':
            case 'allowForAgent':
            case 'allowOnce':
                return 'allowOnce';
            case 'allow-always':
            case 'allowAlways':
                return 'allowAlways';
            case 'deny':
                return 'deny';
            default:
                return undefined;
        }
    }
    if (decision === 1)
        return remember === 1 ? 'allowAlways' : 'allowOnce';
    if (decision === 2)
        return 'deny';
    return undefined;
}
// ─── 9. cmd.workspace.list (§4-9 projection) ────────────────────────────
async function workspaceList(deps, cmd, payload) {
    const response = await invokeLocal(deps, cmd, new Request(withQuery(`${DESKTOP_API}/projects`, { limit: payload.limit })));
    if (!response.ok)
        return { kind: 'err', err: await toErrShape(response, 'workspace') };
    const body = await readJson(response);
    // §4-9: listProjects returns nested `{project, sessions, ...}` groups (sessions-
    // aggregated workspace list). We unwrap `.project` per group and keep the same
    // archived / missing-path filtering + snake_case fallback semantics as before.
    const groups = Array.isArray(body.projects) ? body.projects : [];
    let filteredCount = 0;
    const workspaces = groups.flatMap((group) => {
        if (!group || typeof group !== 'object')
            return [];
        const project = group.project;
        if (!project || typeof project !== 'object')
            return [];
        const p = project;
        if (p.archived === true)
            return [];
        const path = readString(p.workspaceDir) ?? readString(p.workspace_dir);
        if (!path)
            return [];
        filteredCount += 1;
        const name = readString(p.displayName) ?? readString(p.display_name);
        const lastUsedMs = readNumber(p.latestActivityAt) ?? readNumber(p.latest_activity_at);
        return [
            {
                path,
                name: name ?? path,
                ...(lastUsedMs !== undefined ? { last_used_ms: lastUsedMs } : {}),
            },
        ];
    });
    deps.logger.info(`[rc.router] ${cmd.type} id=${cmd.id} route=/minimax-desktop/api/v1/projects status=${response.status} raw_count=${groups.length} filtered_count=${filteredCount} returned_count=${workspaces.length}`);
    return { kind: 'ack', payload: { workspaces } };
}
// ─── 10. cmd.model.list (§9; BYOK-face model_provider.ListModels route) ───
async function modelList(deps, cmd, payload) {
    const response = await invokeLocal(deps, cmd, new Request(withQuery(`${DESKTOP_API}/models/list`, { session_id: payload.session_id })));
    if (!response.ok)
        return { kind: 'err', err: await toErrShape(response, 'model') };
    const body = await readJson(response);
    const models = Array.isArray(body.models) ? body.models : [];
    deps.logger.info(`[rc.router] ${cmd.type} id=${cmd.id} route=/minimax-desktop/api/v1/models/list status=${response.status} returned_count=${models.length}`);
    return { kind: 'ack', payload: { ...body, models } };
}
// ─── 11. cmd.projects.list (§4-11: 完整 project + session-tree typed 返回) ──
//
// 与 §4-9 cmd.workspace.list 共用底层 daemon 端点 GET /minimax-desktop/api/v1/projects
// (LocalProjectService.listProjects,已在 dev/preview_train 就绪),但**不做投影**:
// 直接把 daemon 返回的 project.ListProjectsResp(matrix/api_common/project.thrift,
// web / desktop / RC 三端共用契约)verbatim 塞进 ack.projects.list.payload。
//
// 上游链路(全部已合入 main / MR review 中):
//   phone GET /minimax-cloud/api/v1/remote-control/projects (archon_biz MR !138)
//   → RemoteCommand(CommandType_PROJECT_LIST=8, payload={query JSON}, weaver/idl !12566/!12567)
//   → remote_gateway.mapCommandType 8 → 'cmd.projects.list' (MR !4)
//   → 本函数 → daemon /minimax-desktop/api/v1/projects
//   → ack.projects.list { ListProjectsResp verbatim } → gateway translate default 透传
//   → archon_biz writeAckJSON → HTTP body
//
// Query 字段(严格对齐 ListProjectsReq api.query 名):
//   agent_name / limit / cursor / session_limit /
//   exclude_purpose_prefix / include_purpose_prefix /
//   include_hidden / include_archived
// —— withQuery 已经把 undefined / null / 空串 / 非 primitive 全部 omit,
//   readNumber 已经 Number.isFinite 挡 NaN/Infinity,复用即可。
async function projectsList(deps, cmd, payload) {
    const response = await invokeLocal(deps, cmd, new Request(withQuery(`${DESKTOP_API}/projects`, {
        agent_name: readString(payload.agent_name),
        limit: readNumber(payload.limit),
        cursor: readString(payload.cursor),
        session_limit: readNumber(payload.session_limit),
        exclude_purpose_prefix: readString(payload.exclude_purpose_prefix),
        include_purpose_prefix: readString(payload.include_purpose_prefix),
        include_hidden: readBoolean(payload.include_hidden),
        include_archived: readBoolean(payload.include_archived),
    })));
    if (!response.ok)
        return { kind: 'err', err: await toErrShape(response, 'projects') };
    const body = await readJson(response);
    const projects = Array.isArray(body.projects) ? body.projects : [];
    deps.logger.info(`[rc.router] ${cmd.type} id=${cmd.id} route=/minimax-desktop/api/v1/projects status=${response.status} raw_count=${projects.length} filtered_count=${projects.length} returned_count=${projects.length}`);
    // Verbatim body:daemon 端 handler override listProjects 已经返回合法
    // ListProjectsResp JSON,直接透传给手机(不投影、不裁剪、不重命名)。
    return { kind: 'ack', payload: body };
}
// ─── 12. cmd.pinned.list ────────────────────────────────────────────────
//
// GET /minimax-desktop/api/v1/preferences/pinned-items-order
// → pin.thrift GetPinnedItemsOrderResp verbatim(items:list<PinnedItem>,
//    每项含 item_type/id + optional AgentDetail / SessionInfoView payload)。
//
// 与 §1 sessionList 里 fetchPinnedSessionIds 是**不同用途**的两个读:
//   - fetchPinnedSessionIds:session.list 内部并发拉 pin roster,只挑
//     session-typed id 组 Set 做布尔合并到 SessionSummary.pinned;
//   - pinnedList (§12):独立 typed 端点,verbatim 整批含 agent 混排 +
//     hydrated payload 给手机端 RC 消费(cold render 直接吃)。
// 两者共用同一 daemon 路由 /preferences/pinned-items-order,但 §1 私有的
// 那次读 **不复用**这里的路径常量(§1 有自己的字面量,写死在 session
// list 那段的局部),避免耦合。
//
// 上游 wire 链路(平行 3 个 MR,尚未合入):
//   phone GET /minimax-cloud/api/v1/remote-control/preferences/pinned-items-order
//   → RemoteCommand(CommandType_PINNED_ITEMS_ORDER_GET=9,
//                   weaver/idl !12574)
//   → remote_gateway.mapCommandType 9 → 'cmd.pinned.list' (worker D)
//   → 本函数 → daemon GET /minimax-desktop/api/v1/preferences/pinned-items-order
//   → ack.pinned.list { GetPinnedItemsOrderResp verbatim } → gateway 透传
//   → archon_biz RCGetPinnedItemsOrder writeAckJSON → HTTP body。
async function pinnedList(deps, cmd, _payload) {
    return oneShot(deps, cmd, new Request(`${LOCAL_ORIGIN}${DESKTOP_API}/preferences/pinned-items-order`), 'pinned');
}
// ─── 13. cmd.pinned.reorder ─────────────────────────────────────────────
//
// PUT /minimax-desktop/api/v1/preferences/pinned-items-order
// body items:list<PinnedItemRef>{item_type,id} 原样透传;
// → pin.thrift PutPinnedItemsOrderResp verbatim(items 携 hydrated payload,
//    daemon 侧 PinService 落盘后回读拿全量渲染信息回传)。
//
// 空/缺 payload 透传 {} 给 daemon,由 daemon 决定是否报 400
// (与 §4 sessionNew 空 body 透传的写法一致 —— router 不做协议前校验,
// 保 daemon 是错误源头单一权威)。
//
// 上游:CommandType_PINNED_ITEMS_ORDER_PUT=10 → 'cmd.pinned.reorder';
// archon_biz RCPutPinnedItemsOrder。
async function pinnedReorder(deps, cmd, payload) {
    return oneShot(deps, cmd, putJson(`${DESKTOP_API}/preferences/pinned-items-order`, payload), 'pinned');
}
// ─── 14. cmd.session.get ────────────────────────────────────────────────
//
// GET /minimax-desktop/api/v1/session/:id
// → GetSessionResp verbatim(payload 原样透传给手机端 RC,与 §12 pinnedList
//    同款 verbatim ack,不做投影)。
//
// 上游 wire 链路(平行 MR,尚未合入):
//   phone GET /minimax-cloud/api/v1/remote-control/session/:id
//   → RemoteCommand(CommandType_SESSION_GET=11)
//   → remote_gateway.mapCommandType 11 → 'cmd.session.get'
//   → 本函数 → daemon GET /minimax-desktop/api/v1/session/:id
//   → ack.session.get { GetSessionResp verbatim } → gateway 透传
//   → archon_biz RCGetSession writeAckJSON → HTTP body。
async function sessionGet(deps, cmd, payload) {
    const id = readString(payload.id);
    if (!id)
        return missingField('id');
    return oneShot(deps, cmd, new Request(`${LOCAL_ORIGIN}${DESKTOP_API}/session/${encodeURIComponent(id)}`), 'session');
}
// ─── 15. cmd.session.update ─────────────────────────────────────────────
//
// PATCH /minimax-desktop/api/v1/session/:id
// title 仍走 Desktop Session PATCH；interaction_mode 仅作为临时 composer
// intent 投递给 renderer，不得写 Session.interactionMode。
// (避免向 daemon PATCH 语义里塞 {title: null|undefined},保持 "字段未提供 =
// 不改" 的 CRUD 契约)。
// title-only → UpdateSessionResp verbatim；composer-only → 临时意图 ack。
//
// 上游 CommandType_SESSION_UPDATE=12 → 'cmd.session.update';
// archon_biz RCUpdateSession。
async function sessionUpdate(deps, cmd, payload) {
    const id = readString(payload.id);
    if (!id)
        return missingField('id');
    const rawInteractionMode = payload.interaction_mode ?? payload.interactionMode;
    const interactionMode = readNumber(rawInteractionMode);
    const composerMode = interactionMode === 0
        ? 'default'
        : interactionMode === 1
            ? 'plan'
            : interactionMode === 2
                ? 'goal'
                : undefined;
    if (rawInteractionMode !== undefined && composerMode === undefined) {
        return missingField('interaction_mode');
    }
    const deliverComposerMode = deps.onSessionComposerModeChange;
    if (composerMode && !deliverComposerMode) {
        return {
            kind: 'err',
            err: {
                code: 'COMPOSER_SYNC_UNAVAILABLE',
                message: 'Desktop composer sync is unavailable',
                retryable: true,
            },
        };
    }
    let responsePayload = {};
    if (typeof payload.title === 'string') {
        const response = await invokeLocal(deps, cmd, patchJson(`${DESKTOP_API}/session/${encodeURIComponent(id)}`, { title: payload.title }));
        if (!response.ok)
            return { kind: 'err', err: await toErrShape(response, 'session') };
        responsePayload = await readJson(response);
    }
    if (composerMode && deliverComposerMode) {
        await deliverComposerMode({ sessionId: id, mode: composerMode });
        responsePayload = {
            ...responsePayload,
            updated: true,
            session_id: id,
            interaction_mode: interactionMode,
        };
    }
    return { kind: 'ack', payload: responsePayload };
}
// ─── 16. cmd.session.delete ─────────────────────────────────────────────
//
// DELETE /minimax-desktop/api/v1/session/:id (无 body)
// → DeleteSessionResp verbatim ({success})(§12 pinnedList 同款 verbatim ack)。
//
// 上游 CommandType_SESSION_DELETE=13 → 'cmd.session.delete';
// archon_biz RCDeleteSession。
async function sessionDelete(deps, cmd, payload) {
    const id = readString(payload.id);
    if (!id)
        return missingField('id');
    return oneShot(deps, cmd, new Request(`${LOCAL_ORIGIN}${DESKTOP_API}/session/${encodeURIComponent(id)}`, {
        method: 'DELETE',
    }), 'session');
}
// ─── 17. cmd.skill.list ─────────────────────────────────────────────────
//
// GET /minimax-desktop/api/v1/skills[?<query>]
// → ListSkillsResp verbatim(§12 pinnedList 同款 verbatim ack)。
//
// payload.query 是 archon_biz 透传的原始 URL query string(不含前导 '?');
// router 不做协议前 reshape/校验(与 §13 pinnedReorder 空 payload 透传给
// daemon 同款原则,保 daemon 是错误源头单一权威)。缺/空则 GET 无 query。
//
// 上游 CommandType_SKILL_LIST=14 → 'cmd.skill.list';
// archon_biz RCListSkills。
async function skillList(deps, cmd, payload) {
    const query = readString(payload.query);
    const path = query ? `${DESKTOP_API}/skills?${query}` : `${DESKTOP_API}/skills`;
    return oneShot(deps, cmd, new Request(`${LOCAL_ORIGIN}${path}`), 'skill');
}
// ─── generic-channel executor (dual-channel; additive) ──────────────────
//
// Activated by `cmd.route` (see types.ts `WsRoute`). The gateway may stamp a
// concrete daemon-relative path on the envelope to drive any HTTP call
// through the same `invokeLocal` plumbing the switch-driven commands use —
// without forcing every new route to be added to the dispatch table. The
// gateway's RGW Apollo config is the authoritative allowlist (by full absolute
// path prefix, ops-controlled, hot-reload); the desktop only enforces
// structural path-traversal guards (no target-based compiled-in allowlist).
//
// The generic executor preserves a stable daemon JSON error code when one is
// present. It does not run `toErrShape` domain classification, since the
// existing status-table only knows the 17 hard-coded command domains. Plain
// text and unstructured errors fall back to `DAEMON_HTTP_${status}`.
/**
 * Bedrock-safety check (v8): rejects paths that escape origin (`..`, absolute
 * URL, protocol-relative). There is NO compiled-in route allowlist — RGW
 * Apollo (ops-controlled, hot-reload) is the sole authoritative route gate,
 * matching against `route.path` (a complete absolute path including the API
 * prefix). Only structural path-traversal guards apply here.
 */
export function allowedPath(route) {
    const { path } = route;
    if (typeof path !== 'string' || path.length === 0)
        return false;
    if (!path.startsWith('/') || path.startsWith('//'))
        return false;
    if (path.includes('..'))
        return false;
    // Compose against LOCAL_ORIGIN so URL resolution can't smuggle a different
    // origin (guards against schemes / authority in `path`).
    let url;
    try {
        url = new URL(path, LOCAL_ORIGIN);
    }
    catch {
        return false;
    }
    if (url.origin !== LOCAL_ORIGIN)
        return false;
    if (url.pathname !== path.split('?')[0])
        return false;
    return true;
}
/** Build a Request honoring the method (with-or-without JSON body rule). */
function buildRequest(method, url, payload, routeHeaders, remoteControlFileContentMaxBytes) {
    const upper = method.toUpperCase();
    const headers = routeHeadersForLocalRuntime(routeHeaders, remoteControlFileContentMaxBytes);
    if (upper === 'POST' || upper === 'PUT' || upper === 'PATCH') {
        headers.set('Content-Type', 'application/json');
        return new Request(url, {
            method: upper,
            headers,
            body: JSON.stringify(payload ?? {}),
        });
    }
    return new Request(url, { method: upper, headers });
}
function routeHeadersForLocalRuntime(routeHeaders, remoteControlFileContentMaxBytes) {
    const headers = new Headers();
    headers.set(RC_REQUEST_SOURCE_HEADER, RC_REQUEST_SOURCE_VALUE);
    for (const [key, value] of Object.entries(routeHeaders ?? {})) {
        if (!ROUTE_HEADER_ALLOWLIST.has(key.toLowerCase()))
            continue;
        headers.set(key, String(value));
    }
    if (isPositiveSafeInteger(remoteControlFileContentMaxBytes)) {
        headers.set(RC_FILE_CONTENT_MAX_BYTES_HEADER, String(remoteControlFileContentMaxBytes));
    }
    return headers;
}
function isPositiveSafeInteger(value) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
/** Daemon error → stable code plus a non-sensitive generic message. */
async function toGenericRouteErr(response) {
    const errorBody = await readErrorBody(response);
    return {
        code: errorBody.rawCode ?? `DAEMON_HTTP_${response.status}`,
        message: `local runtime returned HTTP ${response.status}`,
        retryable: false,
    };
}
/**
 * Route → dispatch entrypoint. Handles both `http` (one-shot verbatim ack)
 * and `http_stream` (ack {} then pump). Mirrors `sessionResume`'s stream
 * pump wiring verbatim so the existing handler will pick up the SSE.
 */
async function genericExecute(deps, cmd) {
    // Dispatch() guarantees cmd.route is set; the `!` narrows it for read.
    const route = cmd.route;
    if (!allowedPath(route)) {
        deps.logger.warn(`[rc.router] event=route_blocked rc_cmd_id=${cmd.id} method=${route.method} path=${route.path}`);
        return {
            kind: 'err',
            err: {
                code: 'ROUTE_NOT_ALLOWED',
                message: `path blocked by desktop bedrock traversal guard: ${route.method} ${route.path}`,
                retryable: false,
            },
        };
    }
    // Stream kind requires a sessionId for pump bookkeeping — short-circuit
    // before invoke so a missing-session_id call cannot touch the daemon.
    let sessionId;
    if (route.kind === 'http_stream') {
        sessionId = correlationForCmd(cmd).sessionId;
        if (!sessionId) {
            return {
                kind: 'err',
                err: {
                    code: 'INVALID_ARGUMENT',
                    message: 'route http_stream requires payload.session_id',
                    retryable: false,
                },
            };
        }
    }
    let materializedPayload = await materializeGenericAttachments(deps, route.method, cmd.payload ?? {});
    if (!materializedPayload.ok)
        return { kind: 'err', err: materializedPayload.err };
    if (/\/goal$/.test(route.path)) {
        materializedPayload = await materializeGenericAttachments(deps, route.method, materializedPayload.payload, 'objective_resources');
        if (!materializedPayload.ok)
            return { kind: 'err', err: materializedPayload.err };
    }
    const url = `${LOCAL_ORIGIN}${route.path}`;
    const request = buildRequest(route.method, url, materializedPayload.payload, route.headers, deps.getRemoteControlFileContentMaxBytes?.());
    const response = await invokeLocal(deps, cmd, request);
    if (route.kind === 'http_stream') {
        if (!response.ok)
            return { kind: 'err', err: await toGenericRouteErr(response) };
        return {
            kind: 'ack',
            payload: {},
            stream: { sessionId: sessionId, response },
        };
    }
    // `http` one-shot.
    if (!response.ok)
        return { kind: 'err', err: await toGenericRouteErr(response) };
    return { kind: 'ack', payload: await readJson(response) };
}
async function materializeGenericAttachments(deps, method, payload, field = 'attachments') {
    if (!['POST', 'PUT', 'PATCH'].includes(method.toUpperCase()))
        return { ok: true, payload };
    const entries = payload[field];
    if (!Array.isArray(entries) || entries.length === 0)
        return { ok: true, payload };
    const result = [...entries];
    const downloads = [];
    entries.forEach((entry, index) => {
        const local = isPayload(entry) && isPayload(entry.local) ? entry.local : {};
        const meta = isPayload(entry) && isPayload(entry.meta) ? entry.meta : {};
        const assetId = readString(local.asset_id);
        const dataUrl = readString(local.data_url);
        if (field === 'objective_resources' && assetId) {
            // The Goal owner resolves this opaque id in the target session. Never
            // forward a remote-provided host path, including for a reused resource.
            result[index] = { meta, local: { asset_id: assetId, file_path: 'goal-resource' } };
        }
        else if (field === 'objective_resources' && dataUrl?.startsWith('data:')) {
            result[index] = { meta, local: { data_url: dataUrl } };
        }
        else
            downloads.push({ entry, index });
    });
    if (downloads.length) {
        if (!deps.attachments)
            return {
                ok: false,
                err: {
                    code: 'ATTACHMENT_UNSUPPORTED',
                    message: 'attachments are not supported by this desktop build',
                    retryable: false,
                },
            };
        // New cloud resources use the existing bounded HTTPS downloader. The
        // runtime then persists the bytes before committing the Goal revision.
        const fetchInputs = downloads.map(({ entry }) => {
            if (!isPayload(entry))
                return entry;
            const cloud = isPayload(entry.cloud) ? entry.cloud : {};
            const meta = isPayload(entry.meta) ? entry.meta : {};
            return {
                url: readString(cloud.url) ?? readString(cloud.data_url),
                filename: readString(meta.file_name) ?? readString(meta.fileName),
                mime_type: readString(meta.mime_type) ?? readString(meta.mimeType),
            };
        });
        const fetched = await deps.attachments.fetchAll(fetchInputs);
        if (!fetched.ok)
            return { ok: false, err: fetched.failure };
        if (fetched.attachments.length !== downloads.length)
            return {
                ok: false,
                err: {
                    code: 'ATTACHMENT_FETCH_FAILED',
                    message: 'attachment downloader returned an incomplete batch',
                    retryable: true,
                },
            };
        fetched.attachments.forEach((file, downloadIndex) => {
            const download = downloads[downloadIndex];
            if (!download)
                return;
            const { entry, index } = download;
            result[index] = toDesktopAttachment(file, isPayload(entry) && isPayload(entry.meta) ? entry.meta : undefined);
        });
    }
    return { ok: true, payload: { ...payload, [field]: result } };
}
// ─── shared plumbing ────────────────────────────────────────────────────
/** Invoke + verbatim-body ack (the §4 one-shot rule). */
async function oneShot(deps, cmd, request, domain) {
    const response = await invokeLocal(deps, cmd, request);
    if (!response.ok)
        return { kind: 'err', err: await toErrShape(response, domain) };
    return { kind: 'ack', payload: await readJson(response) };
}
/**
 * Fixed RC session POST operations are Desktop-first. Only
 * `response.status === 404` retries its matching legacy Mavis endpoint; all
 * other outcomes retain
 * their original status/error semantics.
 */
async function postDesktopThenLegacyOnNotFound(deps, cmd, desktopRequest, desktopRoute, legacyRequest, legacyRoute) {
    const desktopResponse = await invokeLocal(deps, cmd, desktopRequest);
    if (desktopResponse.status !== 404) {
        return { response: desktopResponse, route: desktopRoute };
    }
    deps.logger.warn(`[rc.router] event=desktop_404_fallback cmd_type=${cmd.type} id=${cmd.id} route=${desktopRoute} status=404 fallback_route=${legacyRoute}`);
    // invokeLocal inspected a clone for logging; cancel the original 404 body
    // before replacing it with the legacy response.
    if (desktopResponse.body) {
        await desktopResponse.body.cancel().catch(() => undefined);
    }
    const legacyResponse = await invokeLocal(deps, cmd, legacyRequest);
    deps.logger.info(`[rc.router] event=legacy_fallback_result cmd_type=${cmd.type} id=${cmd.id} route=${legacyRoute} status=${legacyResponse.status}`);
    return { response: legacyResponse, route: legacyRoute };
}
async function invokeLocal(deps, cmd, request) {
    const startedAt = Date.now();
    const url = new URL(request.url);
    const correlation = correlationForCmd(cmd);
    const baseFields = `trace_id=${cmd?.trace_id ?? ''} rc_cmd_id=${cmd?.id ?? ''} rc_operation_id=${correlation.rcOperationId ?? ''} session_id=${correlation.sessionId ?? ''} ` +
        `method=${request.method} path=${url.pathname}`;
    deps.logger.info(`[rc.router] event=local_api_start ${baseFields}`);
    try {
        const response = await deps.invoke(withRemoteControlSourceHeader(request));
        const durationMs = Date.now() - startedAt;
        const errorBody = response.ok ? undefined : await readErrorBody(response.clone());
        const errorCode = response.ok
            ? 'none'
            : errorCodeForCaseLog(errorBody?.rawCode ?? `HTTP_${response.status}`);
        deps.logger.info(`[rc.router] event=local_api_end ${baseFields} status=${response.status} duration_ms=${durationMs} error_code=${errorCode}${errorBody ? ` error_body=${formatErrorBodyForLog(errorBody)}` : ''}`);
        return response;
    }
    catch (err) {
        const durationMs = Date.now() - startedAt;
        deps.logger.warn(`[rc.router] event=local_api_end ${baseFields} status=throw duration_ms=${durationMs} error_code=${err instanceof Error ? err.name : 'UNKNOWN_ERROR'} error=${redactLogValue(err instanceof Error ? err.stack || err.message : String(err))}`);
        throw err;
    }
}
function withRemoteControlSourceHeader(request) {
    const headers = new Headers(request.headers);
    if (!headers.has(RC_REQUEST_SOURCE_HEADER)) {
        headers.set(RC_REQUEST_SOURCE_HEADER, RC_REQUEST_SOURCE_VALUE);
    }
    return new Request(request, { headers });
}
function correlationForCmd(cmd) {
    const payload = cmd?.payload ?? {};
    return {
        rcOperationId: readString(payload.rc_operation_id) ?? readString(payload.rcOperationId),
        sessionId: readString(payload.session_id) ?? readString(payload.sessionId),
        requestId: readString(payload.request_id) ?? readString(payload.requestId),
    };
}
function caseIdsForCommand(cmd) {
    if (cmd.route)
        return caseIdsForGenericRoute(cmd.route, cmd.payload ?? {});
    return caseIdsForCommandType(cmd.type);
}
function caseIdsForCommandType(cmdType) {
    switch (cmdType) {
        case 'cmd.session.list':
            return ['A1', 'A2', 'B1', 'B4', 'B9'];
        case 'cmd.session.history':
            return ['A1', 'A2', 'B4', 'B9'];
        case 'cmd.session.send':
            return ['A1', 'A2', 'A3', 'B9', 'B10'];
        case 'cmd.session.new':
            return ['A1', 'A2', 'B9'];
        case 'cmd.session.resume':
            return ['A2', 'B9', 'B10'];
        case 'cmd.session.stop':
            return ['B9', 'B10'];
        case 'cmd.permission.respond':
            return ['A1', 'B3', 'B4'];
        case 'cmd.model.list':
            return ['B8', 'B11'];
        case 'cmd.skill.list':
            return ['B6'];
        case 'cmd.workspace.list':
        case 'cmd.projects.list':
            return ['A1', 'B9'];
        case 'cmd.session.get':
        case 'cmd.session.update':
        case 'cmd.session.delete':
        case 'cmd.session.pin':
        case 'cmd.pinned.list':
        case 'cmd.pinned.reorder':
            return ['B9'];
        default:
            if (cmdType.startsWith('cmd.permission.'))
                return ['B3', 'B4'];
            if (cmdType.startsWith('cmd.questionnaire.'))
                return ['B4', 'B9'];
            if (cmdType.startsWith('cmd.skill.') || cmdType.startsWith('cmd.model.'))
                return ['B6'];
            return ['B9'];
    }
}
function caseIdsForGenericRoute(route, payload) {
    const method = route.method.toUpperCase();
    const path = routePathnameForCaseMapping(route.path);
    if (hasRouteSegment(path, 'queue'))
        return ['A3'];
    if (hasAnyRouteSegment(path, [
        'file',
        'files',
        'artifact',
        'artifacts',
        'attachment',
        'attachments',
        'preview',
        'download',
    ])) {
        return ['B5'];
    }
    if (hasAnyRouteSegment(path, ['git', 'worktree', 'worktrees', 'branch', 'branches'])) {
        return ['B7'];
    }
    if (hasAnyRouteSegment(path, ['model', 'models', 'provider', 'providers'])) {
        return method === 'GET' ? ['B8', 'B11'] : ['B8'];
    }
    if (hasRouteSegment(path, 'config'))
        return caseIdsForGenericConfig(path, payload);
    if (hasAnyRouteSegment(path, ['skill', 'skills']))
        return ['B6'];
    if (hasAnyRouteSegment(path, ['goal', 'goals', 'plan', 'plans']))
        return ['B6', 'B9'];
    if (hasAnyRouteSegment(path, ['permission', 'permissions']))
        return ['B3', 'B4'];
    if (hasAnyRouteSegment(path, ['questionnaire', 'askuser']))
        return ['B4', 'B9'];
    if (hasRouteSegment(path, 'message')) {
        return method === 'GET' ? ['A1', 'A2', 'B4', 'B9'] : ['A1', 'A2', 'A3', 'B9', 'B10'];
    }
    if (hasRouteSegment(path, 'resume'))
        return ['A2', 'B9', 'B10'];
    if (hasAnyRouteSegment(path, ['abort', 'stop']))
        return ['B9', 'B10'];
    if (hasAnyRouteSegment(path, ['session', 'sessions'])) {
        return method === 'POST' ? ['A1', 'A2', 'B9'] : ['A2', 'B9'];
    }
    return ['B9'];
}
function caseIdsForGenericConfig(path, payload) {
    const signals = new Set(path.split('/').filter(Boolean));
    collectConfigSignals(payload, signals);
    const isEntryConfig = [...signals].some((signal) => /(?:remote.?control|permission|browser|plan.?mode|goal.?mode)/i.test(signal));
    const isModelConfig = [...signals].some((signal) => /(?:model|provider|byok|api.?key)/i.test(signal));
    if (isEntryConfig && isModelConfig)
        return ['B6', 'B8'];
    if (isEntryConfig)
        return ['B6'];
    if (isModelConfig)
        return ['B8'];
    return ['B6', 'B8'];
}
function collectConfigSignals(payload, signals) {
    for (const [key, value] of Object.entries(payload)) {
        signals.add(key);
        // Config mutation contracts commonly use { key/name, value }. Only read
        // short selector-like strings from those known fields; never inspect or
        // log arbitrary config values (API keys and user content may be present).
        if (['key', 'name', 'config_key', 'configKey'].includes(key) &&
            typeof value === 'string' &&
            value.length <= 128) {
            signals.add(value);
        }
        if (value && typeof value === 'object' && !Array.isArray(value)) {
            for (const nestedKey of Object.keys(value))
                signals.add(nestedKey);
        }
    }
}
function routePathnameForCaseMapping(path) {
    try {
        return new URL(path, LOCAL_ORIGIN).pathname.toLowerCase();
    }
    catch {
        return (path.split('?', 1)[0] ?? path).toLowerCase();
    }
}
function hasRouteSegment(path, segment) {
    return path.split('/').includes(segment);
}
function hasAnyRouteSegment(path, segments) {
    return segments.some((segment) => hasRouteSegment(path, segment));
}
function errorCodeForCaseLog(errorCode) {
    return /^[A-Z][A-Z0-9_]{0,63}$/.test(errorCode) ? errorCode : 'UNSAFE_ERROR_CODE';
}
/** Test-case diagnostics must never affect command execution or replies. */
function logRcCase(logger, level, event) {
    try {
        logger[level](`[RC_CASE] ${JSON.stringify({ ...event, case: event.case_ids.join(',') })}`);
    }
    catch {
        // Diagnostics are deliberately fail-open.
    }
}
function formatErrorBodyForLog(errorBody) {
    return redactLogValue(JSON.stringify({ code: errorBody.rawCode, message: errorBody.message, body: errorBody.body }));
}
function redactLogValue(value) {
    return value
        .replace(/(["']?(?:token|jwt|access_token|refresh_token|credential|ticket)["']?\s*[:=]\s*)["']?[^"'\s,}]+/gi, '$1<redacted>')
        .replace(/(bearer\s+)[^\s"']+/gi, '$1<redacted>')
        .replace(/(["']?(?:content|message|messages_json|text|prompt|body)["']?\s*:\s*)"(?:[^"\\]|\\.)*"/gi, '$1"<redacted>"');
}
function postJson(path, body) {
    return new Request(`${LOCAL_ORIGIN}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}
function putJson(path, body) {
    return new Request(`${LOCAL_ORIGIN}${path}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}
function patchJson(path, body) {
    return new Request(`${LOCAL_ORIGIN}${path}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}
function routeForLog(url) {
    return new URL(url).pathname;
}
function withQuery(path, params) {
    const url = new URL(`${LOCAL_ORIGIN}${path}`);
    for (const [key, value] of Object.entries(params)) {
        if (value === undefined || value === null)
            continue;
        if (typeof value === 'string' && value.length === 0)
            continue;
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
            url.searchParams.set(key, String(value));
        }
    }
    return url.toString();
}
function modelBody(model) {
    if (!model || typeof model !== 'object' || Array.isArray(model))
        return {};
    return { model: model };
}
/**
 * Downloaded attachment → generated Desktop AttachmentInput wire.
 */
function toDesktopAttachment(file, sourceMeta) {
    const attachmentType = sourceMeta?.attachment_type ?? sourceMeta?.attachmentType;
    const sizeBytes = readNumber(sourceMeta?.size_bytes ?? sourceMeta?.sizeBytes);
    return {
        meta: {
            ...(typeof attachmentType === 'string' || typeof attachmentType === 'number'
                ? { attachment_type: attachmentType }
                : {}),
            file_name: file.fileName,
            mime_type: file.mimeType,
            ...(sizeBytes !== undefined ? { size_bytes: sizeBytes } : {}),
        },
        local: {
            file_path: file.filePath,
        },
    };
}
function isPayload(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
/** Downloaded attachment → legacy /mavis/api flat, dual-alias wire. */
function toLegacyAttachment(file) {
    return {
        filePath: file.filePath,
        file_path: file.filePath,
        fileName: file.fileName,
        file_name: file.fileName,
        mimeType: file.mimeType,
        mime_type: file.mimeType,
    };
}
function readString(value) {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}
function readNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
function readBoolean(value) {
    return typeof value === 'boolean' ? value : undefined;
}
async function readJson(response) {
    try {
        const parsed = (await response.json());
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed
            : {};
    }
    catch {
        return {};
    }
}
function isBusyCode(rawCode) {
    return rawCode === 'local_session_busy' || rawCode === 'local_session_has_queued_messages';
}
function toDesktopBatchPermissionDecision(decision) {
    switch (decision) {
        case 'allowOnce':
            return 0;
        case 'allowAlways':
            return 1;
        case 'deny':
            return 2;
        default:
            return undefined;
    }
}
async function readErrorBody(response) {
    const body = await readJson(response);
    const rawCode = readString(body.key) ?? readString(body.code);
    return {
        ...(rawCode ? { rawCode } : {}),
        ...((readString(body.error) ?? readString(body.message))
            ? { message: readString(body.error) ?? readString(body.message) }
            : {}),
        body,
    };
}
async function toErrShape(response, domain) {
    return errShapeFrom(response.status, await readErrorBody(response), domain);
}
/**
 * Downstream failure → err payload. Codes are UPPER_SNAKE domain codes:
 * a Desktop `key` (or legacy string `code`) wins (local_session_busy → SESSION_BUSY), otherwise
 * the HTTP status maps per the IDL err.* convention list.
 */
export function errShapeFrom(status, body, domain) {
    const retryable = status >= 500 || status === 429 || status === 408;
    const message = body.message ?? `local runtime returned HTTP ${status}`;
    if (status === 503)
        return { code: 'DAEMON_UNAVAILABLE', message, retryable: true };
    if (body.rawCode) {
        return { code: body.rawCode.replace(/^local_/, '').toUpperCase(), message, retryable };
    }
    switch (status) {
        case 400:
            return { code: 'INVALID_ARGUMENT', message, retryable: false };
        case 401:
        case 403:
            return { code: 'PERMISSION_DENIED', message, retryable: false };
        case 404:
            return {
                code: domain === 'session' ? 'SESSION_NOT_FOUND' : 'NOT_FOUND',
                message,
                retryable: false,
            };
        case 409:
            return { code: 'SESSION_BUSY', message, retryable: false };
        case 413:
            return { code: 'ATTACHMENT_TOO_LARGE', message, retryable: false };
        case 415:
            return { code: 'ATTACHMENT_MIME_REJECTED', message, retryable: false };
        case 429:
            return { code: 'RATE_LIMITED', message, retryable: true };
        default:
            return { code: 'INTERNAL_ERROR', message, retryable };
    }
}
function missingField(field) {
    return {
        kind: 'err',
        err: { code: 'INVALID_ARGUMENT', message: `missing/invalid ${field}`, retryable: false },
    };
}
//# sourceMappingURL=command-router.js.map