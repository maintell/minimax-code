/**
 * Author-facing event model: `register(on)`, site hooks and observe events (one.md §4). Sites
 * are an open registry; adding one means adding a member here and a row to the site table.
 */
const toolFields = Object.freeze([
    { name: 'tool', required: false },
    { name: 'server', required: false },
]);
const OBSERVE_EVENT_TABLE = Object.freeze([
    { event: 'session.start', matcherFields: [] },
    { event: 'turn.start', matcherFields: [] },
    { event: 'turn.complete', matcherFields: [] },
    { event: 'tool.call', matcherFields: toolFields },
    { event: 'tool.result', matcherFields: toolFields },
    { event: 'session.measure', matcherFields: [] },
    { event: 'ui.close', matcherFields: [{ name: 'id', required: false }] },
]);
export const OBSERVE_EVENT_NAMES = Object.freeze(OBSERVE_EVENT_TABLE.map((spec) => spec.event));
export function isObserveEventName(name) {
    return OBSERVE_EVENT_NAMES.includes(name);
}
export function observeEventSpec(name) {
    const spec = OBSERVE_EVENT_TABLE.find((candidate) => candidate.event === name);
    if (!spec)
        throw new Error(`Observe event "${name}" is missing from the observe event table`);
    return spec;
}
export function matchesObserveHook(hook, event, match) {
    if (hook.slot !== event)
        return false;
    const matcher = hook.matcher ?? {};
    return observeEventSpec(event).matcherFields.every(({ name }) => matcher[name] === undefined || matcher[name] === match[name]);
}
//# sourceMappingURL=events.js.map