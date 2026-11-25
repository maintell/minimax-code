/**
 * Render tree validator shared by the renderer and the `extension test` harness: structure, token
 * props and caps, without a schema library. Objects are closed (an unknown key fails), and
 * closed-set values that render as nothing when unknown (icons, hover tone and display) become
 * `undefined` instead of failing the subtree. The cleaned value is a copy; the input is untouched.
 */
import { BOX_ALIGNS, BOX_DIRECTIONS, BOX_JUSTIFIES, BUTTON_VARIANTS, HOVER_DISPLAYS, ICON_NAMES, RADIUS_TOKENS, SIZE_TOKENS, SPACING_TOKENS, TONE_TOKENS, WEIGHT_TOKENS, } from './tokens.js';
import { checkRenderTreeLimits } from './tree-limits.js';
import { TREE_LIMITS } from './tree.js';
const KEY_MAX_LENGTH = 256;
const SHORT_STRING_MAX_LENGTH = 256;
const ok = (value) => ({ ok: true, value });
const fail = (path, message, category = 'invalid_type', aborted = true) => ({
    ok: false,
    path,
    message,
    category,
    aborted,
});
function isRecord(value) {
    return (typeof value === 'object' &&
        value !== null &&
        !Array.isArray(value) &&
        !(value instanceof Date) &&
        !(value instanceof Map) &&
        !(value instanceof Set) &&
        !('then' in value &&
            typeof value.then === 'function' &&
            'catch' in value &&
            typeof value.catch === 'function'));
}
function hasOwn(value, key) {
    return Object.prototype.hasOwnProperty.call(value, key);
}
const optional = (field) => (value, path) => value === undefined ? ok(undefined) : field(value, path);
/** Any invalid value becomes `undefined`: the renderer draws nothing for it. */
const lenient = (field) => (value, path) => {
    const result = field(value, path);
    return result.ok ? result : ok(undefined);
};
const string = (max) => (value, path) => {
    if (typeof value !== 'string')
        return fail(path, 'Expected a string');
    return value.length > max
        ? fail(path, `String longer than ${max}`, 'too_big', false)
        : ok(value);
};
const oneOf = (values) => (value, path) => typeof value === 'string' && values.includes(value)
    ? ok(value)
    : fail(path, `Expected one of ${values.join(' | ')}`);
const boolean = (value, path) => typeof value === 'boolean' ? ok(value) : fail(path, 'Expected a boolean');
const handle = (value, path) => {
    if (!isRecord(value))
        return fail(path, 'Expected a callback handle');
    return object({
        plugin: (plugin, at) => typeof plugin !== 'string'
            ? fail(at, 'Expected a string')
            : plugin.length === 0
                ? fail(at, 'Empty plugin', 'too_small', false)
                : ok(plugin),
        handle: (id, at) => {
            if (typeof id !== 'number' || Number.isNaN(id))
                return fail(at, 'Expected a number');
            if (!Number.isInteger(id))
                return fail(at, 'Expected integer', 'invalid_type', false);
            return id < 0 ? fail(at, 'Negative handle', 'too_small', false) : ok(id);
        },
    })(value, path);
};
const literal = (expected) => (value, path) => value === expected ? ok(value) : fail(path, `Expected "${expected}"`);
const array = (item) => (value, path) => {
    if (!Array.isArray(value))
        return fail(path, 'Expected an array');
    const out = [];
    let failure;
    for (let index = 0; index < value.length; index += 1) {
        const result = item(value[index], [...path, index]);
        if (!result.ok)
            failure = failure ? { ...failure, aborted: failure.aborted || result.aborted } : result;
        else
            out.push(result.value);
    }
    return failure ?? ok(out);
};
/** Closed object: declared keys are checked in order, then any other key fails. */
const object = (shape) => (value, path) => {
    if (!isRecord(value))
        return fail(path, 'Expected an object');
    const out = {};
    let failure;
    for (const [key, field] of Object.entries(shape)) {
        const result = field(value[key], [...path, key]);
        if (!result.ok)
            failure = failure ? { ...failure, aborted: failure.aborted || result.aborted } : result;
        else if (key !== '__proto__' && (result.value !== undefined || key in value))
            out[key] = result.value;
    }
    const keys = [];
    for (const key in value)
        if (!hasOwn(shape, key))
            keys.push(key);
    return (failure ??
        (keys.length === 0 ? ok(out) : fail(path, 'Unknown key', 'unrecognized_keys', false)));
};
function elementFields(limits, node) {
    const text = string(limits.maxTextLength);
    const optionalText = optional(text);
    const shortText = optional(string(SHORT_STRING_MAX_LENGTH));
    const spacing = optional(oneOf(SPACING_TOKENS));
    const tone = optional(oneOf(TONE_TOKENS));
    const size = optional(oneOf(SIZE_TOKENS));
    const flag = optional(boolean);
    const callback = optional(handle);
    const element = (type, props, children) => object({
        type: literal(type),
        key: optional(string(KEY_MAX_LENGTH)),
        props: object(props),
        ...(children ? { children: optional(array(children)) } : {}),
    });
    return {
        Box: element('Box', {
            padding: spacing,
            gap: spacing,
            direction: optional(oneOf(BOX_DIRECTIONS)),
            align: optional(oneOf(BOX_ALIGNS)),
            justify: optional(oneOf(BOX_JUSTIFIES)),
            wrap: flag,
            grow: flag,
            border: flag,
            radius: optional(oneOf(RADIUS_TOKENS)),
            background: tone,
            hover: optional(object({
                background: lenient(oneOf(TONE_TOKENS)),
                display: lenient(oneOf(HOVER_DISPLAYS)),
            })),
            scope: shortText,
        }, node),
        Text: element('Text', { size, weight: optional(oneOf(WEIGHT_TOKENS)), tone, truncate: flag }, text),
        Markdown: element('Markdown', { text }),
        Code: element('Code', { source: text, language: shortText }),
        Tag: element('Tag', { label: text, tone }),
        Button: element('Button', {
            label: text,
            tone,
            size,
            disabled: flag,
            icon: lenient(oneOf(ICON_NAMES)),
            variant: optional(oneOf(BUTTON_VARIANTS)),
            onPress: callback,
        }),
        Input: element('Input', {
            value: optionalText,
            placeholder: optionalText,
            label: optionalText,
            onInput: callback,
            onSubmit: callback,
        }),
        Select: element('Select', {
            value: optionalText,
            options: array(object({ value: text, label: text })),
            label: optionalText,
            onSelect: callback,
        }),
        Switch: element('Switch', { checked: boolean, label: optionalText, onChange: callback }),
        Spinner: element('Spinner', { label: optionalText }),
    };
}
/** Builds a validator for one set of caps (a site's tree profile) and element allow-list. */
export function createRenderTreeValidator(limits = TREE_LIMITS, options = {}) {
    const allowed = options.elements ? new Set(options.elements) : undefined;
    const text = string(limits.maxTextLength);
    const hostNode = object({ type: literal('host') });
    const host = options.coreKind === 'none'
        ? (_value, path) => fail(path, 'This site has no host view to draw', 'custom', false)
        : hostNode;
    const node = (value, path) => {
        const result = rawNode(value, path);
        // Match the old string/discriminated-object union: only non-aborted branches expose their
        // issue path. A structural failure reports the union root, not a nested speculative path.
        return !result.ok && result.aborted ? fail(path, 'Invalid input', 'invalid_union') : result;
    };
    const rawNode = (value, path) => {
        if (typeof value === 'string')
            return text(value, path);
        if (!isRecord(value))
            return fail(path, 'Expected a text or element node');
        if (value.type === 'host')
            return host(value, path);
        const type = value.type;
        if (allowed && typeof type === 'string' && hasOwn(elements, type) && !allowed.has(type)) {
            return fail([...path, 'type'], `${type} is not allowed on this site`, 'custom', false);
        }
        const field = typeof type === 'string' && hasOwn(elements, type)
            ? elements[type]
            : undefined;
        return field ? field(value, path) : fail([...path, 'type'], 'Unknown element type');
    };
    const elements = elementFields(limits, node);
    const nodes = array(node);
    return Object.freeze({
        node: (value) => node(value, []),
        tree: (value) => {
            const violation = checkRenderTreeLimits(value, limits);
            if (violation)
                return fail([], `Render tree exceeds limits: ${violation.kind}`, 'custom');
            const result = (Array.isArray(value) ? nodes : node)(value, []);
            return (!result.ok && result.aborted ? fail([], 'Invalid input', 'invalid_union') : result);
        },
    });
}
//# sourceMappingURL=tree-validator.js.map