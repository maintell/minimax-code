export class HarnessConformanceError extends Error {
    name = 'HarnessConformanceError';
}
/** JSON text of `value` with object keys sorted, so key order never affects equality. */
export function canonicalJson(value) {
    return JSON.stringify(value, sortedKeys);
}
/** Structural equality of JSON data; object key order is not part of the contract. */
export function expectSame(actual, expected, what) {
    const received = canonicalJson(actual);
    const wanted = canonicalJson(expected);
    if (received !== wanted) {
        throw new HarnessConformanceError(`${what}: expected ${wanted}, received ${received}`);
    }
}
function sortedKeys(_key, value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return value;
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => (left < right ? -1 : 1)));
}
export function expectTrue(condition, what) {
    if (!condition)
        throw new HarnessConformanceError(what);
}
export async function expectRejects(operation, what) {
    let rejected = false;
    try {
        await operation();
    }
    catch {
        rejected = true;
    }
    if (!rejected)
        throw new HarnessConformanceError(`${what}: expected a rejection`);
}
/** Close answers compared by outcome only; `abortReason` is optional diagnostics. */
export function closeOutcome(result) {
    return result.closed ? { closed: true } : { closed: false, reason: result.reason };
}
export function steeringKeys(messages) {
    return messages.map((message) => message.idempotencyKey);
}
/** Producers whose close semantics differ: user input, terminal input, machine delivery. */
export const CONFORMANCE_PRODUCERS = Object.freeze({
    user: 'composer-steer',
    terminal: 'mcode',
    machine: 'conformance-machine',
});
export function conformanceSteering(producer, key) {
    return {
        producerId: CONFORMANCE_PRODUCERS[producer],
        idempotencyKey: key,
        message: { text: key },
        genuineUserQueryText: key,
        provenance: { source: 'api', routingFingerprint: `conformance:${key}` },
    };
}
//# sourceMappingURL=conformance-case.js.map