import { digestSafetyInput } from '../../content-safety/index.js';
import { isUserAuthoredSource, isUserAuthoredTurnSource } from './message-query-authorship.js';
export function digestTurnInput(input, clientIntent) {
    const identity = clientIntent === undefined ? input : { input, clientIntent };
    return digestSafetyInput(identity);
}
export function admissionInput(input, values) {
    const base = admissionBase(input, values);
    if (isQueueSubmission(input)) {
        return {
            ...base,
            priority: queueAdmissionPriority(input, values.candidateCreatedAtMs),
            queueIngress: input.ingress,
            ...(input.ingress.clientRequestId ? { clientRequestId: input.ingress.clientRequestId } : {}),
            ...(input.ingress.clientRequestId && input.ingress.receiptAliases?.length
                ? { receiptAliases: input.ingress.receiptAliases }
                : {}),
        };
    }
    return {
        ...base,
        priority: directAdmissionPriority(input, values.candidateCreatedAtMs),
        ...(input.resume ? { userInputResume: input.resume } : {}),
        ...(input.clientRequestId ? { clientRequestId: input.clientRequestId } : {}),
        ...(input.clientRequestId && input.receiptAliases?.length
            ? { receiptAliases: input.receiptAliases }
            : {}),
    };
}
function admissionBase(input, values) {
    const foreground = isForegroundTurn(input);
    return {
        sessionId: input.sessionId,
        turnId: values.turnId,
        busyReason: 'turn',
        inputDigest: digestTurnInput(input.input, input.clientIntent),
        inputMetadata: {
            ...metadata(input.input),
            source: isQueueSubmission(input) ? input.ingress.provenance.source : input.provenance.source,
        },
        candidateCreatedAtMs: values.candidateCreatedAtMs,
        ...genuineUserAdmission(input),
        ...(foreground ? { foreground: true } : {}),
        ...(consumesQueuePause(input, foreground) ? { consumeQueuePause: true } : {}),
        ...(input.clientIntent ? { clientIntent: input.clientIntent } : {}),
        ...(values.bypassPriorityFence ? { bypassPriorityFence: true } : {}),
        ...(values.bypassSessionMutation ? { bypassSessionMutation: true } : {}),
    };
}
function queueAdmissionPriority(input, candidateCreatedAtMs) {
    if (input.queueSelection === 'exact') {
        return { kind: 'selected-queue-item', queueClaimId: input.ingress.claimId };
    }
    // An exact claim already bypasses queue order, so the yield only has to reach
    // the two fenced selections.
    const yielded = input.yieldedQueueItemIds && input.yieldedQueueItemIds.length > 0
        ? { yieldedQueueItemIds: input.yieldedQueueItemIds }
        : {};
    if (input.queueSelection === 'continued-fifo') {
        return { kind: 'continued-queue-head', queueClaimId: input.ingress.claimId, ...yielded };
    }
    return { kind: 'fifo', candidateCreatedAtMs, queueClaimId: input.ingress.claimId, ...yielded };
}
function directAdmissionPriority(input, candidateCreatedAtMs) {
    if (input.admissionPriority)
        return input.admissionPriority;
    if (isPausedQueueSend(input.clientIntent))
        return { kind: 'paused-queue-send' };
    return { kind: 'fifo', candidateCreatedAtMs };
}
function consumesQueuePause(input, foreground) {
    if (isQueueSubmission(input))
        return input.queueSelection === 'continued-fifo';
    return (foreground &&
        input.clientIntent !== 'retry-continuation' &&
        input.clientIntent !== 'cloud-handoff');
}
function isForegroundTurn(input) {
    if (!isQueueSubmission(input)) {
        if (input.executionMode === 'continuation')
            return true;
        if (input.resume)
            return false;
        if (isPausedQueueSend(input.clientIntent))
            return true;
    }
    return isUserAuthoredTurnSource(submissionProvenance(input).source);
}
function isPausedQueueSend(clientIntent) {
    return clientIntent === 'paused-queue-keep' || clientIntent === 'paused-queue-clear';
}
function genuineUserAdmission(input) {
    return isGenuineUserMessage(input) ? { genuineUserMessage: true } : {};
}
function isGenuineUserMessage(input) {
    if (input.genuineUserQueryText.length > 0)
        return true;
    if (!input.input.attachments?.length)
        return false;
    const source = isQueueSubmission(input)
        ? input.ingress.provenance.source
        : input.provenance.source;
    return isUserAuthoredSource(source);
}
export function compactionAdmission(input, turnId, candidateCreatedAtMs) {
    return {
        sessionId: input.sessionId,
        turnId,
        busyReason: 'compaction',
        inputDigest: digestTurnInput({
            text: input.reason ?? '',
            origin: input.customInstructions ?? '',
        }),
        inputMetadata: { attachmentCount: 0, hasContent: Boolean(input.reason) },
        candidateCreatedAtMs,
        priority: { kind: 'fifo', candidateCreatedAtMs },
    };
}
export function compactionInput(lease, input) {
    return {
        lease,
        ...(input.reason ? { reason: input.reason } : {}),
        ...(input.customInstructions ? { customInstructions: input.customInstructions } : {}),
    };
}
export function hostRequest(input) {
    const common = commonHostRequest(input);
    if (isQueueSubmission(input)) {
        const userMessageId = queueUserMessageId(input);
        return {
            ...common,
            provenance: input.ingress.provenance,
            queueItemIds: [input.ingress.itemId],
            ...(input.ingress.clientRequestId ? { clientRequestId: input.ingress.clientRequestId } : {}),
            ...(userMessageId ? { userMessageId } : {}),
        };
    }
    return {
        ...common,
        provenance: input.provenance,
        ...(input.clientRequestId ? { clientRequestId: input.clientRequestId } : {}),
        ...(input.userMessageId ? { userMessageId: input.userMessageId } : {}),
        ...(input.executionMode ? { executionMode: input.executionMode } : {}),
        ...(input.continuationAfterFailedTurn ? { continuationAfterFailedTurn: true } : {}),
    };
}
function commonHostRequest(input) {
    return {
        input: input.input,
        ...(!isQueueSubmission(input) && input.outputContract
            ? { outputContract: input.outputContract }
            : {}),
        ...(!isQueueSubmission(input) && input.executionDeadlineAtMs !== undefined
            ? { executionDeadlineAtMs: input.executionDeadlineAtMs }
            : {}),
        ...(input.immediateSendBatch
            ? {
                immediateSendBatch: {
                    id: input.immediateSendBatch.id,
                    members: input.immediateSendBatch.members.map((member) => ({
                        input: {
                            text: member.message.content,
                            attachments: member.message.attachments,
                            ...(member.message.quotedMessage
                                ? { quotedMessage: member.message.quotedMessage }
                                : {}),
                        },
                        genuineUserQueryText: member.message.displayContent ?? member.message.content,
                        userMessageId: member.userMessageId,
                        messageKey: member.messageKey,
                        createdAt: member.createdAt,
                        provenance: member.provenance,
                    })),
                },
            }
            : {}),
        genuineUserQueryText: input.genuineUserQueryText,
        ...(input.inputSafetyDecision ? { inputSafetyDecision: input.inputSafetyDecision } : {}),
        ...(input.requiresInputReview ? { requiresInputReview: true } : {}),
        ...(input.clientIntent ? { clientIntent: input.clientIntent } : {}),
    };
}
function queueUserMessageId(input) {
    if (input.userMessageId &&
        input.ingress.userMessageId &&
        input.userMessageId !== input.ingress.userMessageId) {
        throw new Error('Queue user message identity changed before AgentHost execution');
    }
    return input.userMessageId ?? input.ingress.userMessageId;
}
export function isQueueSubmission(input) {
    return 'ingress' in input;
}
export function submissionProvenance(input) {
    return isQueueSubmission(input) ? input.ingress.provenance : input.provenance;
}
function metadata(input) {
    return {
        attachmentCount: input.attachments?.length ?? 0,
        hasContent: input.text.length > 0,
    };
}
//# sourceMappingURL=turn-input-identity.js.map