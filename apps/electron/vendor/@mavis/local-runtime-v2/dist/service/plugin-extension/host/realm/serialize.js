import { checkRenderTreeLimits, isHandle } from '@mavis/shared/plugin-extension';
import { callbackProps, errorPlaceholder } from '../render/tree-guard.js';
class InvalidSubtree extends Error {
}
class TreeTooLarge extends Error {
}
export function serializeOutput(value, scope) {
    const state = { scope, own: new Set(), nodes: 0 };
    let tree;
    try {
        tree = Array.isArray(value) ? childNodes(value, 1, state) : rootNode(value, state);
    }
    catch (error) {
        if (!(error instanceof TreeTooLarge))
            throw error;
        return { tree: errorPlaceholder(scope.pluginId, error.message), own: [] };
    }
    const violation = checkRenderTreeLimits(tree, scope.limits);
    if (violation) {
        return {
            tree: errorPlaceholder(scope.pluginId, `tree exceeds ${violation.kind} limit`),
            own: [],
        };
    }
    return { tree, own: [...state.own] };
}
function rootNode(value, state) {
    const nodes = childNodes([value], 1, state);
    if (nodes.length === 1 && nodes[0] !== undefined)
        return nodes[0];
    return nodes;
}
function childNodes(values, depth, state) {
    const out = [];
    for (const value of values) {
        if (Array.isArray(value)) {
            out.push(...childNodes(value, depth, state));
            continue;
        }
        const node = childNode(value, depth, state);
        if (node !== undefined)
            out.push(node);
    }
    return out;
}
function childNode(value, depth, state) {
    if (value === null || value === undefined || typeof value === 'boolean' || value === '') {
        return undefined;
    }
    countNode(state);
    if (typeof value === 'string')
        return value;
    if (typeof value === 'number')
        return String(value);
    if (typeof value !== 'object') {
        return errorPlaceholder(state.scope.pluginId, `unsupported ${typeof value} child`);
    }
    return elementNode(value, depth, state);
}
function countNode(state) {
    state.nodes += 1;
    if (state.nodes > state.scope.limits.maxNodes)
        throw new TreeTooLarge('tree exceeds nodes limit');
}
function elementNode(value, depth, state) {
    if (depth > state.scope.limits.maxDepth)
        throw new TreeTooLarge('tree exceeds depth limit');
    const type = value.type;
    if (type === 'host')
        return { type: 'host' };
    try {
        if (typeof type !== 'string')
            throw new InvalidSubtree('element without a type');
        const props = elementProps(type, value.props, state);
        const children = Array.isArray(value.children)
            ? childNodes(value.children, depth + 1, state)
            : [];
        const key = value.key;
        return {
            type,
            ...(typeof key === 'string' || typeof key === 'number' ? { key: String(key) } : {}),
            props,
            ...(children.length > 0 ? { children } : {}),
        };
    }
    catch (error) {
        if (!(error instanceof InvalidSubtree))
            throw error;
        return errorPlaceholder(state.scope.pluginId, error.message);
    }
}
function elementProps(type, props, state) {
    if (props === undefined || props === null)
        return {};
    if (typeof props !== 'object')
        throw new InvalidSubtree(`<${type}> props must be an object`);
    const callbacks = callbackProps(type);
    const out = {};
    for (const [name, prop] of Object.entries(props)) {
        if (prop === undefined)
            continue;
        out[name] = callbacks.includes(name)
            ? handleProp(type, name, prop, state)
            : jsonProp(type, name, prop, state);
    }
    return out;
}
function handleProp(type, name, prop, state) {
    if (typeof prop === 'object' && prop !== null) {
        const own = state.scope.resolveHandle(prop);
        if (own !== undefined) {
            state.own.add(own);
            return { plugin: state.scope.pluginId, handle: own };
        }
        // Another plugin's handle; the main thread checks it came from this layer's `next`.
        if (isHandle(prop) && prop.plugin !== state.scope.pluginId) {
            return { plugin: prop.plugin, handle: prop.handle };
        }
    }
    throw new InvalidSubtree(`<${type} ${name}> is not a handle issued by this plugin`);
}
function jsonProp(type, name, prop, state) {
    if (typeof prop === 'object' && prop !== null && state.scope.resolveHandle(prop) !== undefined) {
        throw new InvalidSubtree(`<${type} ${name}> does not take a callback`);
    }
    try {
        const text = JSON.stringify(prop);
        if (text !== undefined)
            return JSON.parse(text);
    }
    catch {
        // Falls through to the subtree fallback below.
    }
    throw new InvalidSubtree(`<${type} ${name}> is not JSON`);
}
//# sourceMappingURL=serialize.js.map