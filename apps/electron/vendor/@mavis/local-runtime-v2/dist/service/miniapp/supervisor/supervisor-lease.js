import { MiniAppError } from '../errors.js';
export function requireActiveGeneration(active, pluginId) {
    const generation = active.get(pluginId);
    if (!generation) {
        throw new MiniAppError('NO_ACTIVE_GENERATION', 'Mini App has no active generation');
    }
    return generation;
}
export function admitLease(state, input) {
    if (state.disabled.has(input.pluginId)) {
        throw new MiniAppError('DISABLED', 'Mini App is disabled');
    }
    if (state.quarantined.has(input.pluginId)) {
        throw new MiniAppError('QUARANTINED', 'Mini App cleanup ownership is unproven');
    }
    if (state.quiescing.has(input.pluginId) || state.explicitlyStopped.has(input.pluginId)) {
        throw new MiniAppError('BUSY', 'Mini App requires an explicit start', {
            busyReason: 'operation_busy',
        });
    }
    const generation = requireActiveGeneration(state.active, input.pluginId);
    if (input.expectedMiniAppGeneration &&
        input.expectedMiniAppGeneration !== generation.view.miniAppGeneration) {
        throw new MiniAppError('RETIRED_GENERATION', 'Mini App generation is retired');
    }
    if (input.expectedProcessGeneration &&
        input.expectedProcessGeneration !== generation.view.processGeneration) {
        throw new MiniAppError('RETIRED_GENERATION', 'Mini App process generation is retired');
    }
    return generation;
}
export function admitRunningLease(state, input, runtime) {
    const generation = admitLease(state, input);
    if (generation.accepting &&
        generation.runtime === runtime &&
        generation.view.processGeneration === runtime.processGeneration &&
        generation.candidate.nodeDigest === runtime.nodeDigest) {
        return generation;
    }
    throw new MiniAppError('SERVICE_RESTARTED', 'Mini App runtime changed before the generation lease could be admitted');
}
//# sourceMappingURL=supervisor-lease.js.map