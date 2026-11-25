// ---------------------------------------------------------------------------------------------
// Attribution memory (two.md §2.3): the Worker writes the realm and hook it hands control to.
const ATTRIBUTION_REALM = 0;
const ATTRIBUTION_HOOK = 1;
const ATTRIBUTION_SEQ = 2;
export const ATTRIBUTION_BYTES = 4 * Int32Array.BYTES_PER_ELEMENT;
export function writeAttribution(memory, realmNo, hookRef) {
    Atomics.store(memory, ATTRIBUTION_REALM, realmNo);
    Atomics.store(memory, ATTRIBUTION_HOOK, hookRef);
    Atomics.add(memory, ATTRIBUTION_SEQ, 1);
}
export function readAttribution(memory) {
    return {
        realmNo: Atomics.load(memory, ATTRIBUTION_REALM),
        hookRef: Atomics.load(memory, ATTRIBUTION_HOOK),
        seq: Atomics.load(memory, ATTRIBUTION_SEQ),
    };
}
export function realmKeyOf(pluginId, artifactDigest) {
    return `${pluginId}@${artifactDigest}`;
}
/** `calls:` whitelist check (two.md §3); always enforced. */
export function callAllowed(calls, name, server) {
    const dot = name.indexOf('.');
    const domain = name.slice(0, dot);
    const method = name.slice(dot + 1);
    return calls.some((call) => call.domain === domain &&
        call.method === method &&
        (server === undefined || call.server === undefined || call.server === server));
}
//# sourceMappingURL=protocol.js.map