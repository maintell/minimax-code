import { MINIAPP_AGENT_QUEUE_FACTOR } from './contracts.js';
export function createRunSlotPool(maxConcurrent) {
    return {
        maxConcurrent,
        maxQueued: maxConcurrent * MINIAPP_AGENT_QUEUE_FACTOR,
        slots: new Set(),
        calls: new Set(),
        runningSessions: new Map(),
        joined: 0,
        queue: [],
    };
}
/** A slot is free and nobody waits ahead. */
export function hasFreeSlot(pool) {
    return pool.slots.size < pool.maxConcurrent && pool.queue.length === 0;
}
export function runningSlot(pool, sessionId) {
    return sessionId === undefined ? undefined : pool.runningSessions.get(sessionId);
}
export function occupy(pool, sessionId, queuedAt) {
    const session = { calls: 0 };
    pool.slots.add(session);
    if (sessionId !== undefined)
        bindSlot(pool, session, sessionId);
    return enter(pool, session, false, queuedAt);
}
/** Shares a session's slot; undefined when the joined calls in flight reached `maxQueued`. */
export function joinSlot(pool, session, queuedAt) {
    if (pool.joined >= pool.maxQueued)
        return undefined;
    pool.joined += 1;
    return enter(pool, session, true, queuedAt);
}
function enter(pool, session, joined, queuedAt) {
    const controller = new AbortController();
    pool.calls.add(controller);
    session.calls += 1;
    return { controller, session, joined, ...(queuedAt === undefined ? {} : { queuedAt }) };
}
export function bindSlot(pool, session, sessionId) {
    session.sessionId = sessionId;
    pool.runningSessions.set(sessionId, session);
}
/** The session's slot frees only when the last call on it settles. */
export function releaseSlot(pool, slot) {
    const { session } = slot;
    pool.calls.delete(slot.controller);
    if (slot.joined)
        pool.joined -= 1;
    session.calls -= 1;
    if (session.calls > 0)
        return;
    pool.slots.delete(session);
    if (session.sessionId !== undefined && pool.runningSessions.get(session.sessionId) === session) {
        pool.runningSessions.delete(session.sessionId);
    }
}
/** Hands each free slot to the oldest waiting call; a refused or joining call leaves it to the next. */
export function drain(pool) {
    while (pool.slots.size < pool.maxConcurrent) {
        const next = pool.queue.shift();
        if (!next)
            return;
        next.dequeue();
    }
}
/** Nothing waits on a released arena: queued calls are cancelled, in-flight runs aborted. */
export function releasePool(pool) {
    for (const queued of pool.queue.splice(0))
        queued.cancel();
    for (const controller of pool.calls)
        controller.abort();
}
//# sourceMappingURL=run-slots.js.map