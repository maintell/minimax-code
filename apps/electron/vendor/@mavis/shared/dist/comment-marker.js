import { DESKTOP_UI_FONT_FAMILY } from './desktop-typography.js';
/** Semantic project tokens used by Figma node 845:19701. */
export const COMMENT_MARKER_THEME_ROLES = {
    background: '--bg_interaction_accent_focus_blue',
    border: '--icon_default_inverted',
    text: '--text_default_inverted_static',
    shadow: '--shadow_default',
};
/** Palette keys sent from the React shell to the isolated browser bridge. */
export const COMMENT_MARKER_BRIDGE_THEME_ROLES = {
    markerBackground: COMMENT_MARKER_THEME_ROLES.background,
    markerBorder: COMMENT_MARKER_THEME_ROLES.border,
    markerText: COMMENT_MARKER_THEME_ROLES.text,
    markerShadow: COMMENT_MARKER_THEME_ROLES.shadow,
};
/** CSS variables written inside the injected page's isolated shadow root. */
export const COMMENT_MARKER_BRIDGE_THEME_VARIABLES = {
    markerBackground: '--mavis-comment-marker-background',
    markerBorder: '--mavis-comment-marker-border',
    markerText: '--mavis-comment-marker-text',
    markerShadow: '--mavis-comment-marker-shadow',
};
/**
 * Canonical marker geometry from Figma node 845:19701. Numeric values are CSS
 * pixels. Width hugs content above the 24px minimum so multi-digit labels do
 * not collide with the border. Figma's 48 radius / -12 spread shadow maps to a
 * 24px CSS blur.
 */
export const COMMENT_MARKER_SPEC = {
    size: 24,
    width: 'auto',
    borderWidth: 2,
    borderRadius: 999,
    paddingInline: 4,
    fontWeight: 500,
    fontSize: 14,
    lineHeight: 20,
    letterSpacing: 0,
    fontFamily: DESKTOP_UI_FONT_FAMILY,
    shadow: {
        offsetX: 0,
        offsetY: 0,
        blurRadius: 24,
        figmaRadius: 48,
        figmaSpread: -12,
    },
    cursor: 'pointer',
};
export function createCommentMarkerState(input) {
    return {
        number: input.number,
        label: String(input.number),
        interaction: input.interaction ?? 'idle',
        visible: input.visible ?? true,
        anchor: input.anchor,
    };
}
//# sourceMappingURL=comment-marker.js.map