import { activeStatusPhase, } from './supervisor-generation.js';
function statusPhase(state, pluginId, active) {
    if (state.quarantined.has(pluginId))
        return 'quarantined';
    if (state.disabled.has(pluginId))
        return 'disabled';
    if (active)
        return activeStatusPhase(active, state.failures.has(pluginId));
    if (state.preparations.has(pluginId))
        return 'preparing';
    if (state.failures.has(pluginId))
        return 'failed';
    if (state.cold.has(pluginId))
        return 'cold';
    return 'inactive';
}
export function statusFor(state, diagnostics, pluginId) {
    const active = state.active.get(pluginId);
    const retiring = state.retiring.get(pluginId) ?? [];
    const failureCode = state.failures.get(pluginId);
    return {
        pluginId,
        phase: statusPhase(state, pluginId, active),
        ...(active ? { active: active.view } : {}),
        retiringGenerationIds: retiring.map((generation) => generation.view.miniAppGeneration),
        leaseCount: (active?.leases.size ?? 0) +
            retiring.reduce((count, generation) => count + generation.leases.size, 0),
        ...(failureCode ? { failureCode } : {}),
        logs: diagnostics.logs(pluginId),
        diagnostics: diagnostics.inspect(pluginId, active?.view.processGeneration, failureCode),
    };
}
//# sourceMappingURL=supervisor-status.js.map