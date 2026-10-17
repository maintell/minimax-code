export function isAgentNotFoundError(error) {
    const candidate = Object(error);
    return candidate.status === 404 || candidate.code === 'AGENT_NOT_FOUND';
}
export class LocalAgentRuntimeUnavailableError extends Error {
    status = 503;
    code = 'AGENT_RUNTIME_UNAVAILABLE';
    constructor(operation) {
        super(`Agent runtime capability is not bound: ${operation}`);
        this.name = 'LocalAgentRuntimeUnavailableError';
    }
}
/** A direct-usage V1 host gets a deterministic 503 instead of a hidden writer. */
export function createFailClosedAgentRuntimePort() {
    const unavailable = (operation) => new LocalAgentRuntimeUnavailableError(operation);
    return {
        resolveAgentReadScope: async () => {
            throw unavailable('resolveAgentReadScope');
        },
        resolveAgentWriteTarget: async () => {
            throw unavailable('resolveAgentWriteTarget');
        },
        requireExactAgentKey: async () => {
            throw unavailable('requireExactAgentKey');
        },
        resolveAgentExecutionTarget: async () => {
            throw unavailable('resolveAgentExecutionTarget');
        },
        listAgents: async () => {
            throw unavailable('listAgents');
        },
        createAgent: async () => {
            throw unavailable('createAgent');
        },
        getAgent: async () => {
            throw unavailable('getAgent');
        },
        updateAgent: async () => {
            throw unavailable('updateAgent');
        },
        deleteAgent: async () => {
            throw unavailable('deleteAgent');
        },
        readCustomAgentAvatar: async () => {
            throw unavailable('readCustomAgentAvatar');
        },
        setMainSession: async () => {
            throw unavailable('setMainSession');
        },
        agentExists: async () => {
            throw unavailable('agentExists');
        },
        canDelegate: async () => {
            throw unavailable('canDelegate');
        },
        listLegacyPinnedAgentRefs: async () => {
            throw unavailable('listLegacyPinnedAgentRefs');
        },
        ensureBuiltinAgents: async () => {
            throw unavailable('ensureBuiltinAgents');
        },
        retryBuiltinGreetings: async () => {
            throw unavailable('retryBuiltinGreetings');
        },
        getAgentOwnerIdentity: async () => {
            throw unavailable('getAgentOwnerIdentity');
        },
        getSessionAgentRoutingSnapshot: async () => {
            throw unavailable('getSessionAgentRoutingSnapshot');
        },
        getSessionProjectIdentity: async () => {
            throw unavailable('getSessionProjectIdentity');
        },
    };
}
/**
 * Deferred bridge used by V2 runtime while the V1 host is being constructed.
 * Resolver calls are available immediately; management calls become usable
 * only after the Session/Application owner has completed `ready()`.
 */
export function createDeferredLocalAgentRuntimePort(resolver) {
    const failClosed = createFailClosedAgentRuntimePort();
    let currentResolver = resolver;
    let currentManagement;
    const management = () => currentManagement ?? failClosed;
    return {
        resolveAgentReadScope: (requestedName) => (currentResolver ?? failClosed).resolveAgentReadScope(requestedName),
        resolveAgentWriteTarget: (requestedName) => (currentResolver ?? failClosed).resolveAgentWriteTarget(requestedName),
        requireExactAgentKey: (requestedName) => (currentResolver ?? failClosed).requireExactAgentKey(requestedName),
        resolveAgentExecutionTarget: (exactOwnerName) => (currentResolver ?? failClosed).resolveAgentExecutionTarget(exactOwnerName),
        listAgents: (request) => management().listAgents(request),
        createAgent: (request) => management().createAgent(request),
        getAgent: (request) => management().getAgent(request),
        updateAgent: (request) => management().updateAgent(request),
        deleteAgent: (request) => management().deleteAgent(request),
        readCustomAgentAvatar: (agentName) => management().readCustomAgentAvatar(agentName),
        setMainSession: (agentName, sessionId) => management().setMainSession(agentName, sessionId),
        agentExists: (agentName) => management().agentExists(agentName),
        canDelegate: (agentName) => management().canDelegate(agentName),
        listLegacyPinnedAgentRefs: () => management().listLegacyPinnedAgentRefs(),
        ensureBuiltinAgents: () => management().ensureBuiltinAgents(),
        retryBuiltinGreetings: () => management().retryBuiltinGreetings(),
        getAgentOwnerIdentity: (requestRef) => management().getAgentOwnerIdentity(requestRef),
        getSessionAgentRoutingSnapshot: (sessionId) => management().getSessionAgentRoutingSnapshot(sessionId),
        getSessionProjectIdentity: (sessionId) => management().getSessionProjectIdentity(sessionId),
        bindResolver: (next) => {
            currentResolver = next;
        },
        bindManagement: (next) => {
            currentManagement = next;
        },
    };
}
/** Adapt the neutral runtime port to the desktop tool's signal-tolerant shape. */
export function createLocalMavisAgentAdapter(port) {
    return {
        listAgents: (request) => port.listAgents(request),
        createAgent: (request) => port.createAgent(request),
        getAgent: (request) => port.getAgent(request),
        updateAgent: (request) => port.updateAgent(request),
        deleteAgent: (request) => port.deleteAgent(request),
        resolveAgentReadScope: async (requestedName) => port.resolveAgentReadScope(requestedName),
        resolveAgentWriteTarget: (requestedName) => port.resolveAgentWriteTarget(requestedName),
        requireExactAgentKey: (requestedName) => port.requireExactAgentKey(requestedName),
    };
}
//# sourceMappingURL=runtime-port.js.map