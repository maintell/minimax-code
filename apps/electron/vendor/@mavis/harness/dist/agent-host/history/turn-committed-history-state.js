import { captureSemanticSnapshot } from './semantic-identity.js';
/**
 * Tracks only the latest committed snapshot and whether the current attempt
 * has durable canonical effects. It never treats the pre-Turn snapshot as a
 * writable rollback template.
 */
export class TurnCommittedHistoryState {
    current;
    currentIdentityVector;
    dirty = false;
    constructor(initial) {
        this.current = captureSemanticSnapshot(initial.messages).value;
        this.currentIdentityVector = initial.identityVector;
    }
    record(commit, retracted = false) {
        this.current = captureSemanticSnapshot(commit.messages).value;
        this.currentIdentityVector = commit.identityVector;
        this.dirty = !retracted;
    }
    get currentIdentityVectorValue() {
        return this.currentIdentityVector;
    }
    /** Canonical history committed so far during this turn. */
    get currentMessages() {
        return this.current;
    }
    get hasDurableChanges() {
        return this.dirty;
    }
}
//# sourceMappingURL=turn-committed-history-state.js.map