/** The gateway's session reads and observers: `sessions`, `session` and `observe`. */
import { readMiniAppAgentObserveTarget } from '@mavis/shared/miniapp-surface';
import { MINIAPP_AGENT_MAX_OBSERVERS_PER_PLUGIN, MiniAppAgentError, } from './contracts.js';
import { AUDIT_MESSAGE, BUSY_MESSAGES, allowsRead, allowsRunOrRead, authorize, notPermitted, readRefused, reject, unavailable, } from './gateway-admission.js';
import { isId } from './gateway-input.js';
export function endObservers(state, pluginId, permission) {
    const observers = state.observers.get(pluginId);
    if (!observers?.size)
        return;
    const ended = observers.size;
    for (const controller of observers)
        controller.abort();
    state.options.logger.info({ pluginId, permission, endedObservers: ended }, 'Mini App Agent observers ended by a permission switch');
}
function auditRead(state, caller, fields) {
    state.options.logger.info({
        pluginId: caller.pluginId,
        processGeneration: caller.processGeneration,
        source: caller.source,
        ...fields,
    }, AUDIT_MESSAGE);
}
/**
 * The Mini App's own session is readable with either capability; any other session needs
 * `session.read` (NOT_PERMITTED otherwise, whether or not it exists) and must be a visible root.
 */
async function readableSession(state, admitted, caller, sessionId) {
    let view;
    try {
        view = await admitted.bound.findSession(sessionId);
    }
    catch (error) {
        throw unavailable(state, caller, error, { stage: 'session-lookup', sessionId });
    }
    if (view && view.ownerPluginId === caller.pluginId)
        return view;
    if (!admitted.has('session.read'))
        throw readRefused(state, caller, admitted);
    if (!view?.listed) {
        throw reject(state, caller, new MiniAppAgentError('SESSION_NOT_FOUND', 'Mini App Agent session not found'), { sessionId });
    }
    return view;
}
/**
 * Re-checks an admission after an await, before anything reaches the caller: its arena must
 * still be the one admitted (a released or replaced generation gets nothing more, retryable
 * AGENT_UNAVAILABLE) and the access must still be on (NOT_PERMITTED once switched off).
 */
function confirmAdmission(state, caller, admitted, permits) {
    if (state.arenas.get(caller.pluginId) !== admitted.arena) {
        throw reject(state, caller, new MiniAppAgentError('AGENT_UNAVAILABLE', 'Mini App Agent caller is out of date', true), { reason: 'arena-released' });
    }
    if (!permits(admitted.has))
        throw notPermitted(state, caller, 'switched-off');
}
/** The Mini App's own session is readable with either access; any other needs `session.read`. */
function readRule(view, caller) {
    return view.ownerPluginId === caller.pluginId ? allowsRunOrRead : allowsRead;
}
export async function listSessions(state, caller) {
    const admitted = authorize(state, caller, allowsRead);
    let sessions;
    try {
        sessions = await admitted.bound.listSessions();
    }
    catch (error) {
        throw unavailable(state, caller, error, { stage: 'sessions-list' });
    }
    confirmAdmission(state, caller, admitted, allowsRead);
    auditRead(state, caller, { operation: 'sessions', count: sessions.length });
    return { sessions };
}
export async function getSession(state, caller, input) {
    const admitted = authorize(state, caller, allowsRunOrRead);
    // Like `models().host`, the host chat comes from the tab Main resolved, never from the page.
    const forHost = input?.sessionId === undefined && caller.source === 'page';
    if (forHost && caller.hostSessionId === undefined)
        return undefined;
    const sessionId = forHost ? caller.hostSessionId : input?.sessionId;
    if (!isId(sessionId)) {
        throw reject(state, caller, new MiniAppAgentError('INVALID_ARGUMENTS', 'Mini App Agent session needs a sessionId'));
    }
    const view = await readableSession(state, admitted, caller, sessionId);
    let text;
    try {
        text = await admitted.bound.lastAssistantText(sessionId);
    }
    catch (error) {
        throw unavailable(state, caller, error, { stage: 'session-reply', sessionId });
    }
    confirmAdmission(state, caller, admitted, readRule(view, caller));
    auditRead(state, caller, {
        operation: 'session',
        sessionId,
        ...(forHost ? { target: 'host' } : {}),
    });
    return { ...view.summary, ...view.detail, ...(text ? { lastAssistantText: text } : {}) };
}
/** Checks arguments and read access of one `observe` call before it takes a slot. */
async function admitObserver(state, caller, input, options) {
    const admitted = authorize(state, caller, allowsRunOrRead);
    const target = readMiniAppAgentObserveTarget(input);
    const sessionId = target && 'sessionId' in target ? target.sessionId : undefined;
    const onEvent = options?.onEvent;
    if (!target || (sessionId !== undefined && !isId(sessionId)) || typeof onEvent !== 'function') {
        throw reject(state, caller, new MiniAppAgentError('INVALID_ARGUMENTS', 'Mini App Agent observe needs onEvent and either a sessionId or all: true'));
    }
    if (sessionId === undefined) {
        if (!admitted.has('session.read'))
            throw readRefused(state, caller, admitted);
        return { admitted, sessionId, onEvent, rule: allowsRead };
    }
    const view = await readableSession(state, admitted, caller, sessionId);
    return { admitted, sessionId, onEvent, rule: readRule(view, caller) };
}
/**
 * Observers are kept apart from `listeners` and from the run slots: watching a session never
 * answers its asks, and does not count toward the per-minute start limit.
 */
export async function observe(state, caller, input, options) {
    const admission = await admitObserver(state, caller, input, options);
    const { admitted, sessionId, onEvent } = admission;
    const { arena, bound } = admitted;
    // The arena may have been released or the access switched off during the session lookup.
    confirmAdmission(state, caller, admitted, admission.rule);
    const observers = state.observers.get(caller.pluginId) ?? new Set();
    if (observers.size >= MINIAPP_AGENT_MAX_OBSERVERS_PER_PLUGIN) {
        throw reject(state, caller, new MiniAppAgentError('BUSY', BUSY_MESSAGES.observer_limit, true, 'observer_limit'), { reason: 'observer_limit' });
    }
    const controller = new AbortController();
    observers.add(controller);
    state.observers.set(caller.pluginId, observers);
    arena.observers.add(controller);
    const signal = options.signal
        ? AbortSignal.any([controller.signal, options.signal])
        : controller.signal;
    const scope = sessionId === undefined ? { scope: 'all' } : { scope: 'session', sessionId };
    auditRead(state, caller, { operation: 'observe', phase: 'admission', ...scope });
    try {
        if (sessionId === undefined)
            await bound.observeSessions({ signal, onEvent });
        else
            await bound.observeSession({ sessionId, signal, onEvent });
    }
    catch (error) {
        throw unavailable(state, caller, error, { stage: 'observe', ...scope });
    }
    finally {
        arena.observers.delete(controller);
        observers.delete(controller);
        if (observers.size === 0 && state.observers.get(caller.pluginId) === observers) {
            state.observers.delete(caller.pluginId);
        }
    }
    auditRead(state, caller, { operation: 'observe', phase: 'terminal', ...scope });
}
//# sourceMappingURL=gateway-reads.js.map