/**
 * Site table. Every consumer looks sites up here instead of hard-coding slot names, matcher
 * fields or tree constraints, so the phase-one site list can change without touching logic.
 */
import { TREE_LIMITS } from './tree.js';
export const TREE_PROFILE_SPECS = Object.freeze({
    page: { limits: TREE_LIMITS, singleLine: false },
    card: { limits: TREE_LIMITS, singleLine: false },
});
/** The event that draws plugin bands and panes: `on('ui.render', { site, ... }, hook)`. */
export const UI_RENDER_EVENT = 'ui.render';
/** `ui.render` matcher: the site name only. */
export const UI_RENDER_MATCHER_FIELDS = Object.freeze([
    { name: 'site', required: true },
]);
/** A status band: text, tags, spinners and buttons; no form controls or rich content. */
const ABOVE_PROMPT_ELEMENTS = Object.freeze([
    'Box',
    'Text',
    'Button',
    'Tag',
    'Spinner',
]);
/**
 * Phase-one sites, both drawn by `ui.render` through the render chain of every plugin's matching
 * hook: `above-prompt`, one status band per session above the main composer, and `pane`, a tab in
 * the session side panel that its owner plugin opens with `ctx.ui.open`. A pane hook without `id`
 * joins every pane.
 */
export const DEFAULT_SITE_TABLE = Object.freeze([
    {
        slot: 'above-prompt',
        matcherFields: [],
        treeProfile: 'card',
        coreKind: 'none',
        elements: ABOVE_PROMPT_ELEMENTS,
    },
    {
        slot: 'pane',
        matcherFields: [{ name: 'id', required: false }],
        treeProfile: 'page',
        coreKind: 'none',
        drawnBy: UI_RENDER_EVENT,
    },
]);
/** `specs` is a test seam (@internal): production always reads `DEFAULT_SITE_TABLE`. */
export function createSiteTable(specs = DEFAULT_SITE_TABLE) {
    const bySlot = new Map();
    for (const spec of specs) {
        if (bySlot.has(spec.slot))
            throw new Error(`Duplicate site "${spec.slot}" in site table`);
        const names = spec.matcherFields.map((field) => field.name);
        if (new Set(names).size !== names.length) {
            throw new Error(`Site "${spec.slot}" declares a matcher field twice`);
        }
        if (spec.drawnBy !== undefined && spec.coreKind !== 'none') {
            throw new Error(`Site "${spec.slot}" drawn by ui.render cannot have a host default core`);
        }
        bySlot.set(spec.slot, Object.freeze({ ...spec }));
    }
    const slots = Object.freeze([...bySlot.keys()]);
    return Object.freeze({
        slots,
        get: (slot) => bySlot.get(slot),
        has: (slot) => bySlot.has(slot),
    });
}
/**
 * Sites drawn by `on('ui.render', { site, ... }, hook)` instead of `on(slot, matcher, hook)`: tree
 * sites without matcher fields and sites marked `drawnBy` (the pane). Either way the layers of an
 * instance are every plugin's hook whose matcher hits it, in chain order. A site without matcher
 * fields (`above-prompt`) has one instance per session, keyed by the site name; a `drawnBy` site
 * one per opened id, keyed `<pluginId>/<id>` (`ownedSiteKey`) after the plugin that opened it.
 */
export function isUiRenderSite(spec) {
    return spec.matcherFields.length === 0 || spec.drawnBy === UI_RENDER_EVENT;
}
/**
 * Instance key of a site drawn by `ui.render` as a tree: the owner plugin (URI-encoded, so it has
 * no `/`) and the plugin's own id, verbatim.
 */
export function ownedSiteKey(pluginId, id) {
    return `${encodeURIComponent(pluginId)}/${id}`;
}
/** Inverse of `ownedSiteKey`; `undefined` when either part is empty or the owner is malformed. */
export function parseOwnedSiteKey(key) {
    const slash = key.indexOf('/');
    if (slash <= 0 || slash === key.length - 1)
        return undefined;
    try {
        return { pluginId: decodeURIComponent(key.slice(0, slash)), id: key.slice(slash + 1) };
    }
    catch {
        return undefined;
    }
}
//# sourceMappingURL=sites.js.map