/** Historical attempts remain valid provenance even after retry or root replacement. */
function readBunnyGreetingMarker(value) {
    const marker = originRecord(value);
    if (!marker || Object.keys(marker).some((key) => key !== 'attempt' && key !== 'requestId'))
        return undefined;
    if (typeof marker.attempt !== 'number' ||
        !Number.isSafeInteger(marker.attempt) ||
        marker.attempt < 1)
        return undefined;
    if (typeof marker.requestId !== 'string')
        return undefined;
    const request = /^bunny-bootstrap:([^:\s]+):([1-9]\d*)$/.exec(marker.requestId);
    if (!request || request[2] !== String(marker.attempt))
        return undefined;
    return { attempt: marker.attempt, requestId: marker.requestId };
}
function originRecord(value) {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value
        : undefined;
}
function explicitOriginRecord(value) {
    if (typeof value !== 'string')
        return originRecord(value);
    try {
        return originRecord(JSON.parse(value));
    }
    catch {
        return undefined;
    }
}
/** Adds only the trusted marker; unrelated explicit origin fields keep their existing meaning. */
export function projectBunnyGreetingOrigin(message, explicitOrigin) {
    const explicit = explicitOriginRecord(explicitOrigin);
    const context = originRecord(message.sourceContext ?? message.source_context);
    const contextOrigin = originRecord(context?.origin);
    const candidate = contextOrigin && Object.hasOwn(contextOrigin, 'bunnyGreeting')
        ? contextOrigin.bunnyGreeting
        : explicit?.bunnyGreeting;
    const marker = message.source === 'greeting' ? readBunnyGreetingMarker(candidate) : undefined;
    if (!marker && !Object.hasOwn(explicit ?? {}, 'bunnyGreeting'))
        return explicitOrigin;
    const origin = { ...explicit };
    delete origin.bunnyGreeting;
    if (marker)
        origin.bunnyGreeting = marker;
    return Object.keys(origin).length ? origin : undefined;
}
//# sourceMappingURL=greeting-origin.js.map