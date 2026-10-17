import { randomBytes } from "node:crypto";
import { decodePptxCoreCreateSessionInputV1, PPTX_CORE_SESSION_SCHEMA_V1, PPTX_PREVIEW_LIMITS_VERSION_V1 } from "@mavis/shared/pptx-rendering";
import { safePreviewDiagnosticV1 } from "@mavis/shared/document-preview";
function failure(code, message) {
    return {
        ok: false,
        error: {
            schema: 'mavis.preview_error.v1',
            code,
            message: safePreviewDiagnosticV1(code, message),
            retryable: false,
        },
    };
}
export class PptxCoreSessionRegistry {
    constructor(sourceRegistry, options = {}) {
        this.sourceRegistry = sourceRegistry;
        this.sessions = new Map();
        this.activeBySource = new Map();
        this.pendingBySender = new Map();
        this.pendingCreates = new Set();
        this.pendingSessions = 0;
        this.shuttingDown = false;
        this.maxSessions = options.maxSessions ?? 64;
        this.maxSessionsPerSender = Math.min(options.maxSessionsPerSender ?? 8, this.maxSessions);
        this.onDiagnostic = options.onDiagnostic;
    }
    async create(senderId, input, ownerToken) {
        let request;
        try {
            request = decodePptxCoreCreateSessionInputV1(input);
        }
        catch {
            return failure('invalid_request', 'Invalid PPTX core session request');
        }
        if (!Number.isSafeInteger(senderId) || senderId < 0) {
            return failure('invalid_request', 'Invalid PPTX core session sender');
        }
        if (this.shuttingDown)
            return failure('cancelled', 'PPTX core session creation was cancelled');
        const activeKey = `${senderId}:${request.sourceId}`;
        if (this.activeBySource.has(activeKey)) {
            return failure('invalid_request', 'A PPTX core session already owns this source generation');
        }
        if (this.sessions.size + this.pendingSessions >= this.maxSessions ||
            [...this.sessions.values()].filter((entry) => entry.senderId === senderId).length +
                (this.pendingBySender.get(senderId) ?? 0) >=
                this.maxSessionsPerSender) {
            return failure('resource_limit_exceeded', 'PPTX core session limit reached');
        }
        const sourceGeneration = this.sourceRegistry.getSourceGeneration(senderId, request.sourceId, ownerToken);
        if (sourceGeneration === null) {
            return failure('source_not_found', 'PPTX core source was not found');
        }
        // Reserve before the asynchronous source revalidation so two concurrent
        // creates cannot both acquire the same source or overrun admission limits.
        this.activeBySource.set(activeKey, 'pending');
        this.pendingSessions += 1;
        this.pendingBySender.set(senderId, (this.pendingBySender.get(senderId) ?? 0) + 1);
        let resolveSettled;
        const pending = {
            senderId,
            sourceId: request.sourceId,
            ownerToken,
            cancelled: false,
            controller: new AbortController(),
            settled: new Promise((resolve) => {
                resolveSettled = resolve;
            }),
            resolveSettled: () => resolveSettled(),
        };
        this.pendingCreates.add(pending);
        let acquiredLease = null;
        let published = false;
        try {
            const sourceLease = await this.sourceRegistry.acquireOriginalSource(senderId, request.sourceId, sourceGeneration, ownerToken, pending.controller.signal);
            if (!sourceLease) {
                if (!pending.cancelled && !this.shuttingDown) {
                    this.emitIdentityDiagnostic(senderId, 'source-generation-mismatch');
                }
                return pending.cancelled || this.shuttingDown
                    ? failure('cancelled', 'PPTX core session creation was cancelled')
                    : failure('source_mutated', 'PPTX core source changed before binding');
            }
            acquiredLease = sourceLease;
            if (pending.cancelled || this.shuttingDown)
                return failure('cancelled', 'PPTX core session creation was cancelled');
            const coreSessionId = randomBytes(16).toString('hex');
            const descriptor = Object.freeze({
                schema: PPTX_CORE_SESSION_SCHEMA_V1,
                coreSessionId,
                sourceId: request.sourceId,
                sourceGeneration,
                sourceSha256: sourceLease.sourceSha256,
                sourceSizeBytes: sourceLease.sourceSizeBytes,
                nonce: randomBytes(16).toString('hex'),
                limitsVersion: PPTX_PREVIEW_LIMITS_VERSION_V1,
            });
            this.sessions.set(coreSessionId, {
                senderId,
                ownerToken,
                descriptor,
                state: 'created',
                controller: new AbortController(),
                sourceLease,
            });
            this.activeBySource.set(activeKey, coreSessionId);
            published = true;
            return { ok: true, value: descriptor };
        }
        finally {
            if (acquiredLease && !published)
                await acquiredLease.release().catch(() => undefined);
            this.pendingCreates.delete(pending);
            pending.resolveSettled();
            this.pendingSessions -= 1;
            const pendingForSender = (this.pendingBySender.get(senderId) ?? 1) - 1;
            if (pendingForSender === 0)
                this.pendingBySender.delete(senderId);
            else
                this.pendingBySender.set(senderId, pendingForSender);
            if (this.activeBySource.get(activeKey) === 'pending')
                this.activeBySource.delete(activeKey);
        }
    }
    bind(senderId, coreSessionId, nonce, port, ownerToken) {
        const entry = this.sessions.get(coreSessionId);
        if (!entry ||
            entry.senderId !== senderId ||
            entry.ownerToken !== ownerToken ||
            entry.descriptor.nonce !== nonce ||
            entry.state !== 'created') {
            this.emitIdentityDiagnostic(senderId, 'session-binding-invalid');
            try {
                port.close();
            }
            catch {
                // Forged and duplicate ports are discarded without affecting a live session.
            }
            return failure('invalid_request', 'PPTX core session binding is invalid');
        }
        entry.state = 'bound';
        entry.port = port;
        const transition = (from, to) => {
            if (entry.state !== from || this.sessions.get(coreSessionId) !== entry)
                return false;
            entry.state = to;
            return true;
        };
        return {
            ok: true,
            value: Object.freeze({
                descriptor: entry.descriptor,
                controller: entry.controller,
                sourceLease: entry.sourceLease,
                port,
                markStreaming: () => transition('bound', 'streaming'),
                markReady: () => transition('streaming', 'ready'),
                terminate: () => this.releaseEntry(entry),
            }),
        };
    }
    async cancel(senderId, coreSessionId, nonce, ownerToken) {
        const entry = this.sessions.get(coreSessionId);
        if (!entry ||
            entry.senderId !== senderId ||
            entry.ownerToken !== ownerToken ||
            entry.descriptor.nonce !== nonce) {
            this.emitIdentityDiagnostic(senderId, 'session-cancellation-invalid');
            return failure('invalid_request', 'PPTX core session cancellation is invalid');
        }
        await this.releaseEntry(entry);
        return { ok: true, value: null };
    }
    async releaseSource(senderId, sourceId, ownerToken) {
        const pending = [...this.pendingCreates].filter((entry) => entry.senderId === senderId &&
            entry.ownerToken === ownerToken &&
            entry.sourceId === sourceId);
        for (const entry of pending) {
            entry.cancelled = true;
            entry.controller.abort();
        }
        await Promise.all([
            ...[...this.sessions.values()]
                .filter((entry) => entry.senderId === senderId &&
                entry.ownerToken === ownerToken &&
                entry.descriptor.sourceId === sourceId)
                .map((entry) => this.releaseEntry(entry)),
            ...pending.map((entry) => entry.settled),
        ]);
    }
    async releaseSender(senderId, ownerToken) {
        const pending = [...this.pendingCreates].filter((entry) => entry.senderId === senderId && entry.ownerToken === ownerToken);
        for (const entry of pending) {
            entry.cancelled = true;
            entry.controller.abort();
        }
        await Promise.all([
            ...[...this.sessions.values()]
                .filter((entry) => entry.senderId === senderId && entry.ownerToken === ownerToken)
                .map((entry) => this.releaseEntry(entry)),
            ...pending.map((entry) => entry.settled),
        ]);
    }
    async shutdown() {
        this.shuttingDown = true;
        const pending = [...this.pendingCreates];
        for (const entry of pending) {
            entry.cancelled = true;
            entry.controller.abort();
        }
        await Promise.all([
            ...[...this.sessions.values()].map((entry) => this.releaseEntry(entry)),
            ...pending.map((entry) => entry.settled),
        ]);
        await Promise.all([...this.sessions.values()].map((entry) => this.releaseEntry(entry)));
    }
    activeCount() {
        return this.sessions.size;
    }
    emitIdentityDiagnostic(senderId, reason) {
        try {
            this.onDiagnostic?.(Object.freeze({
                code: 'PPTX-S08-SESSION-IDENTITY-INVALID',
                stage: 'S08',
                disposition: 'deck-terminal',
                senderId,
                reason,
            }));
        }
        catch {
            // Diagnostics are observability-only and cannot alter authority cleanup.
        }
    }
    releaseEntry(entry) {
        if (entry.releasePromise)
            return entry.releasePromise;
        entry.state = 'terminal';
        entry.controller.abort();
        this.sessions.delete(entry.descriptor.coreSessionId);
        this.activeBySource.delete(`${entry.senderId}:${entry.descriptor.sourceId}`);
        entry.releasePromise = (async () => {
            try {
                entry.port?.removeAllListeners();
            }
            catch {
                // Stop accepting data-plane events before closing the source handle.
            }
            await entry.sourceLease.release().catch(() => undefined);
            try {
                entry.port?.close();
            }
            catch {
                // Port teardown is idempotent and best effort.
            }
            entry.port = undefined;
        })();
        return entry.releasePromise;
    }
}

