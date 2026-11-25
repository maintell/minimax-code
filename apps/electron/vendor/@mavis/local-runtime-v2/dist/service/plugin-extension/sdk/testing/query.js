/** Depth-first, document order. */
export function findNodes(tree, query) {
    const found = [];
    const visit = (node, path) => {
        if (typeof node === 'string')
            return;
        if (matches(node, query))
            found.push({ node, path });
        if (node.type === 'host')
            return;
        (node.children ?? []).forEach((child, index) => visit(child, [...path, index]));
    };
    if (isNodeList(tree))
        tree.forEach((node, index) => visit(node, [index]));
    else
        visit(tree, []);
    return found;
}
function isNodeList(tree) {
    return Array.isArray(tree);
}
function matches(node, query) {
    if (query.type !== undefined && node.type !== query.type)
        return false;
    if (node.type === 'host') {
        return matchesHost(query);
    }
    if (query.key !== undefined && node.key !== query.key)
        return false;
    if (query.label !== undefined && stringProp(node, 'label') !== query.label)
        return false;
    if (!matchesText(node, query.text)) {
        return false;
    }
    return true;
}
function matchesHost(query) {
    return query.key === undefined && query.label === undefined && query.text === undefined;
}
function matchesText(node, query) {
    return query === undefined || ownTexts(node).some((text) => textMatches(text, query));
}
function ownTexts(node) {
    const texts = ['label', 'text', 'source']
        .map((prop) => stringProp(node, prop))
        .filter((value) => value !== undefined);
    const children = node.children ?? [];
    if (children.length > 0 && children.every((child) => typeof child === 'string')) {
        texts.push(children.join(''));
    }
    return texts;
}
function stringProp(node, name) {
    const value = node.props[name];
    return typeof value === 'string' ? value : undefined;
}
function textMatches(text, expected) {
    if (expected === undefined)
        return true;
    return typeof expected === 'string' ? text === expected : new RegExp(expected).test(text);
}
//# sourceMappingURL=query.js.map