import { MiniAppAgentError, } from './contracts.js';
export const AUDIT_MESSAGE = 'Mini App Agent run';
export const RUN_PERMISSION = 'agent:session.run';
export const READ_PERMISSION = 'agent:session.read';
export function isSwitchedOn(state, pluginId, access) {
    return state.switches?.isEnabled(pluginId, `agent:${access}`) ?? true;
}
export function reject(state, caller, error, fields = {}) {
    state.options.logger.warn({
        pluginId: caller.pluginId,
        processGeneration: caller.processGeneration,
        source: caller.source,
        phase: 'rejected',
        errorCode: error.code,
        ...fields,
    }, AUDIT_MESSAGE);
    return error;
}
/**
 * Fails closed until bound, then checks the caller's arena and its policy. A caller of an
 * older generation (its page `runId` is stale or the Node process restarted) is unavailable,
 * not refused: the current generation may run.
 */
export function authorize(state, caller, permits = allowsRun) {
    if (!state.ports) {
        throw new MiniAppAgentError('AGENT_UNAVAILABLE', 'Mini App Agent is not available');
    }
    const arena = state.arenas.get(caller.pluginId);
    // No arena: never authorized, or retired / revoked.
    if (!arena)
        throw notPermitted(state, caller, 'no-arena');
    const declared = (access) => declares(arena.policy, access);
    const has = (access) => declared(access) && isSwitchedOn(state, caller.pluginId, access);
    if (!permits(declared))
        throw notPermitted(state, caller, 'policy');
    if (!permits(has))
        throw notPermitted(state, caller, 'switched-off');
    if (arena.processGeneration !== caller.processGeneration) {
        throw reject(state, caller, new MiniAppAgentError('AGENT_UNAVAILABLE', 'Mini App Agent caller is out of date', true), { reason: 'generation-mismatch' });
    }
    return { bound: state.ports, arena, has };
}
export function notPermitted(state, caller, reason) {
    return reject(state, caller, new MiniAppAgentError('NOT_PERMITTED', 'Mini App is not permitted to use the Agent'), { reason });
}
export const BUSY_MESSAGES = {
    session_busy: 'Mini App Agent session is already running',
    queue_full: 'Too many Mini App Agent runs are waiting',
    rate_limited: 'Too many Mini App Agent runs were started in the last minute',
    observer_limit: 'Too many Mini App Agent observers',
};
export function unavailable(state, caller, error, context) {
    // Every caller fails before a turn is dispatched, so the request can be retried as a whole.
    return reject(state, caller, new MiniAppAgentError('AGENT_UNAVAILABLE', 'Mini App Agent session is unavailable', true), { ...context, errorName: errorName(error) });
}
export function errorName(error) {
    return error instanceof Error ? error.name : typeof error;
}
export function declares(policy, access) {
    return policy.kind === 'allowlist' && policy.capabilities.includes(access);
}
function allowsRun(has) {
    return has('session.run');
}
export function allowsRead(has) {
    return has('session.read');
}
/** Either capability reads the Mini App's own sessions; anything else also needs `session.read`. */
export function allowsRunOrRead(has) {
    return has('session.run') || has('session.read');
}
/** `session.read` is missing: never declared, or switched off by the user. */
export function readRefused(state, caller, admitted) {
    const declared = declares(admitted.arena.policy, 'session.read');
    return notPermitted(state, caller, declared ? 'switched-off' : 'policy');
}
//# sourceMappingURL=gateway-admission.js.map