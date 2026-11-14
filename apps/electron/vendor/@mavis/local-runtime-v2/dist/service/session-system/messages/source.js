/**
 * Stream frame of a projected message: a greeting Turn's message carries the
 * trusted greeting origin and source, without the raw source context.
 */
export function streamMessageOrigin(message, provenance, { originProjection } = {}) {
    const origin = originProjection
        ? originProjection({ source: provenance?.source, sourceContext: provenance?.sourceContext }, message.origin)
        : message.origin;
    const greeting = provenance?.source === 'greeting';
    if (!greeting && origin === message.origin)
        return message;
    const projected = {
        ...message,
        origin,
        ...(greeting ? { source: 'greeting' } : {}),
    };
    if (greeting) {
        delete projected.sourceContext;
        delete projected.source_context;
    }
    return projected;
}
//# sourceMappingURL=source.js.map