/**
 * Correlates product-owned user identities with Pi's next user-message deltas.
 * Identity stays parallel to Pi payloads and assignments remain stable across
 * History operation replay.
 */
export class CanonicalUserMessageIdentityLane {
    initialBatch;
    pending = [];
    known = new Set();
    assignments = new Map();
    replacementAssignments = new Map();
    primaryUserMessageId;
    nextPendingIndex = 0;
    primaryClaimCount = 0;
    primaryReplayPending = [];
    primaryMessageIds;
    constructor(primaryUserMessageId, initialBatch) {
        this.initialBatch = initialBatch;
        this.primaryUserMessageId = initialBatch?.messageIds[0] ?? primaryUserMessageId;
        this.primaryMessageIds =
            initialBatch?.messageIds ?? (primaryUserMessageId ? [primaryUserMessageId] : []);
        this.register(this.primaryMessageIds, initialBatch?.id);
    }
    register(messageIds, batchId) {
        for (const messageId of messageIds) {
            if (this.known.has(messageId)) {
                throw new TypeError(`Canonical user message identity is duplicated: ${messageId}`);
            }
            this.known.add(messageId);
            this.pending.push({ messageId, ...(batchId ? { batchId } : {}) });
        }
    }
    /**
     * Restores the initial logical input identities after output recall
     * durably removed the rejected attempt from canonical history.
     */
    rearmPrimaryAfterOutputRecall() {
        if (!this.primaryUserMessageId ||
            this.primaryClaimCount === 0 ||
            this.primaryReplayPending.length > 0) {
            return;
        }
        this.primaryReplayPending = [...this.primaryMessageIds];
    }
    decorate(change, current) {
        if (change.identityHints !== undefined) {
            throw new TypeError('Runtime History changes cannot supply canonical identity hints.');
        }
        if (change.reason !== 'messageDelta')
            return this.decorateReplacement(change, current);
        const cached = this.assignments.get(change.operation.id);
        const identityHints = cached ?? this.claim(change);
        if (!cached)
            this.assignments.set(change.operation.id, identityHints);
        return identityHints.length > 0 ? { ...change, identityHints } : change;
    }
    decorateReplacement(change, current) {
        if (change.operation.kind === 'compaction' || change.replacementEntries)
            return change;
        const sourceIndexes = change.metadata?.replacementSourceIndexes;
        if (sourceIndexes === undefined)
            return change;
        const cached = this.replacementAssignments.get(change.operation.id);
        const replacementEntries = cached ?? this.planReplacement(change, current, sourceIndexes);
        if (!cached)
            this.replacementAssignments.set(change.operation.id, replacementEntries);
        return { ...change, replacementEntries };
    }
    planReplacement(change, current, sourceIndexes) {
        const previousMessages = change.previousMessages;
        const identityVector = current.identityVector;
        if (!previousMessages ||
            !identityVector ||
            identityVector.length !== current.messages.length ||
            sourceIndexes.length !== change.messages.length) {
            throw new TypeError('Canonical technical replacement lineage is incomplete.');
        }
        return change.messages.map((message, index) => {
            const sourceIndex = sourceIndexes[index];
            if (sourceIndex === undefined ||
                !Number.isSafeInteger(sourceIndex) ||
                sourceIndex < 0 ||
                sourceIndex >= previousMessages.length) {
                throw new TypeError('Canonical technical replacement source index is invalid.');
            }
            const preservedMessageId = identityVector[sourceIndex];
            if (preservedMessageId) {
                return {
                    message,
                    identity: { kind: 'preserve', messageId: preservedMessageId },
                };
            }
            const externalUserMessageId = message.role === 'user' ? this.claimNext(message) : undefined;
            return externalUserMessageId
                ? {
                    message,
                    identity: {
                        kind: 'external-user',
                        messageId: externalUserMessageId,
                    },
                }
                : {
                    message,
                    identity: {
                        kind: 'new',
                        seed: `technical:${change.operation.id}:${String(sourceIndex)}:${String(index)}`,
                    },
                };
        });
    }
    claim(change) {
        const userIndexes = change.messages.flatMap((message, index) => message.role === 'user' ? [index] : []);
        return userIndexes.flatMap((index) => {
            const messageId = this.claimNext(change.messages[index]);
            return messageId ? [{ index, messageId, source: 'display-user' }] : [];
        });
    }
    claimNext(message) {
        if (this.primaryReplayPending.length > 0) {
            if (!matchesBatch(message, this.initialBatch?.id))
                return undefined;
            this.primaryClaimCount += 1;
            return this.primaryReplayPending.shift();
        }
        const pending = this.pending[this.nextPendingIndex];
        if (!matchesBatch(message, pending?.batchId))
            return undefined;
        const messageId = pending?.messageId;
        if (messageId) {
            this.nextPendingIndex += 1;
            if (messageId === this.primaryUserMessageId)
                this.primaryClaimCount += 1;
        }
        return messageId;
    }
}
function matchesBatch(message, batchId) {
    if (!batchId)
        return true;
    const metadata = message && Reflect.get(message, 'hostMetadata');
    return !!metadata && Reflect.get(metadata, 'immediateSendBatchId') === batchId;
}
//# sourceMappingURL=canonical-user-message-identities.js.map