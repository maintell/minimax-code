// The cross-end wire contract between the Extension runtime and the renderer. The author model
// (`ctx`, state, hooks, observe events, function-callback props, JSX and diagnostics) belongs to
// the runtime's `plugin-extension/sdk/`, not here.
export { isHandle, jsonEqual, TREE_LIMITS } from './tree.js';
export { checkRenderTreeLimits } from './tree-limits.js';
export { createRenderTreeValidator } from './tree-validator.js';
export { ELEMENT_CATALOG, ELEMENT_NAMES, isElementName } from './catalog.js';
export * from './tokens.js';
export { createSiteTable, DEFAULT_SITE_TABLE, isUiRenderSite, ownedSiteKey, parseOwnedSiteKey, TREE_PROFILE_SPECS, UI_RENDER_EVENT, UI_RENDER_MATCHER_FIELDS, } from './sites.js';
//# sourceMappingURL=index.js.map