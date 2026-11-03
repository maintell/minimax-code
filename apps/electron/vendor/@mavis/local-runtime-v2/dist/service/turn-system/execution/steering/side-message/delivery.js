import { createUserMessageId } from '../../../../session-system/shared/user-message-id.js';
import { steeringMessageKey } from '../../../steering-identity.js';
const SIDE_MESSAGE_RACES = new Set([
    'active-turn',
    'delivery-closed',
    'compaction-active',
    'ingress-conflict',
    'priority-blocked',
    'computer-use-requires-new-turn',
    'active-model-override-unsupported',
    'continuation-unavailable',
]);
/** The race outcome each verification fault stands in for at the selected target. */
const FAULT_RACES = {
    'turn-ended': 'active-turn',
    closing: 'delivery-closed',
    'continuation-unavailable': 'continuation-unavailable',
    'ingress-conflict': 'ingress-conflict',
    undeliverable: 'active-turn',
};
/** Vetoes one delivery at its selected target; never escapes this module. */
class SubstitutedSteerOutcome extends Error {
    race;
    constructor(race) {
        super(`Steer delivery outcome substituted: ${race}`);
        this.race = race;
        this.name = 'SubstitutedSteerOutcome';
    }
}
/** The verification `undeliverable` fault makes the Queue fallback itself fail. */
class InjectedFallbackFailure extends Error {
    constructor() {
        super('Side message Queue fallback failed by verification fault');
        this.name = 'InjectedFallbackFailure';
    }
}
/**
 * One delivery workflow for user side messages from every entry (Desktop
 * composer, TUI). A turn-switch race is not the user's error, so the same
 * message moves into the Session Queue; only when that also fails is it
 * reported undelivered.
 */
export function createSideMessageDelivery(options) {
    return {
        deliver: (input, callOptions) => deliverSideMessage(options, input, callOptions?.recordUndelivered !== false),
    };
}
async function deliverSideMessage(options, input, recordUndelivered) {
    const fallback = fallbackSubmission(input);
    const context = { options, input, fallback, attempt: {}, recordUndelivered };
    if (await isAlreadyQueued(options, input.sessionId, fallback.clientRequestId)) {
        // A repeated request whose first attempt already fell back: replay the
        // idempotent enqueue instead of steering a second copy into a Turn.
        return enqueueFallback(context, 'already-queued');
    }
    // Read after the Queue: a Turn admits the queued copy before its item leaves
    // the Queue, so an item missing above has already left its durable receipt.
    const consumed = await findConsumedFallback(options, input.sessionId, fallback.clientRequestId);
    if (consumed) {
        // The queued copy already ran (or runs) as its own Turn; steering it again
        // would deliver the same instruction twice.
        return {
            status: 'delivered',
            result: { delivered: true, mode: 'duplicate', turnId: consumed.turnId },
        };
    }
    const recorded = recordUndelivered
        ? await findRecorded(options, input.sessionId, fallback.userMessageId)
        : undefined;
    // A repeated request whose first attempt was recorded undelivered replays that
    // outcome; delivering it now would leave the recorded row behind as a copy.
    if (recorded)
        return undeliveredResult(context, 'active-turn', 'already-recorded', recorded);
    const steered = await steerAtTarget(options, input, context.attempt);
    if (steered.delivered)
        return { status: 'delivered', result: steered };
    if (!isSideMessageRace(steered.reason))
        return { status: 'rejected', reason: steered.reason };
    return enqueueFallback(context, steered.reason);
}
async function steerAtTarget(options, input, attempt) {
    try {
        return await options.steer.steerWithTargetHook(input, async ({ sessionId, turnId }) => {
            attempt.targetTurnId = turnId;
            const fault = await options.faults?.consume({ sessionId, turnId });
            if (!fault)
                return;
            attempt.fault = fault;
            throw new SubstitutedSteerOutcome(FAULT_RACES[fault]);
        });
    }
    catch (error) {
        if (error instanceof SubstitutedSteerOutcome)
            return { delivered: false, reason: error.race };
        throw error;
    }
}
async function enqueueFallback(context, race) {
    let result;
    try {
        if (context.attempt.fault === 'undeliverable')
            throw new InjectedFallbackFailure();
        result = await context.options.submission.submit(context.fallback);
    }
    catch (error) {
        return undelivered(context, race, error);
    }
    if (!result.accepted || result.mode !== 'queued') {
        return undelivered(context, race, result.accepted ? `unexpected-${result.mode}` : result.reason);
    }
    report(context, race, {
        outcome: 'queued',
        queueItemId: result.queue.itemId,
        queuedTurnId: result.turnId,
    });
    return {
        status: 'queued',
        race,
        turnId: result.turnId,
        completion: result.completion,
        queue: result.queue,
    };
}
/**
 * The single seam for a side message the runtime received but could neither
 * steer into a Turn nor queue. The recorder keeps it as an undelivered display
 * row and pauses an active Goal; without one (or with no active Goal) the
 * caller keeps its existing failure reply.
 */
async function undelivered(context, race, failure) {
    report(context, race, { outcome: 'failed', failure: describeFailure(failure) });
    // A replayed request has no race of its own; the original race already queued it once.
    const reportedRace = race === 'already-queued' ? 'active-turn' : race;
    const result = undeliveredResult(context, reportedRace, failure);
    if (!context.recordUndelivered || !context.options.undelivered)
        return result;
    let record;
    try {
        record = await context.options.undelivered.record(result.message);
    }
    catch {
        // The failure reply stays authoritative when the record cannot be kept.
        return result;
    }
    return record ? { ...result, record } : result;
}
function undeliveredResult(context, reportedRace, failure, record) {
    const { input } = context;
    const message = {
        sessionId: input.sessionId,
        userMessageId: context.fallback.userMessageId,
        content: input.input.text,
        attachments: input.input.attachments ?? [],
        ...(input.delivery?.displayContent !== undefined
            ? { displayContent: input.delivery.displayContent }
            : {}),
        ...(input.delivery?.displayAttachments
            ? { displayAttachments: input.delivery.displayAttachments }
            : {}),
        ...(input.input.model ? { model: input.input.model } : {}),
        ...(input.input.computerUse ? { computerUse: { enable: input.input.computerUse.enable } } : {}),
        provenance: input.provenance,
        createdAtMs: input.createdAt ?? Math.floor((context.options.nowMs ?? Date.now)()),
        race: reportedRace,
        failure,
    };
    return { status: 'undelivered', race: reportedRace, message, ...(record ? { record } : {}) };
}
async function findRecorded(options, sessionId, messageId) {
    try {
        return await options.undelivered?.find(sessionId, messageId);
    }
    catch {
        // An unreadable record only loses the replay shortcut.
        return undefined;
    }
}
function report(context, race, outcome) {
    const { attempt, input } = context;
    try {
        context.options.observe?.({
            sessionId: input.sessionId,
            producerId: input.producerId,
            race,
            ...(attempt.targetTurnId ? { targetTurnId: attempt.targetTurnId } : {}),
            ...(attempt.fault ? { injectedFault: attempt.fault } : {}),
            ...outcome,
        });
    }
    catch {
        // The fallback outcome is authoritative; its log line is best-effort.
    }
}
/**
 * A plain queued user message carrying the same content, attachments, display
 * projection and model choice. Steer-only hooks (pre-delivery, receipts,
 * output contracts) and the steer client intent stay behind; the deterministic
 * client request id makes a repeated request replay the same Queue item.
 */
function fallbackSubmission(input) {
    const clientRequestId = `side-message:${input.producerId}:${input.idempotencyKey}`;
    // The display identity the steer itself would have used, so the queued row
    // and any later record of this message share one stable id.
    const userMessageId = input.userMessageId ??
        createUserMessageId({ sessionId: input.sessionId, messageKey: steeringMessageKey(input) });
    const delivery = input.delivery;
    return {
        sessionId: input.sessionId,
        input: input.input,
        ...(input.inputSafetyDecision ? { inputSafetyDecision: input.inputSafetyDecision } : {}),
        provenance: input.provenance,
        allowQueue: true,
        clientRequestId,
        userMessageId,
        delivery: {
            ...(delivery?.hideUserMessage !== undefined
                ? { hideUserMessage: delivery.hideUserMessage }
                : {}),
            ...(delivery?.displayContent !== undefined
                ? { displayContent: delivery.displayContent }
                : {}),
            ...(delivery?.displayAttachments ? { displayAttachments: delivery.displayAttachments } : {}),
            userMessageId,
        },
    };
}
/** Queued or claimed: the enqueue replay returns that same item. */
async function isAlreadyQueued(options, sessionId, clientRequestId) {
    try {
        return Boolean(await options.queue.findByClientRequestId(sessionId, clientRequestId));
    }
    catch {
        // An unreadable Queue only loses the replay shortcut; the enqueue stays idempotent.
        return false;
    }
}
async function findConsumedFallback(options, sessionId, clientRequestId) {
    try {
        return await options.receipts.findSteeringReceipt({ sessionId, clientRequestId });
    }
    catch {
        // An unreadable receipt only loses the replay shortcut.
        return undefined;
    }
}
function isSideMessageRace(reason) {
    return SIDE_MESSAGE_RACES.has(reason);
}
function describeFailure(failure) {
    if (typeof failure === 'string')
        return failure;
    if (failure instanceof Error)
        return failure.name;
    return 'unknown';
}
//# sourceMappingURL=delivery.js.map