import { hostname } from 'node:os';
import { logger } from '../../../../infra/logging/logger.js';
import { abortError, isAbortError, isHostLevelError, portCode, } from './device-source.js';
/** Polling steps while a sync send waits: 1s, 2s, then every 5s. */
const POLL_DELAYS_MS = [1000, 2000, 5000];
const REMOTE_SYNC_WAIT_LIMIT_MS = 10 * 60 * 1000;
/** One history page is enough to find the reply of the newest Turn. */
const REPLY_PAGE = 50;
/** Consecutive failed reads after which the wait gives up and answers with the ACK. */
const MAX_READ_FAILURES = 3;
/** Clock skew allowed when a cloud reply has to be found by time instead of by Turn. */
const CLOCK_SKEW_MS = 5000;
const TOOL_USE_FINISH = new Set(['toolUse', 'tool_use', 'tool_calls']);
/** AgentMessageProtocol msg_type: a tool-call step and a system event row (e.g. a plugin hook warning). */
const MSG_TYPE_TOOL_CALL = 2;
const MSG_TYPE_SYSTEM_EVENT = 3;
/**
 * Every `code` the model can be handed by a ssh / rc / cloud session list, get,
 * messages or send: the reader's own locate and paging codes, the device
 * sources' read and send codes, the receiver codes a remote send keeps, and the
 * cloud reader's stable keys (device-source.ts, remote-session-reader.ts,
 * ssh-device-source.ts, rc-device-source.ts, cloud-session-reader.ts).
 * `REMOTE_SESSIONS_UNAVAILABLE` is the host that cannot serve remote reads at
 * all. Bounding `error_code` to this set keeps the series small; anything new
 * reports as `other` until it is listed here.
 */
const REMOTE_SESSION_OP_ERROR_CODES = new Set([
    'SESSION_NOT_FOUND',
    'SESSION_ARCHIVED',
    'SESSION_BUSY',
    'SESSION_SEND_REJECTED',
    'SESSION_ID_AMBIGUOUS',
    'REMOTE_MESSAGE_INVALID',
    'REMOTE_SEND_FAILED',
    'REMOTE_SEND_UNCONFIRMED',
    'REMOTE_SEND_UNSUPPORTED',
    'REMOTE_READ_FAILED',
    'REMOTE_DEVICE_UNAVAILABLE',
    'REMOTE_DEVICE_NOT_FOUND',
    'REMOTE_SESSIONS_UNAVAILABLE',
    'INVALID_REMOTE_RESPONSE',
    'INVALID_CURSOR',
    'INVALID_DEVICE_ID',
    'INVALID_PAGE_SIZE',
    'INVALID_SESSION_ID',
    'INVALID_AGENT_NAME',
    'INVALID_CLOUD_RESPONSE',
    'RC_SESSIONS_UNAVAILABLE',
    'RC_AGENT_UNSUPPORTED',
    'SSH_SESSIONS_UNAVAILABLE',
    'CLOUD_LOGIN_REQUIRED',
    'CLOUD_LOGIN_CHANGED',
    'CLOUD_READ_UNAVAILABLE',
    'CLOUD_READ_FAILED',
    'CLOUD_AGENT_NOT_FOUND',
    'UNSUPPORTED_CLOUD_ENDPOINT',
]);
/** Known codes as they are, anything else (including no code at all) as `other`. */
function opErrorLabel(error) {
    const code = portCode(error);
    return code && REMOTE_SESSION_OP_ERROR_CODES.has(code) ? code : 'other';
}
/** How the target runtime admitted a message, as `remote_session_send_total` reports it. */
const REMOTE_SEND_MODE_LABELS = new Set([
    'started',
    'queued',
    'activated',
    'steered',
    'duplicate',
]);
/**
 * `remote_session_op_total`: one mavis session command against a ssh / rc /
 * cloud session, counted once when it settles. `aborted` is the caller's own
 * cancel, which is not a failure of the remote side. Only counts and enums —
 * never a session id, device id, device name or message content.
 */
export function countRemoteSessionOp(metrics, call) {
    reportMetric(metrics, 'remote_session_op_total', {
        op: call.op,
        source: call.source,
        status: call.status,
        error_code: call.status === 'error' ? opErrorLabel(call.error) : 'none',
    });
}
/** `remote_session_send_total`: a cross-device send the target runtime admitted. */
function countRemoteSend(metrics, source, mode, sync) {
    reportMetric(metrics, 'remote_session_send_total', {
        source,
        mode: REMOTE_SEND_MODE_LABELS.has(mode) ? mode : 'other',
        sync: sync ? 'true' : 'false',
    });
}
/** `remote_session_sync_wait_total`: how a `sync: true` send's wait ended. */
function countRemoteSyncWait(metrics, source, outcome) {
    reportMetric(metrics, 'remote_session_sync_wait_total', { source, outcome });
}
/** Metrics must not change or mask the product-path outcome. */
function reportMetric(metrics, name, labels) {
    try {
        metrics?.counter(name, 1, labels);
    }
    catch {
        // Same contract as the runner's other metrics.
    }
}
/**
 * `session send` to a session on another device. The target's runtime admits
 * the message and answers at once; `sync: true` is then served here by polling
 * the target's status and history, because the target cannot call back and a
 * forwarded request cannot stay open for a whole Turn.
 */
export async function sendToRemoteSession(deps, req, signal) {
    const now = deps.nowMs ?? Date.now;
    const sync = req.sync === true;
    logger.info({
        source: req.source,
        callerSessionId: req.sender.sessionId,
        sessionId: req.sessionId,
        sync,
        forceSteer: req.forceSteer === true,
    }, 'Remote session send requested');
    const sentAtMs = now();
    const result = await deps.remote.sendMessage({
        source: req.source,
        sessionId: req.sessionId,
        ...(req.deviceId ? { deviceId: req.deviceId } : {}),
        content: req.content,
        sender: req.sender,
        delivery: req.forceSteer === true ? 'steer' : 'auto',
    }, signal);
    logger.info({
        source: req.source,
        callerSessionId: req.sender.sessionId,
        sessionId: req.sessionId,
        deviceId: result.deviceId,
        mode: result.mode,
        turnId: result.turnId,
    }, 'Remote session send was admitted');
    // The target took the message; from here on only the wait can still fail.
    countRemoteSend(deps.metrics, req.source, result.mode, sync);
    if (!sync)
        return acknowledge(req, result);
    // A message merged into a running Turn owns no completion, exactly as for a local send.
    if (result.mode === 'steered' || result.mode === 'duplicate') {
        countRemoteSyncWait(deps.metrics, req.source, 'joined_turn');
        return acknowledge(req, result, 'joined-turn');
    }
    return awaitSyncReply(deps, { req, result, sentAtMs, ...(signal ? { signal } : {}) });
}
/** The reply of a sync send once its Turn ended, or the ACK that says why there is none. */
async function awaitSyncReply(deps, wait) {
    const { req, result } = wait;
    let outcome;
    try {
        outcome = await awaitRemoteReply(deps, wait);
    }
    catch (error) {
        // Only the caller's own cancel escapes the wait; every read failure answers with the ACK.
        if (isAbortError(error) || wait.signal?.aborted) {
            countRemoteSyncWait(deps.metrics, req.source, 'aborted');
        }
        throw error;
    }
    countRemoteSyncWait(deps.metrics, req.source, syncWaitOutcome(outcome));
    logger.info({
        source: req.source,
        sessionId: req.sessionId,
        turnId: result.turnId,
        outcome: outcome.kind,
        ...(outcome.kind === 'read-failed' ? { code: outcome.code } : {}),
    }, 'Remote session send finished waiting');
    if (outcome.kind === 'timeout')
        return acknowledge(req, result, 'remote-wait-timeout');
    if (outcome.kind === 'read-failed') {
        return acknowledge(req, result, 'remote-read-failed', outcome.code);
    }
    return completedResponse(req, result, outcome);
}
/** The wait's own outcome, split so a failed target Turn is not read as a completed reply. */
function syncWaitOutcome(outcome) {
    if (outcome.kind === 'timeout')
        return 'timeout';
    if (outcome.kind === 'read-failed')
        return 'read_failed';
    return outcome.failed ? 'completed_failed' : 'completed';
}
/** A finished Turn's answer, flagged when that Turn itself failed or was stopped. */
function completedResponse(req, result, outcome) {
    return {
        sessionId: req.sessionId,
        ...(result.turnId ? { turnId: result.turnId } : {}),
        status: 'completed',
        content: outcome.content,
        source: req.source,
        ...(result.deviceId ? { deviceId: result.deviceId } : {}),
        ...(outcome.failed
            ? {
                note: 'The target Turn ended with an error or was stopped; content is its last reply, if any.',
            }
            : {}),
    };
}
/** This desktop's name as the receiver shows it. */
export function localDeviceName() {
    const name = hostname()
        .replace(/\.local$/iu, '')
        .trim();
    return name || undefined;
}
/**
 * Polls `GetSession` until the target leaves `started`, then reads one page of
 * history and accepts it only once this Turn has visibly ended; a session that
 * is idle between Turns, before a queued message starts, keeps the wait going.
 */
async function awaitRemoteReply(deps, wait) {
    const { req, result, signal } = wait;
    const now = deps.nowMs ?? Date.now;
    const sleep = deps.sleep ?? sleepFor;
    const limit = deps.waitLimitMs ?? REMOTE_SYNC_WAIT_LIMIT_MS;
    const startedAt = now();
    const target = {
        source: req.source,
        sessionId: req.sessionId,
        ...(result.deviceId ? { deviceId: result.deviceId } : {}),
    };
    const state = { failures: 0, seenStarted: false };
    for (let attempt = 0;; attempt += 1) {
        const delay = POLL_DELAYS_MS[Math.min(attempt, POLL_DELAYS_MS.length - 1)];
        if (now() - startedAt + delay > limit)
            return { kind: 'timeout' };
        await sleep(delay, signal);
        let outcome;
        try {
            outcome = await readReply(deps, { ...wait, target, state });
        }
        catch (error) {
            outcome = onPollFailure(error, state, signal);
        }
        if (outcome)
            return outcome;
    }
}
/**
 * One poll step: the target's status, then one history page. The failure count
 * resets as soon as the status read succeeds, so a history read that fails
 * afterwards still counts as the first failure of a fresh run.
 */
async function readReply(deps, step) {
    const { req, result, sentAtMs, signal, target, state } = step;
    const status = statusType((await deps.remote.getSession(target, signal)).session?.status);
    state.failures = 0;
    if (status === 'started') {
        // Without a Turn id an Idle read may still predate the delivered message.
        state.seenStarted = true;
        return undefined;
    }
    const page = await deps.remote.listMessages({ ...target, limit: REPLY_PAGE }, signal);
    const reply = findReply((page.messages ?? []), {
        turnId: result.turnId,
        content: req.content,
        sentAtMs,
        status,
        seenStarted: state.seenStarted,
        ownTurn: ownsTurn(result.mode),
    });
    return reply ? { kind: 'completed', ...reply } : undefined;
}
/**
 * A failed poll. The target already admitted the message, so no read failure
 * fails the send: only the caller's own abort throws. A host-level failure
 * (login, endpoint) ends the wait at once, because every later read fails the
 * same way; one device read is retried until the third consecutive failure.
 * Both answer with the ACK, which says the message arrived and how to read it.
 */
function onPollFailure(error, state, signal) {
    if (signal?.aborted || isAbortError(error))
        throw abortError(signal);
    state.failures += 1;
    if (isHostLevelError(error))
        return { kind: 'read-failed', code: errorCode(error) };
    return state.failures >= MAX_READ_FAILURES
        ? { kind: 'read-failed', code: errorCode(error) }
        : undefined;
}
/**
 * The reply of this send, once its Turn has ended. With a Turn id (ssh, rc,
 * and a cloud `started`) that is the last assistant text of that Turn, matched
 * by the Turn's own messages only: the cloud's communicate card row carries no
 * Turn id. Without one, nothing counts until the target was seen running, this
 * message shows up in its history, or a user message from after the send does;
 * the reply is then the latest final assistant message after this message, or
 * after the send time when the message cannot be matched. System event rows and
 * rows that are not the assistant's never end a Turn or count as its reply.
 *
 * @internal Exported only for focused tests.
 */
export function findReply(messages, send) {
    const { turnId, content, sentAtMs, status, seenStarted = false, ownTurn = false } = send;
    const ordered = [...messages].sort((left, right) => timestamp(left) - timestamp(right));
    const failed = status === 'error' || status === 'aborted';
    if (turnId)
        return turnReply(ordered, turnId, failed, ownTurn);
    const after = replyWindow(ordered, content, sentAtMs, seenStarted);
    if (!after)
        return undefined;
    const final = after.filter(isFinalAssistant).at(-1);
    if (final)
        return { content: text(final.msg_content) ?? '', failed };
    if (failed)
        return { content: lastAssistantText(after) ?? '', failed };
    return undefined;
}
/**
 * With a Turn id the reply is that Turn's own last assistant text, once it has
 * ended. A Turn of this send that failed before writing any assistant row is
 * over too, so the wait ends with no reply instead of polling to the timeout.
 * A message still queued behind another Turn owns no such failure: its own Turn
 * has not run, and the failed status belongs to the one ahead of it.
 */
function turnReply(ordered, turnId, failed, ownTurn) {
    const turn = ordered.filter((message) => message.turn_id === turnId && isAssistantReplyRow(message));
    const last = turn.at(-1);
    if (!last)
        return failed && ownTurn ? { content: '', failed: true } : undefined;
    if (!failed && !isFinalAssistant(last))
        return undefined;
    return { content: lastAssistantText(turn) ?? '', failed };
}
/** Whether this send's message started the Turn the target ran; a `queued` message waits for its own. */
function ownsTurn(mode) {
    return mode === 'started' || mode === 'activated';
}
/**
 * The rows this send's reply can be in: everything after its own user message,
 * or, when that message cannot be matched in this page, the rows from the send
 * time on. Undefined while an Idle read may still predate the delivered
 * message: the wait goes on until the target was seen running, or a user
 * message from after the send shows up.
 */
function replyWindow(ordered, content, sentAtMs, seenStarted) {
    const head = content.trim().slice(0, 120);
    const anchorIndex = findLastIndex(ordered, (message) => message.role === 'user' && text(message.msg_content)?.includes(head) === true);
    const since = sentAtMs - CLOCK_SKEW_MS;
    const userAfterSend = ordered.some((message) => message.role === 'user' && timestamp(message) >= since);
    if (anchorIndex < 0 && !seenStarted && !userAfterSend)
        return undefined;
    if (anchorIndex >= 0)
        return ordered.slice(anchorIndex + 1);
    return ordered.filter((message) => timestamp(message) >= since);
}
function acknowledge(req, result, reason, readFailure) {
    return {
        sessionId: req.sessionId,
        ...(result.turnId ? { turnId: result.turnId } : {}),
        status: 'accepted',
        mode: result.mode,
        note: describeRemoteAdmission(req, result.mode, reason, readFailure),
        source: req.source,
        ...(result.deviceId ? { deviceId: result.deviceId } : {}),
    };
}
function describeRemoteAdmission(req, mode, reason, readFailure) {
    const read = `session messages with source "${req.source}" and session_id "${req.sessionId}"`;
    const why = ackReasonNote(reason, readFailure);
    const remote = ' The target is on another device and cannot send messages back to this session.';
    if (mode === 'steered' || mode === 'duplicate') {
        const merged = mode === 'duplicate'
            ? 'This message had already been delivered to the target session.'
            : 'This message was merged into the Turn already running in the target session.';
        return `${merged} That Turn answers once for everything merged into it, so this message gets no separate reply.${why}${remote} Read the outcome with ${read}; sending it again would deliver a second copy.`;
    }
    const admitted = mode === 'queued'
        ? 'The target session was busy, so this message was queued and runs after its current Turn.'
        : 'A new Turn started in the target session.';
    return `${admitted}${why}${remote} Read the reply with ${read} once it has run. Do not send this message again to wait for it: a resend is a second message and would run the work twice.`;
}
/** Why a sync send answered with the ACK instead of the reply; `{code}` is the read failure. */
const ACK_REASON_NOTES = {
    'joined-turn': ' sync was not honoured because a merged message owns no completion.',
    'remote-wait-timeout': ' sync waited 10 minutes and that Turn had not finished.',
    'remote-read-failed': ' sync stopped because the target session could not be read ({code}).',
};
/** The ACK's reason clause, or nothing when the send was admitted and left running. */
function ackReasonNote(reason, readFailure) {
    if (!reason)
        return '';
    // A function replacement keeps a `$`-bearing code out of the replacement patterns.
    return ACK_REASON_NOTES[reason].replace('{code}', () => readFailure ?? 'read_failed');
}
/** `session get` status in the local shape: `{ type: 'idle' | 'started' | 'error' | 'aborted' }`. */
function statusType(status) {
    if (!status || typeof status !== 'object')
        return undefined;
    const type = status.type;
    return typeof type === 'string' ? type : undefined;
}
/** Assistant output; a system event row stored with an assistant role is not a reply. */
function isAssistantReplyRow(message) {
    return message.role === 'assistant' && message.msg_type !== MSG_TYPE_SYSTEM_EVENT;
}
function isFinalAssistant(message) {
    if (!isAssistantReplyRow(message) || !text(message.msg_content))
        return false;
    // A tool-call step is not the reply, even where finish_reason is missing.
    if (message.msg_type === MSG_TYPE_TOOL_CALL)
        return false;
    const finish = message.finish_reason;
    return typeof finish !== 'string' || !TOOL_USE_FINISH.has(finish);
}
function lastAssistantText(messages) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        const body = text(message.msg_content);
        if (isAssistantReplyRow(message) && body)
            return body;
    }
    return undefined;
}
function findLastIndex(items, match) {
    for (let index = items.length - 1; index >= 0; index -= 1) {
        if (match(items[index]))
            return index;
    }
    return -1;
}
function timestamp(message) {
    return typeof message.timestamp === 'number' ? message.timestamp : 0;
}
function text(value) {
    return typeof value === 'string' && value.trim() ? value : undefined;
}
function errorCode(error) {
    const code = error && typeof error === 'object' && 'code' in error
        ? error.code
        : undefined;
    return typeof code === 'string' && code ? code : 'read_failed';
}
function sleepFor(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(abortError(signal));
            return;
        }
        const onAbort = () => {
            clearTimeout(timer);
            reject(abortError(signal));
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}
//# sourceMappingURL=remote-session-send.js.map