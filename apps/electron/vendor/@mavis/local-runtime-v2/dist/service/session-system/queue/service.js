import { QueueDataCorruptionError, QueueEnqueueAdmissionError } from './repo/contract.js';
import { isFutureQueueExpiry } from './policy.js';
export class QueueServiceError extends Error {
    reason;
    code;
    model;
    modelSource;
    constructor(reason, message, details = {}) {
        super(message);
        this.reason = reason;
        this.name = 'QueueServiceError';
        this.code = reason;
        this.model = details.model;
        this.modelSource = details.modelSource;
    }
}
export class QueueService {
    options;
    nowMs;
    constructor(options) {
        this.options = options;
        this.nowMs = options.nowMs ?? Date.now;
    }
    list(sessionId) {
        return this.useStore(() => this.options.store.list(sessionId));
    }
    listPendingSessionIds() {
        return this.options.store.listPendingSessionIds();
    }
    snapshot(sessionId) {
        return this.useStore(() => this.options.store.snapshot(sessionId));
    }
    continueQueue(sessionId, expectedPause) {
        return this.useStore(() => this.options.store.continueQueue(sessionId, expectedPause));
    }
    pauseIfPending(input) {
        return this.useStore(() => this.options.store.pauseIfPending(input));
    }
    findByClientRequestId(sessionId, clientRequestId) {
        return this.useStore(() => this.options.store.findByClientRequestId(sessionId, clientRequestId));
    }
    get(sessionId, itemId) {
        return this.useStore(() => this.options.store.get(sessionId, itemId));
    }
    enqueue(input) {
        this.assertFutureExpiry(input.expiresAt);
        return this.useStore(async () => {
            if (!this.options.resolveModel)
                return this.options.store.enqueue(input);
            const existing = input.clientRequestId
                ? await this.options.store.findByClientRequestId(input.session.sessionId, input.clientRequestId)
                : undefined;
            const model = existing?.value
                ? existing.value.model
                : await this.resolveModel(input.session.sessionId, input.model, input);
            const result = await this.options.store.enqueue({ ...input, model });
            return { value: result.value, facts: [...(existing?.facts ?? []), ...result.facts] };
        });
    }
    update(input) {
        this.assertFutureExpiry(input.expiresAt);
        return this.useStore(async () => {
            if (!this.options.resolveModel || input.model === undefined)
                return this.options.store.updateQueued(input);
            const model = await this.resolveModel(input.sessionId, input.model ?? undefined, undefined, true);
            return this.options.store.updateQueued({ ...input, model: model ?? null });
        });
    }
    promote(sessionId, itemId, source) {
        return this.useStore(() => this.options.store.promoteQueuedSource(sessionId, itemId, source));
    }
    cancel(sessionId, itemId) {
        return this.useStore(() => this.options.store.cancel(sessionId, itemId));
    }
    clearUserManageable(sessionId) {
        return this.useStore(() => this.options.store.clearUserManageable(sessionId));
    }
    reorder(input) {
        return this.useStore(() => this.options.store.reorder(input));
    }
    deleteSession(sessionId) {
        return this.useStore(() => this.options.store.deleteSession(sessionId));
    }
    async requireMutableSession(sessionId) {
        const session = await this.options.sessions.get(sessionId);
        if (!session) {
            throw new QueueServiceError('session-not-found', `Session not found: ${sessionId}`);
        }
        if (await this.options.isReadOnlySession?.(session)) {
            throw new QueueServiceError('read-only-session', `Session is read-only: ${sessionId}`);
        }
        if (session.runtime === 'opencode') {
            throw new QueueServiceError('runtime-unsupported', 'Queue operations are unavailable for opencode sessions');
        }
        return session;
    }
    async resolveModel(sessionId, model, input, explicitModelUpdate) {
        const session = await this.requireMutableSession(sessionId);
        return this.options.resolveModel?.(session, model, input, explicitModelUpdate);
    }
    async useStore(operation) {
        try {
            return await operation();
        }
        catch (error) {
            if (error instanceof QueueDataCorruptionError) {
                throw new QueueServiceError('data-corrupt', error.message);
            }
            if (error instanceof QueueEnqueueAdmissionError) {
                const reason = error.reason === 'session-not-found' ? 'session-not-found' : 'session-busy';
                throw new QueueServiceError(reason, `Queue enqueue rejected: ${error.sessionId}`);
            }
            throw error;
        }
    }
    assertFutureExpiry(expiresAt) {
        if (isFutureQueueExpiry(expiresAt, this.nowMs()))
            return;
        throw new QueueServiceError('expiry-invalid', 'Queue item expiresAt must be greater than the current time');
    }
}
//# sourceMappingURL=service.js.map