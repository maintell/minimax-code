import { isHandle } from '@mavis/shared/plugin-extension';
import { callbackProps, handleKey, treeRoots } from './tree-guard.js';
/**
 * Every handle of a tree on a callback prop, keyed `plugin\0handle`, with the control it is bound
 * to: the drawing a gesture was aimed at, matched against a later one by control.
 */
export function handleSites(tree) {
    const sites = new Map();
    const controls = new Map();
    const visit = (node, chain, keyed) => {
        if (typeof node === 'string' || node.type === 'host')
            return;
        for (const prop of callbackProps(node.type)) {
            const value = node.props[prop];
            if (!isHandle(value))
                continue;
            const key = handleKey(value.plugin, value.handle);
            const control = keyed && !sites.has(key) ? `${node.type}\u0000${prop}\u0000${chain}` : undefined;
            if (control !== undefined)
                controls.set(control, (controls.get(control) ?? 0) + 1);
            sites.set(key, { plugin: value.plugin, handle: value.handle, control });
        }
        node.children?.forEach((child, index) => {
            const own = keyOf(child);
            visit(child, `${chain}/${segment(own, index)}`, keyed || own !== undefined);
        });
    };
    treeRoots(tree).forEach((root, index) => {
        const own = keyOf(root);
        visit(root, segment(own, index), own !== undefined);
    });
    for (const [key, site] of sites) {
        if (site.control !== undefined && (controls.get(site.control) ?? 0) > 1) {
            sites.set(key, { ...site, control: undefined });
        }
    }
    return sites;
}
function keyOf(node) {
    return typeof node === 'string' || node.type === 'host' ? undefined : node.key;
}
/** A keyed level is named by its key, an unkeyed one by its child index. */
function segment(key, index) {
    return key === undefined ? String(index) : `#${JSON.stringify(key)}`;
}
//# sourceMappingURL=handle-sites.js.map