import { createHash } from 'node:crypto';
import { UNDELIVERED_USER_MESSAGE_KIND, } from '../../service/session-system/index.js';
/**
 * Origin kind marking the copy a retry actually delivered. Origin travels with
 * the message through a steer, the Queue (persisted on the item) and the
 * committed user row. The undelivered row it re-sends stays the one visible
 * message, so every display surface drops the marked copy; the model still
 * receives it.
 */
const UNDELIVERED_RETRY_ORIGIN_KIND = 'undelivered_retry';
/**
 * Undelivered user side messages during an active Goal (spec section 4).
 *
 * A message the runtime received but could neither steer nor queue becomes a
 * display-only user row (no Turn id, so never model history) bound to the Goal
 * it paused. Retry re-sends the stored input once per request; on success the
 * row turns into a normal sent message in place and links the delivery. Discard
 * deletes the row. When no row bound to a Goal paused for this reason is left,
 * that Goal resumes through the user resume path.
 */
export class UndeliveredSideMessages {
    options;
    inFlight = new Set();
    nowMs;
    constructor(options) {
        this.options = options;
        this.nowMs = options.nowMs ?? Date.now;
    }
    async record(message) {
        const goal = await this.options.goals.getBySession(message.sessionId);
        // Only a running Goal keeps the message (spec 4.1); otherwise the caller
        // keeps today's failure reply and the Goal is untouched.
        if (goal?.status !== 'active')
            return undefined;
        const committed = await this.options.messages.commitUndeliveredMessage({
            sessionId: message.sessionId,
            message: undeliveredRow(message, goal.goalId),
            source: message.provenance.source,
        });
        if (!committed.created)
            return recordOf(committed.message);
        const paused = await this.options.goals.pauseForUndeliveredMessage(message.sessionId, goal.goalId);
        if (!paused && !(await this.isPausedForUndelivered(message.sessionId, goal.goalId))) {
            // The Goal stopped running meanwhile: fall back to the plain failure.
            await this.options.messages.updateUndeliveredMessage(message.sessionId, message.userMessageId, () => ({ kind: 'delete' }));
            return undefined;
        }
        this.publishRow(message.sessionId, committed.message, 'recorded');
        return { messageId: message.userMessageId, goalId: goal.goalId };
    }
    async find(sessionId, messageId) {
        const row = await this.options.messages.get(sessionId, messageId);
        return row ? recordOf(row) : undefined;
    }
    async retry(sessionId, messageId, deliver) {
        return this.exclusive(sessionId, messageId, async () => {
            const row = await this.options.messages.get(sessionId, messageId);
            if (!row)
                return { status: 'missing' };
            const data = undeliveredData(row);
            if (row.kind !== UNDELIVERED_USER_MESSAGE_KIND || !data) {
                const turnId = deliveredTurnId(row);
                return turnId ? { status: 'already-delivered', turnId } : { status: 'not-undelivered' };
            }
            const { delivery, value } = await deliver(storedMessage(sessionId, messageId, data));
            if (delivery.kind === 'failed') {
                await this.bumpAttempt(sessionId, messageId, data.attempt);
                return { status: 'failed', value };
            }
            // The binding as converted: an objective replacement during the delivery
            // detached the row, and a detached row never resumes its Goal (spec 4.6).
            let goalId = null;
            const converted = await this.options.messages.updateUndeliveredMessage(sessionId, messageId, (current) => {
                goalId = undeliveredData(current)?.goal_id ?? null;
                return { kind: 'replace', message: sentRow(current, delivery, this.nowMs()) };
            });
            if (converted.status === 'replaced')
                this.publishRow(sessionId, converted.message, 'sent');
            const goalResumed = await this.resumeIfLast(sessionId, converted.status === 'replaced' ? goalId : null);
            return { status: 'delivered', value, goalResumed };
        });
    }
    async discard(sessionId, messageId) {
        return this.exclusive(sessionId, messageId, async () => {
            let goalId = null;
            const result = await this.options.messages.updateUndeliveredMessage(sessionId, messageId, (current) => {
                goalId = undeliveredData(current)?.goal_id ?? null;
                return { kind: 'delete' };
            });
            if (result.status === 'missing')
                return { status: 'already-discarded' };
            if (result.status !== 'deleted')
                return { status: 'not-undelivered' };
            this.publishDiscarded(sessionId, messageId);
            return { status: 'discarded', goalResumed: await this.resumeIfLast(sessionId, goalId) };
        });
    }
    /**
     * The user replaced this Goal's objective (same Goal id): its rows stay and
     * stay retryable, but no longer pause or resume it (spec 4.6, S31c). The
     * detachment is persisted, so restoring the old objective does not re-bind.
     */
    async detachGoal(sessionId, goalId) {
        const rows = await this.options.messages.listUndeliveredMessages(sessionId);
        for (const row of rows) {
            if (undeliveredData(row)?.goal_id !== goalId)
                continue;
            await this.options.messages.updateUndeliveredMessage(sessionId, String(row.msg_id), (current) => {
                const data = undeliveredData(current);
                if (data?.goal_id !== goalId)
                    return { kind: 'keep' };
                return {
                    kind: 'replace',
                    message: {
                        ...current,
                        undelivered: { ...data, goal_id: null, detached_goal_id: goalId },
                    },
                };
            });
        }
    }
    /** One retry or discard per row at a time; a concurrent click is refused, never run twice. */
    async exclusive(sessionId, messageId, operation) {
        const key = `${sessionId}\u0000${messageId}`;
        if (this.inFlight.has(key))
            return { status: 'in-progress' };
        this.inFlight.add(key);
        try {
            return await operation();
        }
        finally {
            this.inFlight.delete(key);
        }
    }
    async bumpAttempt(sessionId, messageId, attempt) {
        await this.options.messages.updateUndeliveredMessage(sessionId, messageId, (current) => {
            const data = undeliveredData(current);
            if (!data || data.attempt !== attempt)
                return { kind: 'keep' };
            return {
                kind: 'replace',
                message: { ...current, undelivered: { ...data, attempt: attempt + 1 } },
            };
        });
    }
    async isPausedForUndelivered(sessionId, goalId) {
        const goal = await this.options.goals.getBySession(sessionId);
        return goal?.goalId === goalId && goal.status === 'paused';
    }
    /**
     * Resume only from the last row bound to the Goal; a manual resume earlier
     * kept every row bound (spec 4.5, S11), so they still count here.
     */
    async resumeIfLast(sessionId, goalId) {
        if (!goalId)
            return false;
        try {
            const rows = await this.options.messages.listUndeliveredMessages(sessionId);
            if (rows.some((row) => undeliveredData(row)?.goal_id === goalId))
                return false;
            return await this.options.goals.resumeFromUndeliveredMessagePause(sessionId, goalId);
        }
        catch (error) {
            this.options.reportFailure?.(sessionId, `undelivered_side_message_goal_resume_failed:${error instanceof Error ? error.message : String(error)}`);
            return false;
        }
    }
    publishRow(sessionId, message, phase) {
        try {
            this.options.stream.write({
                identity: `undelivered-side-message:${String(message.msg_id)}:${phase}`,
                sessionId,
                kind: 'message-committed',
                data: { messages: [message] },
            });
        }
        catch {
            // The durable row is replayed by Session stream resume and GetMessages.
        }
    }
    publishDiscarded(sessionId, messageId) {
        try {
            this.options.stream.write({
                identity: `undelivered-side-message:${messageId}:discarded`,
                sessionId,
                kind: 'runtime-event',
                data: {
                    type: 'message_discarded',
                    message_discarded: { session_id: sessionId, message_id: messageId },
                },
            });
        }
        catch {
            // A reload drops the deleted row anyway.
        }
    }
}
/** True for the hidden copy a retry delivered; its undelivered row is the visible message. */
export function isUndeliveredRetryCopy(message) {
    const context = message.sourceContext;
    if (!isRecord(context) || !isRecord(context.origin))
        return false;
    return context.origin.kind === UNDELIVERED_RETRY_ORIGIN_KIND;
}
function undeliveredRow(message, goalId) {
    const displayAttachments = (message.displayAttachments ?? message.attachments).map((attachment) => ({ ...attachment }));
    const data = {
        v: 1,
        goal_id: goalId,
        reason: message.race,
        failure: describeFailure(message.failure),
        failed_at_ms: message.createdAtMs,
        attempt: 0,
        input: {
            text: message.content,
            attachments: message.attachments.map((attachment) => ({ ...attachment })),
            ...(message.displayContent !== undefined ? { display_content: message.displayContent } : {}),
            ...(message.displayAttachments
                ? { display_attachments: message.displayAttachments.map((item) => ({ ...item })) }
                : {}),
            ...(message.model ? { model: message.model } : {}),
            ...(message.computerUse ? { computer_use: { enable: message.computerUse.enable } } : {}),
            provenance: message.provenance,
        },
    };
    return {
        msg_id: message.userMessageId,
        role: 'user',
        msg_type: 1,
        msg_content: message.displayContent || message.content,
        timestamp: message.createdAtMs,
        kind: UNDELIVERED_USER_MESSAGE_KIND,
        ...(displayAttachments.length > 0 ? { attachments: displayAttachments } : {}),
        raw_json: JSON.stringify({
            undelivered: { reason: message.race, failed_at_ms: message.createdAtMs },
        }),
        undelivered: data,
    };
}
/** The row as a normal sent user message: no failure marker, plus the delivery link. */
function sentRow(current, delivery, nowMs) {
    const sent = { ...current };
    delete sent.kind;
    delete sent.undelivered;
    delete sent.raw_json;
    delete sent.source;
    delete sent.sourceContext;
    return {
        ...sent,
        delivered_as: {
            mode: delivery.mode,
            turn_id: delivery.turnId,
            ...(delivery.queueItemId ? { queue_item_id: delivery.queueItemId } : {}),
            delivered_at_ms: nowMs,
        },
    };
}
function storedMessage(sessionId, messageId, data) {
    const { input } = data;
    return {
        sessionId,
        messageId,
        text: input.text,
        attachments: input.attachments,
        ...(input.display_content !== undefined ? { displayContent: input.display_content } : {}),
        ...(input.display_attachments ? { displayAttachments: input.display_attachments } : {}),
        ...(input.model ? { model: input.model } : {}),
        ...(input.computer_use ? { computerUse: input.computer_use } : {}),
        provenance: {
            ...input.provenance,
            sourceContext: {
                ...input.provenance.sourceContext,
                origin: { kind: UNDELIVERED_RETRY_ORIGIN_KIND, message_id: messageId },
            },
        },
        retryKey: `turn_retry_${createHash('sha256')
            .update(`${sessionId}\u0000${messageId}\u0000${String(data.attempt)}`)
            .digest('hex')
            .slice(0, 32)}`,
    };
}
function recordOf(row) {
    const data = row.kind === UNDELIVERED_USER_MESSAGE_KIND ? undeliveredData(row) : undefined;
    if (!data || typeof row.msg_id !== 'string')
        return undefined;
    return { messageId: row.msg_id, ...(data.goal_id ? { goalId: data.goal_id } : {}) };
}
function undeliveredData(row) {
    const value = row.undelivered;
    if (!isRecord(value) || value.v !== 1)
        return undefined;
    if (typeof value.attempt !== 'number' || !Number.isSafeInteger(value.attempt))
        return undefined;
    const input = storedInput(value.input);
    if (!input)
        return undefined;
    return {
        v: 1,
        goal_id: stringOr(value.goal_id, null),
        ...(typeof value.detached_goal_id === 'string'
            ? { detached_goal_id: value.detached_goal_id }
            : {}),
        reason: stringOr(value.reason, 'unknown'),
        failure: stringOr(value.failure, 'unknown'),
        failed_at_ms: typeof value.failed_at_ms === 'number' ? value.failed_at_ms : 0,
        attempt: value.attempt,
        input,
    };
}
function storedInput(input) {
    if (!isRecord(input) || typeof input.text !== 'string')
        return undefined;
    if (!Array.isArray(input.attachments))
        return undefined;
    const provenance = storedProvenance(input.provenance);
    if (!provenance)
        return undefined;
    return {
        text: input.text,
        attachments: input.attachments.filter(isRecord),
        ...(typeof input.display_content === 'string'
            ? { display_content: input.display_content }
            : {}),
        ...(Array.isArray(input.display_attachments)
            ? { display_attachments: input.display_attachments.filter(isRecord) }
            : {}),
        ...(isRecord(input.model) ? { model: input.model } : {}),
        ...(isRecord(input.computer_use) && typeof input.computer_use.enable === 'boolean'
            ? { computer_use: { enable: input.computer_use.enable } }
            : {}),
        provenance,
    };
}
function storedProvenance(value) {
    if (!isRecord(value) || typeof value.source !== 'string')
        return undefined;
    if (typeof value.routingFingerprint !== 'string')
        return undefined;
    return {
        source: value.source,
        routingFingerprint: value.routingFingerprint,
        ...(isRecord(value.sourceContext) ? { sourceContext: value.sourceContext } : {}),
    };
}
function stringOr(value, fallback) {
    return typeof value === 'string' ? value : fallback;
}
function deliveredTurnId(row) {
    const link = row.delivered_as;
    return isRecord(link) && typeof link.turn_id === 'string' ? link.turn_id : undefined;
}
function describeFailure(failure) {
    if (typeof failure === 'string')
        return failure;
    if (failure instanceof Error)
        return failure.name;
    return 'unknown';
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=undelivered-side-messages.js.map