/**
 * Loads the property-inspector bundle (built by `vite.props-panel.config.ts`)
 * and wraps it so it installs once per document in the comment world.
 */
import fs from "node:fs";
import path from "node:path";
export let EMBEDDED_PROPS_PANEL_GLOBAL = '__mavisEmbeddedPropsPanel';
let cachedScript;
export function embeddedPropsPanelBundlePath() {
    // dist/main/modules/browser → dist/props-panel
    return path.join(__dirname, '..', '..', '..', 'props-panel', 'props-panel.js');
}
/** Returns null when the bundle has not been built; annotation keeps working without it. */
export function loadEmbeddedPropsPanelScript() {
    if (cachedScript !== undefined)
        return cachedScript;
    try {
        const code = fs.readFileSync(embeddedPropsPanelBundlePath(), 'utf8');
        cachedScript = `(() => {
  if (globalThis.${EMBEDDED_PROPS_PANEL_GLOBAL}) return { installed: true, reused: true };
  ${code}
  ;return { installed: Boolean(globalThis.${EMBEDDED_PROPS_PANEL_GLOBAL}), reused: false };
})()`;
    }
    catch {
        cachedScript = null;
    }
    return cachedScript;
}
export let EMBEDDED_PROPS_PANEL_PROBE = `Boolean(globalThis.${EMBEDDED_PROPS_PANEL_GLOBAL})`;
