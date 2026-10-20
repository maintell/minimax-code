/** Frame limits, identifiers and JSON shapes shared by the child client and the Host session. */
export const REQUEST_MAX_BYTES = 256 * 1024;
export const RESPONSE_MAX_BYTES = 8 * 1024 * 1024;
const MAX_IDENTIFIER_BYTES = 256;
const MAX_PENDING = 16;
/** Permission replies must still enter when Agent turns fill the ordinary request budget. */
const MAX_PENDING_AGENT_REPLIES = 16;
/** Both endpoints retain one pending map, with separate bounded admission for permission replies. */
export function hasHostConnectorRequestCapacity(method, pending) {
    const reply = method === 'agent.reply';
    const limit = reply ? MAX_PENDING_AGENT_REPLIES : MAX_PENDING;
    let count = 0;
    for (const request of pending) {
        if ((request.method === 'agent.reply') === reply && ++count >= limit)
            return false;
    }
    return true;
}
export function isAgentMethod(method) {
    return isAgentShortMethod(method) || isAgentTurnMethod(method);
}
/** Request/response `agent.*` calls: no admission receipt, events or run slot. */
export function isAgentShortMethod(method) {
    return (method === 'agent.reply' ||
        method === 'agent.models' ||
        method === 'agent.agents' ||
        method === 'agent.create');
}
/**
 * Turn-following requests: no request timeout, streamed events, aborted on cutover. The short
 * `agent.*` requests are drained and timed like a connector call.
 */
export function isAgentTurnMethod(method) {
    return method === 'agent.run' || method === 'agent.answer';
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