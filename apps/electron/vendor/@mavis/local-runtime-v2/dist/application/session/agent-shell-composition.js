import { initializeAgentShellService, bindAgentShellService, } from '../../service/agent-shell/index.js';
export function composeAgentShell(input) {
    const { db, nowMs, composition, bindPermissions, sandboxOperationsFactory } = input;
    const { sessionSystem, preparation } = composition;
    const agentShell = initializeAgentShellService({ db, nowMs });
    bindAgentShellService(agentShell, {
        sessions: (id) => sessionSystem.sessions.repository.get(id),
        records: sessionSystem.sessions.records,
        preparation,
        ...(bindPermissions ? { bindPermissions } : {}),
    });
    sandboxOperationsFactory?.bindShellResolver((id) => agentShell.resolveForExecution(id));
    return agentShell;
}
/**
 * Windows-only: the first native Bash call waits for the Session shell binding
 * before permission checks, so the permission gate needs a resolver for the very
 * same AgentShell instance that owns the binding.
 */
export function withAgentShellPermission(product, agentShell) {
    if (process.platform !== 'win32')
        return product;
    return {
        ...product,
        permission: {
            ...product.permission,
            resolveAgentShell: (id) => agentShell.ensureSession(id),
        },
    };
}
//# sourceMappingURL=agent-shell-composition.js.map