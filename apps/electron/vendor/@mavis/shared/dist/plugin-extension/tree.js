/**
 * Data tree protocol (two.md §5). The tree only contains catalog elements, text and at most one
 * `{ type: 'host' }` node. Callback props travel as `Handle`s; closures never leave the realm.
 *
 * Granularity note: a `RenderTree` is one site instance's output, unlike the block-level
 * `MiniAppContribution`.
 */
/** A callback reference exactly as the render tree validator accepts it: no other fields. */
export function isHandle(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        return false;
    if (value instanceof Date || value instanceof Map || value instanceof Set)
        return false;
    if ('then' in value &&
        typeof value.then === 'function' &&
        'catch' in value &&
        typeof value.catch === 'function')
        return false;
    const { plugin, handle } = value;
    for (const key in value)
        if (key !== 'plugin' && key !== 'handle')
            return false;
    return (Object.keys(value).every((key) => key === 'plugin' || key === 'handle') &&
        typeof plugin === 'string' &&
        plugin.length > 0 &&
        typeof handle === 'number' &&
        Number.isInteger(handle) &&
        handle >= 0);
}
export const TREE_LIMITS = Object.freeze({
    maxNodes: 5_000,
    maxDepth: 24,
    maxBytes: 200 * 1024,
    maxTextLength: 10_000,
    maxHostNodes: 1,
});
/**
 * Equality of two values as JSON: object key order is irrelevant and a key holding `undefined`
 * counts as absent. No prototype checks, so values from another realm compare too.
 */
export function jsonEqual(left, right) {
    if (Object.is(left, right))
        return true;
    if (typeof left !== 'object' || typeof right !== 'object' || left === null || right === null) {
        return false;
    }
    if (Array.isArray(left) !== Array.isArray(right))
        return false;
    const leftKeys = definedKeys(left);
    if (leftKeys.length !== definedKeys(right).length)
        return false;
    return leftKeys.every((key) => Object.prototype.hasOwnProperty.call(right, key) &&
        jsonEqual(left[key], right[key]));
}
function definedKeys(value) {
    return Object.keys(value).filter((key) => value[key] !== undefined);
}
//# sourceMappingURL=tree.js.map