/**
 * Cap check for a render tree, zod-free so the Worker exit can enforce caps before the tree goes
 * over the wire. Iterative, so hostile depth cannot overflow the stack before it is rejected.
 */
import { TREE_LIMITS } from './tree.js';
export function checkRenderTreeLimits(tree, limits = TREE_LIMITS) {
    const stack = [];
    const pushChildren = (value, depth) => {
        if (Array.isArray(value)) {
            for (let i = value.length - 1; i >= 0; i -= 1)
                stack.push({ value: value[i], depth });
        }
        else {
            stack.push({ value, depth });
        }
    };
    pushChildren(tree, 1);
    let nodes = 0;
    let hosts = 0;
    for (let item = stack.pop(); item !== undefined; item = stack.pop()) {
        const { value, depth } = item;
        nodes += 1;
        if (nodes > limits.maxNodes)
            return { kind: 'nodes', limit: limits.maxNodes };
        if (typeof value === 'string') {
            if (value.length > limits.maxTextLength) {
                return { kind: 'text', limit: limits.maxTextLength, length: value.length };
            }
            continue;
        }
        if (typeof value !== 'object' || value === null)
            continue;
        // Shared subtrees are fine; a cycle keeps growing depth until the depth cap rejects it.
        if (depth > limits.maxDepth)
            return { kind: 'depth', limit: limits.maxDepth };
        const element = value;
        if (element.type === 'host') {
            hosts += 1;
            if (hosts > limits.maxHostNodes)
                return { kind: 'host', limit: limits.maxHostNodes };
        }
        if (element.props && typeof element.props === 'object') {
            for (const prop of Object.values(element.props)) {
                if (typeof prop === 'string' && prop.length > limits.maxTextLength) {
                    return { kind: 'text', limit: limits.maxTextLength, length: prop.length };
                }
            }
        }
        if (element.children !== undefined)
            pushChildren(element.children, depth + 1);
    }
    let serialized;
    try {
        serialized = JSON.stringify(tree);
    }
    catch {
        return { kind: 'unserializable' };
    }
    if (serialized === undefined)
        return { kind: 'unserializable' };
    const bytes = new TextEncoder().encode(serialized).length;
    if (bytes > limits.maxBytes)
        return { kind: 'bytes', limit: limits.maxBytes, bytes };
    return undefined;
}
//# sourceMappingURL=tree-limits.js.map