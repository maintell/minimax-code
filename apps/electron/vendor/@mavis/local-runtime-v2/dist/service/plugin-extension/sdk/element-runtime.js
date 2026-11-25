/**
 * Element factory shared by `/ui` element functions and the JSX runtime, so
 * `Box({ children: [Text({ children: 'hi' })] })` and `<Box><Text>hi</Text></Box>` produce the
 * same plain tree. No React, no DOM, no zod: this code runs inside the extension realm.
 */
import { ELEMENT_CATALOG, isElementName } from '@mavis/shared/plugin-extension';
/**
 * Builds an isolated set of element functions and JSX factories bound to one registrar. The host
 * creates one per realm and serves `/ui` and `/jsx-runtime` from the same instance.
 */
export function createElementRuntime(registrar) {
    const createElement = (name, props, explicitKey) => {
        const wireProps = {};
        let key = explicitKey;
        let children;
        for (const [prop, value] of Object.entries(props ?? {})) {
            if (prop === 'children') {
                children = value;
            }
            else if (prop === 'key') {
                if (key === undefined || key === null)
                    key = value;
            }
            else if (value !== undefined) {
                wireProps[prop] = serializeProp(name, prop, value, registrar);
            }
        }
        const nodes = normalizeChildren(children);
        validateChildren(name, nodes);
        return {
            type: name,
            ...elementKey(key),
            props: wireProps,
            ...(nodes.length > 0 ? { children: nodes } : {}),
        };
    };
    const element = (name) => (props) => createElement(name, props);
    const ui = Object.freeze({
        Box: element('Box'),
        Text: element('Text'),
        Markdown: element('Markdown'),
        Code: element('Code'),
        Tag: element('Tag'),
        Button: element('Button'),
        Input: element('Input'),
        Select: element('Select'),
        Switch: element('Switch'),
        Spinner: element('Spinner'),
    });
    const Fragment = (props) => normalizeChildren(props.children);
    const jsx = (type, props, key) => {
        if (typeof type === 'string') {
            if (!isElementName(type))
                throw new TypeError(`Unknown element <${type}>`);
            return createElement(type, props, key);
        }
        if (typeof type !== 'function')
            throw new TypeError('JSX element type must be a function');
        const merged = key === undefined ? (props ?? {}) : { ...props, key };
        return type(merged);
    };
    return Object.freeze({ ui, jsx, jsxs: jsx, Fragment });
}
/** Flattens arrays and fragments, drops `null / undefined / boolean / ''`, stringifies numbers. */
function normalizeChildren(value) {
    const out = [];
    const visit = (child) => {
        if (emptyChild(child))
            return;
        if (Array.isArray(child)) {
            for (const item of child)
                visit(item);
            return;
        }
        if (typeof child === 'string') {
            out.push(child);
        }
        else if (typeof child === 'number') {
            out.push(String(child));
        }
        else if (typeof child === 'object' &&
            typeof child.type === 'string') {
            out.push(child);
        }
        else {
            throw new TypeError(`Unsupported child of type ${typeof child}; render elements or text`);
        }
    };
    visit(value);
    return out;
}
/**
 * The author-facing `/ui` and `/jsx-runtime` values outside a realm: they build trees, and a
 * callback prop throws because only the host's realm runtime can register it.
 */
export const defaultElementRuntime = createElementRuntime();
function elementKey(key) {
    return key === undefined || key === null ? {} : { key: String(key) };
}
function validateChildren(name, nodes) {
    const spec = ELEMENT_CATALOG[name];
    if (nodes.length > 0 && spec.children === 'none')
        throw new TypeError(`<${name}> does not take children`);
    if (spec.children === 'text' && nodes.some((node) => typeof node !== 'string'))
        throw new TypeError(`<${name}> children must be text`);
}
function emptyChild(child) {
    return child === null || child === undefined || typeof child === 'boolean' || child === '';
}
function serializeProp(name, prop, value, registrar) {
    if (typeof value !== 'function')
        return value;
    if (!ELEMENT_CATALOG[name].callbacks.includes(prop)) {
        throw new TypeError(`<${name}> does not accept a function for "${prop}"`);
    }
    if (!registrar) {
        throw new Error(`Cannot serialize <${name} ${prop}>: no HandleRegistrar is installed; callbacks only work inside the extension host`);
    }
    return registrar.register(value, { element: name, prop });
}
//# sourceMappingURL=element-runtime.js.map