/** Signals that the enclosing model call must be rebuilt from builtin prompts. */
export class PromptSnapshotInvalidError extends Error {
    name = 'PromptSnapshotInvalidError';
    constructor(message = 'Prompt snapshot is invalid') {
        super(message);
    }
}
export function isPromptSnapshotInvalidError(error) {
    return error instanceof PromptSnapshotInvalidError;
}
export class BoundedInternalTurnPromptReadRegistry {
    capacity;
    entries = new Map();
    reservations = new Set();
    closed = false;
    constructor(capacity = 128) {
        this.capacity = capacity;
    }
    reserve(turnId) {
        if (this.closed || this.entries.has(turnId) || this.reservations.has(turnId))
            return false;
        if (this.entries.size + this.reservations.size >= this.capacity)
            return false;
        this.reservations.add(turnId);
        return true;
    }
    remember(turnId, promptRead) {
        if (this.closed || !this.reservations.delete(turnId))
            return;
        this.entries.set(turnId, promptRead);
    }
    rebind(fromTurnId, toTurnId) {
        if (this.closed)
            return false;
        const promptRead = this.entries.get(fromTurnId);
        if (!promptRead)
            return false;
        if (fromTurnId === toTurnId)
            return true;
        if (this.entries.has(toTurnId) || this.reservations.has(toTurnId))
            return false;
        this.entries.delete(fromTurnId);
        this.entries.set(toTurnId, promptRead);
        return true;
    }
    take(turnId) {
        const promptRead = this.entries.get(turnId);
        this.entries.delete(turnId);
        this.reservations.delete(turnId);
        return promptRead;
    }
    discard(turnId) {
        this.reservations.delete(turnId);
        this.entries.delete(turnId);
    }
    close() {
        this.closed = true;
        this.entries.clear();
        this.reservations.clear();
    }
}
//# sourceMappingURL=prompt-read.js.map