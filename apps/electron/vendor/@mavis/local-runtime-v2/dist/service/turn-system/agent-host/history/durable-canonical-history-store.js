import { KeyedOperationLane } from '@mavis/shared/keyed-operation-lane';
import { AgentHostDependencyUnavailableError, assertAgentHostCapabilityAvailable, } from '../empty-dependencies.js';
import { validateCanonicalHistoryChange, validateCanonicalHistorySessionId, validateCanonicalHistorySnapshot, } from './canonical-history-validation.js';
import { captureSemanticSnapshot } from './semantic-identity.js';
export { CanonicalHistoryValidationError } from './canonical-history-validation.js';
/**
 * Adds AgentHost ordering and validation around the Session-owned durable
 * history provider. The provider remains the sole owner of storage layout,
 * migration, checkpoints, and recovery.
 */
export class DurableCanonicalHistoryStore {
    provider;
    lane = new KeyedOperationLane();
    previousSnapshot;
    constructor(provider) {
        this.provider = provider;
        assertAgentHostCapabilityAvailable('canonical-history-provider', typeof provider?.read === 'function' &&
            typeof provider.readActive === 'function' &&
            typeof provider.append === 'function' &&
            typeof provider.replace === 'function');
    }
    read(sessionId) {
        validateCanonicalHistorySessionId(sessionId);
        return this.lane.run(sessionId, () => this.readCommitted(sessionId));
    }
    append(change) {
        return this.commit('append', change, (snapshot) => this.provider.append(snapshot));
    }
    replace(change) {
        return this.commit('replace', change, (snapshot) => this.provider.replace(snapshot));
    }
    compact(change) {
        return this.commit('replace', change, async (snapshot) => {
            if (!this.provider.compact)
                throw new Error('Typed canonical compaction is unavailable.');
            return this.provider.compact({
                ...snapshot,
                reason: 'replaceMessages',
                operation: {
                    id: snapshot.operation?.id ?? change.operation.id,
                    kind: 'compaction',
                },
            });
        });
    }
    settleTurnTail(mutation) {
        const snapshot = captureSemanticSnapshot(mutation).value;
        return this.mutateTurn(snapshot, () => {
            if (!this.provider.settleTurnTail) {
                throw new AgentHostDependencyUnavailableError('history-settle-turn-tail');
            }
            return this.provider.settleTurnTail(snapshot);
        });
    }
    retractTurn(mutation) {
        const snapshot = captureSemanticSnapshot(mutation).value;
        return this.mutateTurn(snapshot, () => {
            if (!this.provider.retractTurn) {
                throw new AgentHostDependencyUnavailableError('history-retract-turn');
            }
            return this.provider.retractTurn(snapshot);
        });
    }
    commit(kind, change, mutate) {
        const snapshot = captureSemanticSnapshot(change).value;
        validateCanonicalHistoryChange(snapshot, kind);
        return this.lane.run(snapshot.sessionId, async () => {
            const committed = await mutate(snapshot);
            // Session-owned providers already reread and validate inside their lane.
            // Legacy adapters returning void retain the strict post-write read.
            return committed === undefined
                ? this.readActiveCommitted(snapshot.sessionId)
                : this.readProviderSnapshot(committed);
        });
    }
    mutateTurn(mutation, mutate) {
        validateTurnMutation(mutation);
        return this.lane.run(mutation.sessionId, async () => {
            const committed = await mutate();
            const snapshot = this.readProviderSnapshot(committed);
            validateTurnMutationCommit(committed);
            return Object.freeze({
                ...snapshot,
                status: committed.status,
                deletedMessageIds: Object.freeze([...committed.deletedMessageIds]),
            });
        });
    }
    async readCommitted(sessionId) {
        return this.readProviderSnapshot(await this.provider.read(sessionId));
    }
    async readActiveCommitted(sessionId) {
        return this.readProviderSnapshot(await this.provider.readActive(sessionId));
    }
    readProviderSnapshot(snapshot) {
        const detached = captureSemanticSnapshot(snapshot, this.previousSnapshot).value;
        validateCanonicalHistorySnapshot(detached);
        assertCanonicalIdentityVector(detached);
        const result = captureSemanticSnapshot({
            revision: detached.revision.trim(),
            // Keep the separately owned arrays reusable at the next snapshot boundary.
            messages: captureSemanticSnapshot([...detached.messages]).value,
            identityVector: captureSemanticSnapshot([...detached.identityVector]).value,
        }).value;
        this.previousSnapshot = result;
        return result;
    }
}
function validateTurnMutation(mutation) {
    validateCanonicalHistorySessionId(mutation.sessionId);
    if (!mutation.turnId.trim() || !mutation.operation.id.trim()) {
        throw new TypeError('Turn history mutation identity is invalid.');
    }
    if (mutation.kind === 'settle-turn-tail') {
        validateSettlementMutation(mutation);
        return;
    }
    if (mutation.operation.kind !== expectedRetractionOperation(mutation)) {
        throw new TypeError('Turn history retraction operation is invalid.');
    }
}
function validateSettlementMutation(mutation) {
    const expected = mutation.mode === 'abort' ? 'abort-reconcile' : 'network-reconcile';
    const expectedVariant = mutation.mode === 'network' ? 'network' : undefined;
    if (mutation.operation.kind !== expected || mutation.operation.variant !== expectedVariant) {
        throw new TypeError('Turn history settlement operation is invalid.');
    }
}
function expectedRetractionOperation(mutation) {
    return mutation.reason.kind === 'input-safety-recall' ||
        mutation.reason.kind === 'output-final-recall'
        ? 'output-recall'
        : 'turn-retraction';
}
function validateTurnMutationCommit(commit) {
    if (commit.status !== 'committed' &&
        commit.status !== 'unchanged' &&
        commit.status !== 'already-retracted') {
        throw new TypeError('Turn history mutation status is invalid.');
    }
    if (!Array.isArray(commit.deletedMessageIds) ||
        commit.deletedMessageIds.some((messageId) => typeof messageId !== 'string' || !messageId.trim())) {
        throw new TypeError('Turn history mutation deleted identities are invalid.');
    }
}
function assertCanonicalIdentityVector(snapshot) {
    const identityVector = snapshot.identityVector;
    if (!Array.isArray(identityVector) ||
        identityVector.length !== snapshot.messages.length ||
        identityVector.some((messageId) => typeof messageId !== 'string' || !messageId.trim()) ||
        new Set(identityVector).size !== identityVector.length) {
        throw new TypeError('Canonical history identity vector is invalid.');
    }
}
//# sourceMappingURL=durable-canonical-history-store.js.map