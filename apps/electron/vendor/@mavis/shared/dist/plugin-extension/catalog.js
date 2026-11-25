/**
 * Element catalog (two.md §6): ten elements, all in the core tier. Only leaf elements take
 * callbacks; `Box` has no callback prop and clickable rows use `Button` with `variant="plain"`.
 *
 * This is the wire side of the catalog: element metadata, presentation fields and `Handle`-typed
 * props as the renderer receives them. Author props with `ctx` callbacks and JSX belong to the
 * Extension runtime (`local-runtime-v2` `plugin-extension/sdk/contracts/`).
 */
export const ELEMENT_NAMES = [
    'Box',
    'Text',
    'Markdown',
    'Code',
    'Tag',
    'Button',
    'Input',
    'Select',
    'Switch',
    'Spinner',
];
export const ELEMENT_CATALOG = Object.freeze({
    Box: { callbacks: [], children: 'nodes' },
    Text: { callbacks: [], children: 'text' },
    Markdown: { callbacks: [], children: 'none' },
    Code: { callbacks: [], children: 'none' },
    Tag: { callbacks: [], children: 'none' },
    Button: { callbacks: ['onPress'], children: 'none' },
    Input: { callbacks: ['onInput', 'onSubmit'], children: 'none' },
    Select: { callbacks: ['onSelect'], children: 'none' },
    Switch: { callbacks: ['onChange'], children: 'none' },
    Spinner: { callbacks: [], children: 'none' },
});
export function isElementName(value) {
    return typeof value === 'string' && Object.prototype.hasOwnProperty.call(ELEMENT_CATALOG, value);
}
//# sourceMappingURL=catalog.js.map