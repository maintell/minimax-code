export const DEFAULT_CDP_TIMEOUT_MS = 15_000;
export const DRAG_PATH_STEPS = 8;
export const DRAG_CANCEL_DATA = {
    items: [],
    dragOperationsMask: 0xffff,
};
export class CDPTextInputError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.name = 'CDPTextInputError';
        this.code = code;
    }
}
export class CDPDragError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.name = 'CDPDragError';
        this.code = code;
    }
}
/** Required computed styles, kept deliberately small for complex pages. */
export const REQUIRED_COMPUTED_STYLES = [
    'display',
    'visibility',
    'opacity',
    'overflow',
    'overflow-x',
    'overflow-y',
    'cursor',
    'pointer-events',
    'position',
];
export const INTERACTIVE_ROLES = new Set([
    'button',
    'link',
    'textbox',
    'searchbox',
    'checkbox',
    'radio',
    'switch',
    'combobox',
    'listbox',
    'spinbutton',
    'slider',
    'option',
    'menuitem',
    'menuitemcheckbox',
    'menuitemradio',
    'tab',
    'treeitem',
    'gridcell',
    'row',
    'cell',
]);
export const INTERACTIVE_TAGS = new Set([
    'button',
    'input',
    'select',
    'textarea',
    'a',
    'details',
    'summary',
    'option',
    'optgroup',
    'video',
    'audio',
]);
export const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'meta', 'link', 'head']);
export const CONTAINER_TAGS = new Set(['html', 'body', '#document']);
export const SVG_ELEMENTS = new Set([
    'path',
    'rect',
    'g',
    'circle',
    'ellipse',
    'line',
    'polyline',
    'polygon',
    'use',
    'defs',
    'clipPath',
    'mask',
    'pattern',
    'image',
    'text',
    'tspan',
]);
//# sourceMappingURL=cdp-helper-contracts.js.map