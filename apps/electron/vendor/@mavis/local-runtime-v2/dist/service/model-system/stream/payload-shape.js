/** Returns whether a provider payload is a non-array object. */
export function isRecord(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}
//# sourceMappingURL=payload-shape.js.map