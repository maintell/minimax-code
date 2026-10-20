import { parsePluginMentions } from '@mavis/shared/plugin-mention';
import { randomUUID } from 'node:crypto';
import { UserMessageCommitAdmissionError, UserMessageCommitConflictError, retryUserMessageCommit, writeQueryCollapseView, } from '../../service/session-system/index.js';
import { isUserSteeringProducer, resolveGenuineUserQueryText, } from '../../service/turn-system/index.js';
import { sessionClioDirectQueryId, sessionClioSteeringQueryId, } from '../../service/session-clio/index.js';
import { queryCollapseQueryKey } from './query-collapse-identity.js';
const STEERED_USER_MESSAGE_KIND = 'steered_user';
/** Commits visible user Messages only after durable Turn acceptance or steer consumption. */
export class UserMessageTurnDeliveryService {
    options;
    makeTurnId;
    constructor(options) {
        this.options = options;
        this.makeTurnId = options.makeTurnId ?? (() => `turn_${randomUUID()}`);
    }
    deliver(input) {
        return executeDelivery(this.options, {
            ...input,
            requestedTurnId: input.requestedTurnId ?? this.makeTurnId(),
            submittedAtMs: input.queryOccurredAtMs ?? (this.options.nowMs ?? Date.now)(),
        });
    }
    async consumeSteering(input) {
        // Steering binds at actual consumption, before the visible projection gate:
        // a hidden steer that carried no admitted Query is a no-op inside bindTurn,
        // so ordering here cannot invent one.
        await this.options.sessionClio?.bindTurn({
            sessionId: input.sessionId,
            turnId: input.turnId,
            queryIds: [sessionClioSteeringQueryId(input.message)],
        });
        const delivery = input.message.delivery;
        if (!shouldProjectMessage(delivery))
            return;
        const attachments = deliveryAttachments(delivery, input.message.message.attachments);
        const queryKey = await resolveQueryKeyForTurn(this.options, input.sessionId, input.turnId);
        // 此处只处理当前 Turn 的追加消息；启动新 Turn 的 task 输入走 deliver()。
        // task 追加与用户 steer 使用相同的展示标记，避免被拆成新的对话轮次。
        const displayAsUserSteer = isUserSteeringProducer(input.message.producerId) ||
            input.message.provenance.source === 'task';
        const commit = await commitMessage(this.options, {
            sessionId: input.sessionId,
            turnId: input.turnId,
            queryKey,
            ...(displayAsUserSteer ? { kind: STEERED_USER_MESSAGE_KIND } : {}),
            messageKey: input.message.messageKey ??
                `steer:${input.message.producerId}:${input.message.idempotencyKey}`,
            ...(input.message.unconsumedFromTurnIds
                ? { unconsumedFromTurnIds: input.message.unconsumedFromTurnIds }
                : {}),
            ...(input.message.userMessageId ? { userMessageId: input.message.userMessageId } : {}),
            unstartedFromTurnIds: input.message.unstartedFromTurnIds,
            content: projectedMessageContent(delivery, input.message.message.text),
            inputContent: input.message.message.text,
            ...(attachments ? { attachments } : {}),
            ...(input.message.sourceMessageId ? { sourceMessageId: input.message.sourceMessageId } : {}),
            provenance: input.message.provenance,
            ...(input.message.createdAt !== undefined ? { timestamp: input.message.createdAt } : {}),
        });
        projectCommitted(this.options, commit);
    }
}
async function executeDelivery(options, input) {
    const start = createStartFence();
    const visibleQuery = shouldProjectMessage(input);
    const genuineUserQueryText = resolveGenuineUserQueryText({
        input: input.input,
        provenance: input.provenance,
        delivery: input,
    });
    let result;
    let accepted;
    try {
        await input.beforeSubmit?.(input.requestedTurnId);
        result = await input.submit({
            requestedTurnId: input.requestedTurnId,
            executionStart: start.promise,
            genuineUserQueryText,
            requiresInputReview: visibleQuery,
        });
        if (!result.accepted) {
            if (result.reason !== 'duplicate') {
                await captureSessionClioQuery(options, input, undefined, genuineUserQueryText);
            }
            start.release();
            await repairDuplicateMessage(options, input, result);
            return result;
        }
        accepted = result;
        // Capture before acceptance callbacks or projection can fail. The start
        // fence still prevents the Turn from consuming input until delivery ends.
        await captureSessionClioQuery(options, input, result.turnId, genuineUserQueryText);
        await completeAcceptedDelivery(options, input, result, visibleQuery);
        start.release();
        return result;
    }
    catch (error) {
        // A submission error is still a genuine unanswered Query, not a duplicate
        // or evidence that a Turn consumed it.
        if (!result)
            await captureSessionClioQuery(options, input, undefined, genuineUserQueryText);
        if (accepted && input.propagateDeliveryFailure) {
            start.fail(error);
            throw error;
        }
        return handleDeliveryFailure(error, accepted, start);
    }
}
async function repairDuplicateMessage(options, input, result) {
    if (result.reason !== 'duplicate' || !shouldProjectMessage(input))
        return;
    const stableQueryKey = await resolveQueryKeyForTurn(options, input.sessionId, result.turnId);
    await commitTurnMessages(options, input, result.turnId, stableQueryKey);
}
async function completeAcceptedDelivery(options, input, result, visibleQuery) {
    await input.onAccepted?.(result);
    const queryKey = await resolveQueryKey(options, input, visibleQuery);
    if (visibleQuery) {
        await commitTurnMessages(options, input, result.turnId, queryKey);
    }
    await startQueryCollapse(options, input.sessionId, result.turnId, queryKey);
    await input.beforeStart?.();
    await observeBeforeExecution(options, input, result.turnId);
}
/**
 * Records an accepted or failed submission before execution or projection.
 *
 * Queued/steering Queries are already admitted and are only bound on acceptance.
 * A rejected or throwing direct submission remains unbound; sealing preserves
 * it as unanswered without inventing consumption. Duplicate submissions skip
 * this helper entirely.
 */
async function captureSessionClioQuery(options, input, turnId, genuineUserQueryText) {
    const clio = options.sessionClio;
    if (!clio)
        return;
    if (input.admittedQueryId) {
        if (turnId) {
            await clio.bindTurn({
                sessionId: input.sessionId,
                turnId,
                queryIds: [input.admittedQueryId],
            });
        }
        return;
    }
    await clio.admitQuery({
        sessionId: input.sessionId,
        queryId: sessionClioDirectQueryId(turnId ?? input.requestedTurnId),
        genuineUserQueryText,
        originalInstructionText: input.input.text,
        source: input.provenance.source,
        occurredAtMs: input.submittedAtMs,
        ...(turnId ? { turnId } : {}),
    });
}
async function startQueryCollapse(options, sessionId, turnId, queryKey) {
    try {
        const state = await options.queryCollapse.start({
            sessionId,
            queryKey,
            currentTurnId: turnId,
        });
        writeQueryCollapseView(options.stream, state);
    }
    catch {
        // The accepted Turn and durable Message remain valid when the display sidecar is unavailable.
    }
}
async function resolveQueryKey(options, input, visibleQuery) {
    return resolveQueryKeyForTurn(options, input.sessionId, input.requestedTurnId, {
        reuseLatestVisibleQuery: shouldReuseLatestVisibleQuery(input, visibleQuery),
    });
}
function shouldReuseLatestVisibleQuery(input, visibleQuery) {
    if (visibleQuery)
        return false;
    return input.input.origin?.kind !== 'background-task-terminal';
}
async function resolveQueryKeyForTurn(options, sessionId, turnId, input) {
    try {
        return await options.queryCollapse.resolveQueryKey(sessionId, turnId, input);
    }
    catch {
        return queryCollapseQueryKey(turnId);
    }
}
function handleDeliveryFailure(error, accepted, start) {
    if (accepted) {
        start.fail(error);
        return accepted;
    }
    start.release();
    if (error instanceof UserMessageCommitAdmissionError) {
        return { accepted: false, reason: error.reason };
    }
    if (error instanceof UserMessageCommitConflictError) {
        return { accepted: false, reason: 'ingress-conflict' };
    }
    throw error;
}
async function commitTurnMessages(options, input, turnId, queryKey) {
    if (!input.immediateSendBatch) {
        projectCommitted(options, await commitTurnMessage(options, input, turnId, queryKey));
        return;
    }
    for (const member of input.immediateSendBatch.members) {
        if (!shouldProjectMessage(member.message))
            continue;
        const commit = await commitMessage(options, {
            sessionId: input.sessionId,
            turnId,
            queryKey,
            unstartedFromTurnIds: [
                ...(input.unstartedFromTurnIds ?? []),
                ...(member.unstartedFromTurnIds ?? []),
            ],
            messageKey: member.messageKey,
            userMessageId: member.userMessageId,
            content: projectedMessageContent(member.message, member.message.content),
            inputContent: member.message.content,
            timestamp: member.createdAt,
            ...(member.unconsumedFromTurnIds
                ? { unconsumedFromTurnIds: member.unconsumedFromTurnIds }
                : {}),
            attachments: member.message.displayAttachments ??
                member.message.attachments.map((attachment) => ({ ...attachment })),
            ...(member.sourceMessageId ? { sourceMessageId: member.sourceMessageId } : {}),
            provenance: member.provenance,
        });
        projectCommitted(options, commit);
    }
}
async function commitTurnMessage(options, input, turnId, queryKey) {
    const attachments = deliveryAttachments(input, input.input.attachments);
    return commitMessage(options, {
        sessionId: input.sessionId,
        turnId,
        unstartedFromTurnIds: input.unstartedFromTurnIds,
        messageKey: input.messageKey ?? `turn:${turnId}`,
        ...(input.userMessageId ? { userMessageId: input.userMessageId } : {}),
        content: projectedMessageContent(input, input.input.text),
        inputContent: input.input.text,
        ...(queryKey ? { queryKey } : {}),
        ...(attachments ? { attachments } : {}),
        ...(input.sourceMessageId ? { sourceMessageId: input.sourceMessageId } : {}),
        ...(input.clientIntent ? { clientIntent: input.clientIntent } : {}),
        provenance: input.provenance,
        ...(input.createdAt !== undefined ? { timestamp: input.createdAt } : {}),
    });
}
function commitMessage(options, input) {
    const context = sourceContext(input.provenance);
    const editContent = input.inputContent !== input.content && parsePluginMentions(input.inputContent).length > 0
        ? { editContent: input.inputContent }
        : {};
    return retryUserMessageCommit(() => options.messages.commit({
        sessionId: input.sessionId,
        turnId: input.turnId,
        unstartedFromTurnIds: input.unstartedFromTurnIds,
        messageKey: input.messageKey,
        ...(input.userMessageId ? { userMessageId: input.userMessageId } : {}),
        content: input.content,
        ...editContent,
        ...(input.timestamp !== undefined ? { timestamp: input.timestamp } : {}),
        ...(input.unconsumedFromTurnIds
            ? { unconsumedFromTurnIds: input.unconsumedFromTurnIds }
            : {}),
        ...(input.kind ? { kind: input.kind } : {}),
        ...(input.queryKey ? { queryKey: input.queryKey } : {}),
        ...(input.attachments ? { attachments: input.attachments } : {}),
        ...(input.sourceMessageId ? { sourceMessageId: input.sourceMessageId } : {}),
        source: input.clientIntent === 'cloud-handoff' ? 'cloud_session_handoff' : input.provenance.source,
        ...(context ? { sourceContext: context } : {}),
    }));
}
export function shouldProjectMessage(input) {
    if (!input)
        return true;
    return input.hideUserMessage !== true || hasDisplayContent(input);
}
export function projectedMessageContent(input, fallback) {
    return hasDisplayContent(input) ? input.displayContent : fallback;
}
function hasDisplayContent(input) {
    return typeof input?.displayContent === 'string' && input.displayContent.length > 0;
}
function deliveryAttachments(delivery, execution) {
    const attachments = delivery?.displayAttachments ?? execution;
    return attachments?.map((attachment) => ({ ...attachment }));
}
function sourceContext(provenance) {
    const context = provenance.sourceContext;
    if (!context)
        return undefined;
    const { channelContext: nested, ...outer } = context;
    return nested && typeof nested === 'object' && !Array.isArray(nested)
        ? { ...outer, ...nested }
        : { ...context };
}
function projectCommitted(options, commit) {
    publish(options, commit);
}
function publish(options, commit) {
    try {
        options.stream.write({
            identity: `message:${commit.message.msg_id}`,
            sessionId: commit.sessionId,
            turnId: commit.turnId,
            kind: 'message-committed',
            data: { messages: [commit.message] },
        });
    }
    catch {
        // Durable Message commit is authoritative; resume replays it if live publication fails.
    }
}
async function observeBeforeExecution(options, input, turnId) {
    try {
        await options.beforeExecution?.({
            sessionId: input.sessionId,
            turnId,
            provenance: input.provenance,
        });
    }
    catch {
        // Product feedback such as Channel typing must not fail an accepted Turn.
    }
}
function createStartFence() {
    let resolveStart;
    let rejectStart;
    let settled = false;
    return {
        promise: new Promise((resolve, reject) => {
            resolveStart = resolve;
            rejectStart = reject;
        }),
        release: () => {
            if (settled)
                return;
            settled = true;
            resolveStart?.();
        },
        fail: (error) => {
            if (settled)
                return;
            settled = true;
            rejectStart?.(error);
        },
    };
}
//# sourceMappingURL=user-message-turn-delivery.js.map