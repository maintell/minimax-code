/**
 * Durable line marker written only after a historical Agent root is verified
 * against an adopted IM credential route. It lets Project queries surface the
 * one trusted legacy root without treating every Agent root as a project task.
 */
export const TRUSTED_LEGACY_IM_ROOT_PURPOSE_MARKER = '[mavis:trusted-legacy-im-root]';
/** Prevent an empty Task override from changing the Runtime default selection semantics. */
export function hasConversationTaskModelSelection(selection) {
    return selection?.model !== undefined || selection?.effort !== undefined;
}
export const SESSION_TITLE_MAX_UNICODE_LENGTH = 50;
/** Normalizes user-supplied Session titles to the same boundary as generated titles. */
export function normalizeConversationSessionTitle(input) {
    if (typeof input !== 'string')
        return undefined;
    const title = input.replace(/\s+/gu, ' ').trim();
    return title && Array.from(title).length <= SESSION_TITLE_MAX_UNICODE_LENGTH ? title : undefined;
}
export class ConversationTurnRejectedError extends Error {
    sessionId;
    reason;
    code = 'CONVERSATION_TURN_REJECTED';
    constructor(sessionId, reason) {
        super(`Conversation Turn was rejected for ${sessionId}: ${reason}`);
        this.sessionId = sessionId;
        this.reason = reason;
        this.name = 'ConversationTurnRejectedError';
    }
}
export const RUNTIME_CONVERSATION_UNAVAILABLE_CODE = 'RUNTIME_CONVERSATION_UNAVAILABLE';
export const RUNTIME_CONVERSATION_SHUTDOWN_CODE = 'RUNTIME_CONVERSATION_SHUTDOWN';
export class RuntimeConversationUnavailableError extends Error {
    code = RUNTIME_CONVERSATION_UNAVAILABLE_CODE;
    originalError;
    constructor(message = 'Runtime conversation is unavailable.', options) {
        super(message);
        this.name = 'RuntimeConversationUnavailableError';
        if (options && 'cause' in options)
            this.originalError = options.cause;
    }
}
export class RuntimeConversationShutdownError extends Error {
    code = RUNTIME_CONVERSATION_SHUTDOWN_CODE;
    originalError;
    constructor(message = 'Runtime conversation is shutting down.', options) {
        super(message);
        this.name = 'RuntimeConversationShutdownError';
        if (options && 'cause' in options)
            this.originalError = options.cause;
    }
}
export function isRuntimeConversationUnavailableError(error) {
    return hasRuntimeConversationCode(error, RUNTIME_CONVERSATION_UNAVAILABLE_CODE);
}
export function isRuntimeConversationShutdownError(error) {
    return hasRuntimeConversationCode(error, RUNTIME_CONVERSATION_SHUTDOWN_CODE);
}
export class DeferredRuntimeConversation {
    readiness;
    resolveReady;
    rejectReady;
    bound;
    terminalError;
    settled = false;
    query = {
        getSession: (sessionId) => this.use((conversation) => conversation.query.getSession(sessionId)),
        listSessions: (options) => this.use((conversation) => conversation.query.listSessions(options)),
        listMessages: (sessionId, options) => this.use((conversation) => conversation.query.listMessages(sessionId, options)),
    };
    lifecycle = {
        createSession: (input) => this.use((conversation) => conversation.lifecycle.createSession(input)),
        createRootSession: (input) => this.use((conversation) => conversation.lifecycle.createRootSession(input)),
        replaceRootSession: (agentName, sessionId) => this.use((conversation) => conversation.lifecycle.replaceRootSession(agentName, sessionId)),
        updateSession: (sessionId, fields) => this.use((conversation) => conversation.lifecycle.updateSession(sessionId, fields)),
        deleteSession: (sessionId) => this.use((conversation) => conversation.lifecycle.deleteSession(sessionId)),
    };
    ingress = {
        submit: (input) => this.use((conversation) => conversation.ingress.submit(input)),
        resumeUserInput: (input) => this.use((conversation) => conversation.ingress.resumeUserInput(input)),
        steer: (input) => this.use((conversation) => conversation.ingress.steer(input)),
        listQueued: (sessionId) => this.use((conversation) => conversation.ingress.listQueued(sessionId)),
        findQueuedByClientRequestId: (sessionId, clientRequestId) => this.use((conversation) => conversation.ingress.findQueuedByClientRequestId(sessionId, clientRequestId)),
        updateQueued: (sessionId, itemId, update) => this.use((conversation) => conversation.ingress.updateQueued(sessionId, itemId, update)),
        promoteQueuedSource: (sessionId, itemId, source) => this.use((conversation) => conversation.ingress.promoteQueuedSource(sessionId, itemId, source)),
        cancelQueued: (sessionId, itemId) => this.use((conversation) => conversation.ingress.cancelQueued(sessionId, itemId)),
        reorderQueued: (sessionId, itemIds) => this.use((conversation) => conversation.ingress.reorderQueued(sessionId, itemIds)),
        abort: (sessionId, reason, turnId) => this.use((conversation) => conversation.ingress.abort(sessionId, reason, turnId)),
        dispatchQueue: (sessionId) => this.use((conversation) => conversation.ingress.dispatchQueue(sessionId)),
    };
    maintenance = {
        compact: (input) => this.use((conversation) => conversation.maintenance.compact(input)),
    };
    constructor() {
        this.readiness = new Promise((resolve, reject) => {
            this.resolveReady = resolve;
            this.rejectReady = reject;
        });
        void this.readiness.catch(() => undefined);
    }
    bind(conversation) {
        if (this.settled)
            throw new Error('Runtime conversation binding is already settled.');
        this.settled = true;
        this.bound = conversation;
        this.resolveReady(conversation);
    }
    fail(error) {
        if (this.settled)
            return;
        this.settled = true;
        this.terminalError = normalizeUnavailableError(error);
        this.rejectReady(this.terminalError);
    }
    shutdown(error) {
        if (isRuntimeConversationShutdownError(this.terminalError))
            return;
        const normalized = normalizeShutdownError(error);
        this.terminalError = normalized;
        this.bound = undefined;
        if (!this.settled) {
            this.settled = true;
            this.rejectReady(normalized);
        }
    }
    async use(operation) {
        if (this.terminalError)
            throw this.terminalError;
        const conversation = this.bound ?? (await this.readiness);
        if (this.terminalError)
            throw this.terminalError;
        return operation(conversation);
    }
}
function normalizeUnavailableError(error) {
    if (isRuntimeConversationUnavailableError(error) || isRuntimeConversationShutdownError(error)) {
        return error;
    }
    const message = error instanceof Error ? error.message : String(error);
    return new RuntimeConversationUnavailableError(message, { cause: error });
}
function normalizeShutdownError(error) {
    if (error instanceof RuntimeConversationShutdownError)
        return error;
    const message = error instanceof Error ? error.message : undefined;
    return new RuntimeConversationShutdownError(message, { cause: error });
}
function hasRuntimeConversationCode(error, code) {
    return typeof error === 'object' && error !== null && Reflect.get(error, 'code') === code;
}
//# sourceMappingURL=index.js.map