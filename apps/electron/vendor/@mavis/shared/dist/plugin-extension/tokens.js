/**
 * Token vocabularies for element props. Props only accept token names, never pixels, colour
 * literals or class names; the renderer maps each token to host design tokens.
 */
export const SPACING_TOKENS = ['1', '1.5', '2', '3', '4', '5', '6'];
export const SIZE_TOKENS = ['xs', 'sm', 'base', 'lg'];
export const WEIGHT_TOKENS = ['default', 'medium', 'semibold'];
export const TONE_TOKENS = [
    'primary',
    'secondary',
    'tertiary',
    'accent',
    'danger',
    'success',
    'warning',
];
export const RADIUS_TOKENS = ['sm', 'md', 'lg', 'full'];
export const BOX_DIRECTIONS = ['row', 'column'];
export const BOX_ALIGNS = ['start', 'center', 'end', 'stretch'];
export const BOX_JUSTIFIES = ['start', 'center', 'end', 'between'];
/** Visibility of a `Box` while its hover `scope` is hovered. */
export const HOVER_DISPLAYS = ['show', 'hide'];
export const BUTTON_VARIANTS = ['default', 'plain'];
/**
 * `Icon` is a value type, not an element: a closed set of names the renderer maps to host icon
 * components. Unknown names render as nothing; custom SVG is not accepted.
 */
export const ICON_NAMES = [
    'plus',
    'minus',
    'check',
    'close',
    'search',
    'refresh',
    'settings',
    'edit',
    'trash',
    'copy',
    'link',
    'external-link',
    'file',
    'folder',
    'code',
    'terminal',
    'play',
    'stop',
    'kanban',
    'list',
    'info',
    'warning',
    'error',
    'star',
    'user',
    'clock',
    'calendar',
    'bug',
    'branch',
    'plugin',
    'chevron-right',
    'chevron-down',
    'more',
];
/** `Icon.plus === 'plus'`; any prop typed `IconName` also accepts the string literal. */
export const Icon = Object.freeze(Object.fromEntries(ICON_NAMES.map((name) => [name, name])));
//# sourceMappingURL=tokens.js.map