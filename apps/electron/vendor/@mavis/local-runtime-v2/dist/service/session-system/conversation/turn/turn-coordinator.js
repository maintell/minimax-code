import { SessionTurnStream, } from './turn-stream.js';
export class SessionTurnCoordinator {
    options;
    activeTurns = new Map();
    startingSessions = new Set();
    admissionOperationTails = new Map();
    resumeWaitMs;
    resumePollMs;
    constructor(options) {
        this.options = options;
        this.resumeWaitMs = options.resumeWaitMs ?? 250;
        this.resumePollMs = options.resumePollMs ?? 10;
    }
    isBusy(sessionId) {
        return this.activeTurns.has(sessionId) || this.startingSessions.has(sessionId);
    }
    has(sessionId) {
        return this.isBusy(sessionId);
    }
    get(sessionId) {
        return this.activeTurns.get(sessionId);
    }
    isCurrent(turn) {
        return this.activeTurns.get(turn.sessionId) === turn;
    }
    async submit(input) {
        if (this.isBusy(input.sessionId))
            return { ok: false, reason: 'local-busy' };
        this.startingSessions.add(input.sessionId);
        try {
            return await this.withAdmissionOperation(input.sessionId, async () => {
                const releaseLock = await this.options.acquireLock(input.sessionId);
                if (!releaseLock)
                    return { ok: false, reason: 'owned-by-other-process' };
                const stream = new SessionTurnStream(input.turnId);
                const controller = new AbortController();
                let releasePromise;
                const turn = {
                    sessionId: input.sessionId,
                    turnId: input.turnId,
                    controller,
                    signal: controller.signal,
                    stream,
                    write: (frame) => stream.write(frame),
                    writeJson: (value) => stream.write({ data: JSON.stringify(value) }),
                    checkpoint: () => stream.checkpoint(),
                    forceCleared: false,
                    release: () => {
                        releasePromise ??= releaseLock();
                        return releasePromise;
                    },
                };
                this.activeTurns.set(input.sessionId, turn);
                return { ok: true, turn };
            });
        }
        finally {
            this.startingSessions.delete(input.sessionId);
        }
    }
    async finish(turn) {
        const record = turn;
        record.stream.complete();
        try {
            await record.release();
        }
        finally {
            if (this.activeTurns.get(record.sessionId) === record) {
                this.activeTurns.delete(record.sessionId);
            }
        }
    }
    async forceFinish(turn) {
        turn.forceCleared = true;
        await this.finish(turn);
    }
    abortActive(sessionId, reason) {
        const turn = this.activeTurns.get(sessionId);
        turn?.controller.abort(reason);
        return turn;
    }
    async abort(sessionId, expectedTurnId, reason, onAccepted) {
        return this.withAdmissionOperation(sessionId, async () => {
            const activeTurn = this.activeTurns.get(sessionId);
            if (activeTurn) {
                if (expectedTurnId && expectedTurnId !== activeTurn.turnId) {
                    return { ok: false, reason: 'turn-mismatch' };
                }
                activeTurn.controller.abort(reason);
                await onAccepted?.(activeTurn);
                return { ok: true, turn: activeTurn };
            }
            const releaseLock = await this.options.acquireLock(sessionId);
            if (!releaseLock)
                return { ok: false, reason: 'owned-by-other-process' };
            try {
                await onAccepted?.(undefined);
            }
            finally {
                await releaseLock();
            }
            return { ok: true };
        });
    }
    async resume(input) {
        let activeTurn;
        const available = await this.withAdmissionOperation(input.sessionId, async () => {
            activeTurn = this.activeTurns.get(input.sessionId);
            if (activeTurn)
                return true;
            const releaseLock = await this.options.acquireLock(input.sessionId);
            if (!releaseLock)
                return false;
            await releaseLock();
            return true;
        });
        if (!available)
            return { ok: false, reason: 'owned-by-other-process' };
        if (!activeTurn && input.waitForActiveTurn) {
            activeTurn = await this.waitForActiveTurn(input.sessionId);
        }
        if (activeTurn) {
            const anchor = await this.activeAnchor(input);
            return {
                ok: true,
                frames: activeTurn.stream.open(anchor, {
                    ...(input.subscriberKey ? { subscriberKey: input.subscriberKey } : {}),
                }),
            };
        }
        return { ok: true, frames: await this.idleFrames(input) };
    }
    async activeAnchor(input) {
        if (input.afterCursor) {
            return { kind: 'cursor', afterCursor: input.afterCursor };
        }
        const afterMessageId = input.afterMessageId;
        if (!afterMessageId)
            return undefined;
        const replay = await this.options.loadPersistedAfter(input.sessionId, afterMessageId);
        return {
            kind: 'message',
            afterMessageId,
            existsInHistory: replay.anchorFound,
        };
    }
    async idleFrames(input) {
        if (!input.afterMessageId)
            return completedFrames([]);
        const replay = await this.options.loadPersistedAfter(input.sessionId, input.afterMessageId);
        if (!replay.anchorFound)
            return completedFrames([{ kind: 'resume-overflow' }]);
        return completedFrames(replay.frames.map((frame) => ({ kind: 'data', data: frame.data })));
    }
    async waitForActiveTurn(sessionId) {
        const deadline = Date.now() + this.resumeWaitMs;
        while (Date.now() < deadline) {
            const activeTurn = this.activeTurns.get(sessionId);
            if (activeTurn)
                return activeTurn;
            await new Promise((resolve) => setTimeout(resolve, this.resumePollMs));
        }
        return this.activeTurns.get(sessionId);
    }
    async withAdmissionOperation(sessionId, operation) {
        const previous = this.admissionOperationTails.get(sessionId);
        let release;
        const current = new Promise((resolve) => {
            release = resolve;
        });
        this.admissionOperationTails.set(sessionId, current);
        if (previous)
            await previous;
        try {
            return await operation();
        }
        finally {
            if (this.admissionOperationTails.get(sessionId) === current) {
                this.admissionOperationTails.delete(sessionId);
            }
            release();
        }
    }
}
async function* completedFrames(middle) {
    yield { kind: 'heartbeat' };
    yield* middle;
    yield { kind: 'done' };
}
//# sourceMappingURL=turn-coordinator.js.map