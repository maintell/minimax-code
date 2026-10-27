/** Frame limits, identifiers and JSON shapes shared by the child client and the Host session. */
export const REQUEST_MAX_BYTES = 256 * 1024;
export const RESPONSE_MAX_BYTES = 8 * 1024 * 1024;
const MAX_IDENTIFIER_BYTES = 256;
const MAX_PENDING = 16;
/** Permission replies must still enter when Agent turns fill the ordinary request budget. */
const MAX_PENDING_AGENT_REPLIES = 16;
/** Observers live until cancelled, so they get a lane of their own (the Gateway allows 4). */
const MAX_PENDING_AGENT_OBSERVERS = 4;
/** Bounds a tool runtime name on the wire; longer names are never listed or sent. */
const TOOL_NAME_MAX_BYTES = 1024;
export function isMiniAppToolNameWithinLimit(value) {
    return (typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= TOOL_NAME_MAX_BYTES);
}
export function isToolMethod(method) {
    return method === 'tool.list' || method === 'tool.call' || method === 'tool.request';
}
export function isCancelMethod(method) {
    return method === 'connector.cancel' || method === 'agent.cancel' || method === 'tool.cancel';
}
const LANE_LIMITS = {
    reply: MAX_PENDING_AGENT_REPLIES,
    observe: MAX_PENDING_AGENT_OBSERVERS,
    request: MAX_PENDING,
};
function pendingLane(method) {
    if (method === 'agent.reply')
        return 'reply';
    return method === 'agent.observe' ? 'observe' : 'request';
}
/**
 * Both endpoints retain one pending map, with separately bounded lanes for permission replies
 * and observers so neither starves, or is starved by, ordinary requests.
 */
export function hasHostConnectorRequestCapacity(method, pending) {
    const lane = pendingLane(method);
    const limit = LANE_LIMITS[lane];
    let count = 0;
    for (const request of pending) {
        if (pendingLane(request.method) === lane && ++count >= limit)
            return false;
    }
    return true;
}
export function isAgentMethod(method) {
    return isAgentShortMethod(method) || isAgentStreamMethod(method);
}
/** Request/response `agent.*` calls: no admission receipt, events or run slot. */
function isAgentShortMethod(method) {
    return (method === 'agent.reply' ||
        method === 'agent.models' ||
        method === 'agent.agents' ||
        method === 'agent.create' ||
        method === 'agent.sessions' ||
        method === 'agent.session');
}
/**
 * Turn-following requests: no request timeout, streamed events, aborted on cutover. The short
 * `agent.*` requests are drained and timed like a connector call.
 */
function isAgentTurnMethod(method) {
    return method === 'agent.run' || method === 'agent.answer';
}
/**
 * `agent.*` calls that only read the user's sessions. They change nothing, so losing one is
 * never an unknown outcome.
 */
export function isAgentSessionReadMethod(method) {
    return method === 'agent.observe' || method === 'agent.sessions' || method === 'agent.session';
}
/**
 * Requests that stream event frames until they settle: the turn-following ones and
 * `agent.observe`. None has a request timeout, and a committed cutover aborts them all.
 */
export function isAgentStreamMethod(method) {
    return isAgentTurnMethod(method) || method === 'agent.observe';
}
export function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function isBoundedIdentifier(value) {
    return (typeof value === 'string' &&
        value.length > 0 &&
        Buffer.byteLength(value) <= MAX_IDENTIFIER_BYTES);
}
export function isRequestId(value) {
    if (typeof value !== 'string' || !/^[1-9]\d{0,19}$/u.test(value))
        return false;
    try {
        return BigInt(value) <= 18446744073709551615n;
    }
    catch {
        return false;
    }
}
export function hasExactKeys(value, keys) {
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
//# sourceMappingURL=host-connector-wire.js.map