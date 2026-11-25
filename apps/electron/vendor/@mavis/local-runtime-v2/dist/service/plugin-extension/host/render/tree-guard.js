import { ELEMENT_CATALOG, isElementName, isHandle, jsonEqual, } from '@mavis/shared/plugin-extension';
/**
 * Tree checks shared by the Worker exit and the main-thread fold (two.md §5). Handles only live on
 * catalog callback props; anything wrong with one subtree replaces only that subtree.
 */
export function errorPlaceholder(pluginId, reason) {
    const owner = pluginId ? `${pluginId}: ` : '';
    return {
        type: 'Text',
        props: { tone: 'danger', size: 'sm' },
        children: [`${owner}${reason}`.slice(0, 500)],
    };
}
export function handleKey(plugin, handle) {
    return `${plugin}\u0000${handle}`;
}
export function callbackProps(type) {
    return isElementName(type) ? ELEMENT_CATALOG[type].callbacks : [];
}
export function treeRoots(tree) {
    if (tree === undefined)
        return [];
    return Array.isArray(tree) ? tree : [tree];
}
function elementHandles(node) {
    const handles = [];
    for (const prop of callbackProps(node.type)) {
        const value = node.props[prop];
        if (isHandle(value))
            handles.push(value);
    }
    return handles;
}
/** `plugin\0handle` keys of every handle on a callback prop. */
export function collectHandles(tree) {
    const keys = new Set();
    const stack = [...treeRoots(tree)];
    for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
        if (typeof node === 'string' || node.type === 'host')
            continue;
        for (const handle of elementHandles(node))
            keys.add(handleKey(handle.plugin, handle.handle));
        if (node.children)
            stack.push(...node.children);
    }
    return keys;
}
function handleAllowed(handle, scope) {
    if (handle.plugin === scope.plugin)
        return scope.own.has(handle.handle);
    return scope.allowedForeign.has(handleKey(handle.plugin, handle.handle));
}
function guardNode(node, scope) {
    if (typeof node === 'string' || node.type === 'host')
        return node;
    const valid = elementHandles(node).every((handle) => handleAllowed(handle, scope));
    if (!valid) {
        scope.forged += 1;
        return errorPlaceholder(scope.plugin, 'forged handle');
    }
    if (!node.children)
        return node;
    return { ...node, children: node.children.map((child) => guardNode(child, scope)) };
}
/**
 * Stamps a layer's output: its own handles must be ones the realm registered; handles of other
 * plugins must come unchanged from this layer's `next` result. Violations fall back per subtree.
 */
export function guardLayerTree(tree, plugin, own, allowedForeign) {
    const scope = { plugin, own, allowedForeign, forged: 0 };
    const guarded = Array.isArray(tree)
        ? tree.map((node) => guardNode(node, scope))
        : guardNode(tree, scope);
    return { tree: guarded, forged: scope.forged };
}
const HOST_CORE = Object.freeze({ type: 'host' });
const NO_CORE = Object.freeze([]);
/**
 * What the chain end (the last layer's `next()`) yields on a site: the host view node where the
 * host has a default view (`coreKind: 'hostDefault'`), nothing (an empty fragment) where it has
 * none, so a drawing that keeps `await next()` never carries a host node the site cannot show.
 */
export function siteCore(site) {
    return site.coreKind === 'hostDefault' ? HOST_CORE : NO_CORE;
}
/** True when every layer passed through to the chain end: the tree is exactly the site's core. */
export function isCoreOnly(tree, core) {
    return jsonEqual(treeRoots(tree), treeRoots(core));
}
export function deepFreeze(value) {
    if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const child of Object.values(value))
            deepFreeze(child);
    }
    return value;
}
//# sourceMappingURL=tree-guard.js.map