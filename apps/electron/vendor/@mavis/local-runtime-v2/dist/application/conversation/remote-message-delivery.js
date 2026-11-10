import { randomUUID } from 'node:crypto';
import { ConversationTurnRejectedError, } from '@mavis/conversation-contract';
import { logger } from '@mavis/shared/local-runtime-logging/logger';
import { mapTurnRejection } from '../../service/session-system/index.js';
import { ApplicationError } from './errors.js';
/** Deliveries a sender retry with the same idempotency key collapses into. */
const RECEIPT_CAPACITY = 1000;
const RECEIPT_TTL_MS = 30 * 60 * 1000;
const MAX_IDEMPOTENCY_KEY_LENGTH = 256;
/**
 * Admits a message from a session on another device (SSH or Remote Control)
 * into a session on this runtime. It takes the same ingress entry points as a
 * local `session send` with source `communication`, so the message lands the
 * same way and the model sees the peer envelope, marked remote. The call only
 * reports how the message was admitted; the sender reads the reply back.
 */
export class RemoteMessageDelivery {
    options;
    receipts = new Map();
    constructor(options) {
        this.options = options;
    }
    async deliver(req) {
        const input = this.validated(req);
        const now = this.options.nowMs?.() ?? Date.now();
        const receiptKey = receiptKeyOf(input);
        const existing = receiptKey ? this.liveReceipt(receiptKey, now) : undefined;
        if (existing)
            return this.duplicate(input, existing);
        const admission = this.admit(input);
        if (receiptKey)
            this.remember(receiptKey, now, admission);
        try {
            const result = await admission;
            logger.info({ ...logFields(input), mode: result.mode, turnId: result.turnId, route: result.route }, 'Remote message admitted');
            this.reportReceived('ok', result.mode);
            return admissionResponse(result.mode, result);
        }
        catch (error) {
            // A failed admission delivered nothing, so a retry must be able to try again.
            if (receiptKey)
                this.forget(receiptKey, admission);
            const mapped = toApplicationError(error);
            logger.warn({ ...logFields(input), code: mapped?.key ?? 'UNMAPPED' }, 'Remote message rejected');
            this.reportReceived('error', 'none', mapped ?? error);
            throw mapped ?? error;
        }
    }
    /**
     * `remote_message_received_total`: one message another device sent to a
     * session on this runtime, counted once when it settled, admitted or not.
     * No `source` label: the request carries no channel, only the sender's own
     * self-description. Counts and enums only — never the sender, the target
     * session or the message content.
     */
    reportReceived(status, mode, error) {
        try {
            this.options.metrics?.counter('remote_message_received_total', 1, {
                status,
                mode,
                error_code: status === 'ok' ? 'none' : receivedErrorLabel(error),
            });
        }
        catch {
            // A telemetry outage must not turn a delivery into a failure.
        }
    }
    /** A message this runtime refused to look at is still one it received. */
    validated(req) {
        try {
            return validate(req);
        }
        catch (error) {
            this.reportReceived('error', 'none', error);
            throw error;
        }
    }
    async duplicate(input, existing) {
        let prior;
        try {
            prior = await existing.admission;
        }
        catch (error) {
            // A retry that joined a failing first request reports the same code as that request.
            const mapped = toApplicationError(error);
            logger.warn({ ...logFields(input), code: mapped?.key ?? 'UNMAPPED', joined: true }, 'Remote message rejected');
            this.reportReceived('error', 'none', mapped ?? error);
            throw mapped ?? error;
        }
        logger.info({ ...logFields(input), mode: 'duplicate', turnId: prior.turnId }, 'Remote message duplicate');
        this.reportReceived('ok', 'duplicate');
        return admissionResponse('duplicate', prior);
    }
    async admit(input) {
        await this.assertDeliverable(input.sessionId);
        const message = {
            content: input.content,
            attachments: [],
            origin: remoteOrigin(input.sender),
        };
        const route = input.delivery === 'steer' ? 'steer' : await this.preferredRoute(input);
        return route === 'steer' ? this.steer(input, message) : this.submit(input, message);
    }
    async assertDeliverable(sessionId) {
        const target = await this.options.sessions.getSession(sessionId);
        if (!target) {
            throw new ApplicationError(404, 'SESSION_NOT_FOUND', `Session not found: ${sessionId}`);
        }
        if (target.archived) {
            throw new ApplicationError(409, 'SESSION_ARCHIVED', `Session is archived: ${sessionId}`);
        }
    }
    async steer(input, message) {
        const steered = await this.options.ingress.steer({
            sessionId: input.sessionId,
            source: 'communication',
            // Same producer identity as a local session send: a machine producer, never user steering.
            producerId: `session-send:${input.sender.sessionId}`,
            idempotencyKey: `remote-message:${input.idempotencyKey ?? randomUUID()}`,
            message,
        });
        if (steered.mode === 'activated')
            observe(steered.completion);
        return { route: 'steer', mode: steered.mode, turnId: steered.turnId };
    }
    async submit(input, message) {
        const accepted = await this.options.ingress.submit({
            sessionId: input.sessionId,
            source: 'communication',
            allowQueue: true,
            message,
        });
        observe(accepted.completion);
        // Queue admission answers `queued` even when it already started this item's own Turn.
        const started = accepted.mode === 'queued' && accepted.queue?.dispatched === true;
        return {
            route: 'submit',
            mode: started ? 'started' : accepted.mode,
            turnId: accepted.turnId,
            ...(accepted.queue && !started ? { queueItemId: accepted.queue.itemId } : {}),
        };
    }
    /** `auto` follows the desktop composer preference; a failed read falls back to queue. */
    async preferredRoute(input) {
        if (!this.options.composerSendBehavior)
            return 'submit';
        try {
            return (await this.options.composerSendBehavior()) === 'steer' ? 'steer' : 'submit';
        }
        catch {
            logger.warn(logFields(input), 'Remote message could not read the composer send preference');
            return 'submit';
        }
    }
    liveReceipt(key, now) {
        const receipt = this.receipts.get(key);
        if (!receipt)
            return undefined;
        if (receipt.expiresAt <= now) {
            this.receipts.delete(key);
            return undefined;
        }
        return receipt;
    }
    remember(key, now, admission) {
        // A rejected admission is removed by `deliver`; this keeps it from surfacing as unhandled.
        observe(admission);
        this.receipts.set(key, { expiresAt: now + RECEIPT_TTL_MS, admission });
        while (this.receipts.size > RECEIPT_CAPACITY) {
            const oldest = this.receipts.keys().next().value;
            if (oldest === undefined)
                break;
            this.receipts.delete(oldest);
        }
    }
    forget(key, admission) {
        if (this.receipts.get(key)?.admission === admission)
            this.receipts.delete(key);
    }
}
function validate(req) {
    const sessionId = text(req.id);
    if (!sessionId)
        throw invalid('id is required');
    const content = typeof req.content === 'string' ? req.content.trim() : '';
    if (!content)
        throw invalid('content must be a non-empty string');
    const idempotencyKey = validateIdempotencyKey(req.idempotencyKey);
    return {
        sessionId,
        content,
        sender: validateSender(req.sender),
        delivery: validateDelivery(req.delivery),
        ...(idempotencyKey ? { idempotencyKey } : {}),
    };
}
function validateSender(sender) {
    const sessionId = text(sender?.sessionId);
    if (!sessionId)
        throw invalid('sender.session_id is required');
    const deviceName = text(sender?.deviceName);
    const agentName = text(sender?.agentName);
    const title = text(sender?.title);
    return {
        sessionId,
        ...(deviceName ? { deviceName } : {}),
        ...(agentName ? { agentName } : {}),
        ...(title ? { title } : {}),
    };
}
function validateDelivery(value) {
    if (value === undefined || value === '' || value === 'auto')
        return 'auto';
    if (value === 'steer')
        return 'steer';
    throw invalid('delivery must be auto or steer');
}
function validateIdempotencyKey(value) {
    if (value === undefined)
        return undefined;
    const key = text(value);
    if (!key)
        throw invalid('idempotency_key must be a non-empty string');
    if (key.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
        throw invalid(`idempotency_key must be at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters`);
    }
    return key;
}
/** Session ids only; the message content is never logged. */
function logFields(input) {
    return { sessionId: input.sessionId, senderSessionId: input.sender.sessionId };
}
function receiptKeyOf(input) {
    return input.idempotencyKey ? `${input.sessionId}\u0000${input.idempotencyKey}` : undefined;
}
function remoteOrigin(sender) {
    return {
        fromSession: sender.sessionId,
        command: 'session send',
        ...(sender.agentName ? { fromAgent: sender.agentName } : {}),
        ...(sender.title ? { fromTitle: sender.title } : {}),
        ...(sender.deviceName ? { fromDevice: sender.deviceName } : {}),
        remote: true,
    };
}
function admissionResponse(mode, admission) {
    return {
        mode,
        turnId: admission.turnId,
        ...(admission.queueItemId ? { queueItemId: admission.queueItemId } : {}),
    };
}
/**
 * A rejection a sender can act on. Turn admission is classified exactly as a
 * local session send classifies it, so a remote sender reads one contract: a
 * busy reason stays SESSION_BUSY and every other refusal is SESSION_SEND_REJECTED
 * with the admission reason in its message, instead of all of them being busy.
 */
function toApplicationError(error) {
    if (error instanceof ApplicationError)
        return error;
    if (error instanceof ConversationTurnRejectedError) {
        const mapped = mapTurnRejection(error);
        return new ApplicationError(mapped.status, mapped.code, mapped.message);
    }
    return undefined;
}
/**
 * Every `ApplicationError` key a remote delivery can be refused with: the
 * request itself (`validate`), the target session (`assertDeliverable`) and Turn
 * admission (`mapTurnRejection`, the same classification a local session send
 * uses). Anything else — an unmapped throw from the ingress or the session
 * query — reports as `other` so the series stays bounded.
 */
const RECEIVED_ERROR_CODES = new Set([
    'REMOTE_MESSAGE_INVALID',
    'SESSION_NOT_FOUND',
    'SESSION_ARCHIVED',
    'SESSION_BUSY',
    'SESSION_SEND_REJECTED',
]);
function receivedErrorLabel(error) {
    const key = error instanceof ApplicationError ? error.key : undefined;
    return key && RECEIVED_ERROR_CODES.has(key) ? key : 'other';
}
/** The receiver never waits on these; their settlement still has to be consumed. */
const remoteMessageObservations = new WeakSet();
function observe(settlement) {
    if (settlement)
        remoteMessageObservations.add(consumeSettlement(settlement));
}
async function consumeSettlement(settlement) {
    try {
        await settlement;
    }
    catch {
        // The Turn reports its own outcome; the sender reads it back from the target session.
    }
}
function invalid(message) {
    return new ApplicationError(400, 'REMOTE_MESSAGE_INVALID', message);
}
function text(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
//# sourceMappingURL=remote-message-delivery.js.map