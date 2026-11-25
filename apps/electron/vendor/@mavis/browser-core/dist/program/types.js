import { modifierBit, platformModifier, splitKeyCombo } from '../browser-action-helpers.js';
import { isRecord } from '../browser-state.js';
import { BrowserProgramError } from './errors.js';
const MAX_CHAIN_STEPS = 32;
const MAX_LOCATOR_TEXT = 4_096;
const MAX_VALUE_CHARS = 1_048_576;
const MAX_READ_FIELDS = 50;
const MAX_TIMEOUT_MS = 120_000;
const LOAD_STATES = { load: true, domcontentloaded: true };
const ELEMENT_STATES = {
    visible: true,
    hidden: true,
    attached: true,
    detached: true,
};
const READ_KINDS = {
    text: true,
    innerText: true,
    value: true,
    selectedText: true,
    count: true,
    visible: true,
    enabled: true,
    checked: true,
    innerHTML: true,
    outerHTML: true,
};
const FIELD_KINDS = {
    text: true,
    innerText: true,
    value: true,
    html: true,
};
/** A page script's source, as page.evaluate in a run_script page script allows. */
const MAX_EVALUATE_SOURCE_CHARS = 64 * 1024;
/** The JSON argument of a page script. */
const MAX_EVALUATE_ARG_CHARS = 256 * 1024;
function invalid(message) {
    return new BrowserProgramError('INVALID_OP', message, {
        recovery: 'The page operation is malformed; fix the arguments of this call.',
    });
}
function boundedString(value, label, max = MAX_LOCATOR_TEXT) {
    if (typeof value !== 'string')
        throw invalid(`${label} must be a string.`);
    if (value.length > max)
        throw invalid(`${label} is longer than ${max} characters.`);
    return value;
}
function optionalNumber(value, label, min, max) {
    if (value === undefined)
        return undefined;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw invalid(`${label} must be a number.`);
    }
    return Math.max(min, Math.min(max, Math.floor(value)));
}
function textMatch(value, label) {
    if (typeof value === 'string')
        return boundedString(value, label);
    if (isRecord(value) && typeof value.regex === 'string') {
        return {
            regex: boundedString(value.regex, `${label} regex`),
            ...(typeof value.flags === 'string' ? { flags: boundedString(value.flags, 'flags', 8) } : {}),
        };
    }
    throw invalid(`${label} must be a string or a regular expression.`);
}
function parseStep(raw, inBranch = false) {
    if (!isRecord(raw))
        throw invalid('A locator step must be an object.');
    const exact = raw.exact === true ? { exact: true } : {};
    switch (raw.by) {
        case 'role':
            return {
                by: 'role',
                role: boundedString(raw.role, 'role', 64),
                ...(raw.name === undefined ? {} : { name: textMatch(raw.name, 'name') }),
                ...exact,
            };
        case 'text':
        case 'label':
        case 'placeholder':
            return { by: raw.by, value: textMatch(raw.value, raw.by), ...exact };
        case 'css':
            return { by: 'css', selector: boundedString(raw.selector, 'selector') };
        case 'ref':
            if (inBranch)
                throw invalid('page.ref() cannot be part of a selector list.');
            return { by: 'ref', ref: boundedString(raw.ref, 'ref') };
        case 'nth':
            if (typeof raw.index !== 'number' || !Number.isInteger(raw.index)) {
                throw invalid('nth needs an integer index.');
            }
            return { by: 'nth', index: raw.index };
        case 'filter':
            return {
                by: 'filter',
                ...(raw.hasText === undefined ? {} : { hasText: textMatch(raw.hasText, 'hasText') }),
                ...(raw.hasNotText === undefined
                    ? {}
                    : { hasNotText: textMatch(raw.hasNotText, 'hasNotText') }),
                ...(typeof raw.visible === 'boolean' ? { visible: raw.visible } : {}),
            };
        case 'or': {
            if (inBranch)
                throw invalid('A selector list cannot hold another one.');
            if (!Array.isArray(raw.chains) ||
                raw.chains.length === 0 ||
                raw.chains.length > MAX_CHAIN_STEPS) {
                throw invalid(`A selector list needs 1-${MAX_CHAIN_STEPS} chains.`);
            }
            const chains = raw.chains.map((branch) => {
                if (!Array.isArray(branch) || branch.length === 0 || branch.length > MAX_CHAIN_STEPS) {
                    throw invalid(`Each chain of a selector list needs 1-${MAX_CHAIN_STEPS} steps.`);
                }
                return branch.map((step) => parseStep(step, true));
            });
            return { by: 'or', chains };
        }
        default:
            throw invalid(`Unknown locator step ${JSON.stringify(raw.by)}.`);
    }
}
/** Steps a chain holds, those inside its selector lists included. */
function stepCount(chain) {
    let count = 0;
    for (const step of chain) {
        count += 1;
        if (step.by === 'or')
            for (const branch of step.chains)
                count += stepCount(branch);
    }
    return count;
}
function parseLocator(raw) {
    if (!isRecord(raw) || !Array.isArray(raw.chain) || raw.chain.length === 0) {
        throw invalid('A locator needs a non-empty chain.');
    }
    if (raw.chain.length > MAX_CHAIN_STEPS) {
        throw invalid(`A locator chain has at most ${MAX_CHAIN_STEPS} steps.`);
    }
    const tabId = optionalNumber(raw.tabId, 'tabId', 0, Number.MAX_SAFE_INTEGER);
    const chain = raw.chain.map((step) => parseStep(step));
    if (stepCount(chain) > MAX_CHAIN_STEPS) {
        throw invalid(`A locator chain has at most ${MAX_CHAIN_STEPS} steps, selector lists included.`);
    }
    const ref = chain.findIndex((step) => step.by === 'ref');
    if (ref > 0)
        throw invalid('page.ref() can only start a locator chain.');
    return { ...(tabId === undefined ? {} : { tabId }), chain };
}
function parseFields(raw) {
    if (!isRecord(raw))
        throw invalid('readAll fields must be an object.');
    const entries = Object.entries(raw);
    if (entries.length === 0 || entries.length > MAX_READ_FIELDS) {
        throw invalid(`readAll needs 1-${MAX_READ_FIELDS} fields.`);
    }
    return Object.fromEntries(entries.map(([name, field]) => {
        if (!isRecord(field))
            throw invalid(`Field ${JSON.stringify(name)} must be an object.`);
        const what = field.what;
        const parsedWhat = typeof what === 'string' && FIELD_KINDS[what] === true
            ? what
            : isRecord(what) && typeof what.attr === 'string'
                ? { attr: boundedString(what.attr, 'attr', 256) }
                : isRecord(what) && isRecord(what.element)
                    ? {
                        element: what.element.maxChars === undefined
                            ? {}
                            : {
                                maxChars: optionalNumber(what.element.maxChars, 'maxChars', 1, 1_000_000),
                            },
                    }
                    : (() => {
                        throw invalid(`Field ${JSON.stringify(name)} reads an unknown value.`);
                    })();
        return [
            name,
            {
                ...(field.sel === undefined ? {} : { sel: boundedString(field.sel, 'field selector') }),
                what: parsedWhat,
            },
        ];
    }));
}
function parseLoad(raw) {
    if (raw === undefined)
        return undefined;
    if (typeof raw === 'string' && LOAD_STATES[raw] === true)
        return raw;
    throw invalid('A load state must be "load" or "domcontentloaded".');
}
/**
 * Structural check of an op from the sandbox. The model's arguments reach it
 * without the Browser tool's input validation, so every field the page script
 * or a CDP command uses is checked here, once, in Browser Core.
 */
export function parseProgramOp(raw) {
    if (!isRecord(raw) || typeof raw.op !== 'string')
        throw invalid('An op needs an "op" name.');
    const base = {
        ...(raw.tabId === undefined
            ? {}
            : { tabId: optionalNumber(raw.tabId, 'tabId', 0, Number.MAX_SAFE_INTEGER) }),
        ...(raw.timeoutMs === undefined
            ? {}
            : { timeoutMs: optionalNumber(raw.timeoutMs, 'timeout', 0, MAX_TIMEOUT_MS) }),
    };
    const wait = parseLoad(raw.wait);
    switch (raw.op) {
        case 'goto':
            return {
                ...base,
                op: 'goto',
                url: boundedString(raw.url, 'url', 65_536).trim(),
                ...(wait ? { wait } : {}),
            };
        case 'back':
        case 'reload':
            return { ...base, op: raw.op, ...(wait ? { wait } : {}) };
        case 'click':
        case 'dblclick':
        case 'hover':
        case 'check':
        case 'uncheck':
            return { ...base, op: raw.op, target: parseLocator(raw.target) };
        case 'fill':
            return {
                ...base,
                op: 'fill',
                target: parseLocator(raw.target),
                value: boundedString(raw.value, 'value', MAX_VALUE_CHARS),
            };
        case 'type':
            return {
                ...base,
                op: 'type',
                ...(raw.target === undefined ? {} : { target: parseLocator(raw.target) }),
                value: boundedString(raw.value, 'value', MAX_VALUE_CHARS),
            };
        case 'press': {
            const key = boundedString(raw.key, 'key', 128);
            // An unknown modifier would be dropped and the last key typed as text.
            const unknown = splitKeyCombo(key)
                .slice(0, -1)
                .find((name) => modifierBit(platformModifier(name)) === 0);
            if (unknown !== undefined) {
                throw new BrowserProgramError('INVALID_OP', `${JSON.stringify(unknown)} in ${JSON.stringify(key)} is not a modifier key.`, {
                    recovery: 'Put Alt, Control, Meta, Shift or ControlOrMeta before the key, for example "Control+A"; to enter text use fill() or type().',
                });
            }
            return {
                ...base,
                op: 'press',
                ...(raw.target === undefined ? {} : { target: parseLocator(raw.target) }),
                key,
            };
        }
        case 'selectOption': {
            const values = Array.isArray(raw.values)
                ? raw.values.map((value) => boundedString(value, 'option'))
                : [];
            if (values.length === 0)
                throw invalid('selectOption needs at least one option.');
            return { ...base, op: 'selectOption', target: parseLocator(raw.target), values };
        }
        case 'read': {
            const what = raw.what;
            const parsedWhat = typeof what === 'string' && READ_KINDS[what] === true
                ? what
                : isRecord(what) && typeof what.attr === 'string'
                    ? { attr: boundedString(what.attr, 'attr', 256) }
                    : (() => {
                        throw invalid('read asks for an unknown value.');
                    })();
            return { ...base, op: 'read', target: parseLocator(raw.target), what: parsedWhat };
        }
        case 'readAll':
            return {
                ...base,
                op: 'readAll',
                target: parseLocator(raw.target),
                fields: parseFields(raw.fields),
                ...(raw.limit === undefined
                    ? {}
                    : { limit: optionalNumber(raw.limit, 'limit', 1, 5_000) }),
            };
        case 'rows':
            return parseRowsOp(raw, base);
        case 'waitFor':
            return parseWaitOp(raw, base);
        case 'waitForResponse':
            return {
                ...base,
                op: 'waitForResponse',
                urlIncludes: boundedString(raw.urlIncludes, 'url'),
                ...(raw.afterSequence === undefined
                    ? {}
                    : {
                        afterSequence: optionalNumber(raw.afterSequence, 'afterSequence', 0, Number.MAX_SAFE_INTEGER),
                    }),
            };
        case 'networkCheckpoint':
        case 'url':
        case 'title':
            return { ...base, op: raw.op };
        case 'observe':
            return {
                ...base,
                op: 'observe',
                ...(raw.mode === 'outline' || raw.mode === 'interactive' ? { mode: raw.mode } : {}),
            };
        case 'screenshot':
            return {
                ...base,
                op: 'screenshot',
                ...(raw.fullPage === true ? { fullPage: true } : {}),
            };
        case 'handleDialog':
            if (raw.action !== 'accept' && raw.action !== 'dismiss') {
                throw invalid("handleDialog needs action: 'accept' or 'dismiss'.");
            }
            return {
                ...base,
                op: 'handleDialog',
                dialogId: boundedString(raw.dialogId, 'dialogId'),
                action: raw.action,
                ...(typeof raw.promptText === 'string'
                    ? { promptText: boundedString(raw.promptText, 'promptText', MAX_VALUE_CHARS) }
                    : {}),
            };
        case 'mouseClick':
        case 'mouseMove':
        case 'mouseWheel':
            return parseMouseOp(raw, base);
        case 'evaluate':
            return parseEvaluateOp(raw, base);
        default:
            throw invalid(`Unknown page operation ${JSON.stringify(raw.op)}.`);
    }
}
const MOUSE_BUTTONS = { left: true, right: true, middle: true };
function viewportNumber(value, label) {
    if (typeof value !== 'number' || !Number.isFinite(value))
        throw invalid(`${label} must be a number.`);
    return Math.max(-100_000, Math.min(100_000, value));
}
/** Viewport coordinates (CSS pixels), as page.mouse takes them. */
function parseMouseOp(raw, base) {
    const x = viewportNumber(raw.x, 'x');
    const y = viewportNumber(raw.y, 'y');
    if (raw.op === 'mouseMove')
        return { ...base, op: 'mouseMove', x, y };
    if (raw.op === 'mouseWheel') {
        return {
            ...base,
            op: 'mouseWheel',
            x,
            y,
            deltaX: raw.deltaX === undefined ? 0 : viewportNumber(raw.deltaX, 'deltaX'),
            deltaY: raw.deltaY === undefined ? 0 : viewportNumber(raw.deltaY, 'deltaY'),
        };
    }
    const button = raw.button === undefined ? 'left' : raw.button;
    if (typeof button !== 'string' || MOUSE_BUTTONS[button] !== true) {
        throw invalid('button must be "left", "right" or "middle".');
    }
    const clickCount = optionalNumber(raw.clickCount, 'clickCount', 1, 3) ?? 1;
    return {
        ...base,
        op: 'mouseClick',
        x,
        y,
        button: button,
        clickCount,
    };
}
function parseEvaluateOp(raw, base) {
    const source = boundedString(raw.source, 'The page script', MAX_EVALUATE_SOURCE_CHARS);
    if (!source.trim())
        throw invalid('page.evaluate needs a function or an expression.');
    let arg;
    if (raw.arg !== undefined) {
        let json;
        try {
            json = JSON.stringify(raw.arg);
        }
        catch {
            json = undefined;
        }
        if (json === undefined || json.length > MAX_EVALUATE_ARG_CHARS) {
            throw invalid(`The page script argument must be JSON of at most ${MAX_EVALUATE_ARG_CHARS} characters.`);
        }
        arg = JSON.parse(json);
    }
    const target = raw.target === undefined ? undefined : parseLocator(raw.target);
    if (raw.all === true && !target)
        throw invalid('evaluateAll needs a locator.');
    return {
        ...base,
        op: 'evaluate',
        source,
        ...(arg === undefined ? {} : { arg }),
        ...(target ? { target } : {}),
        ...(raw.all === true ? { all: true } : {}),
        ...(raw.poll === true ? { poll: true } : {}),
    };
}
function parseRowsOp(raw, base) {
    const limit = optionalNumber(raw.limit, 'limit', 1, 200);
    const offset = optionalNumber(raw.offset, 'offset', 0, Number.MAX_SAFE_INTEGER);
    const maxChars = optionalNumber(raw.maxChars, 'maxChars', 1, 10_000);
    let fields;
    if (raw.fields !== undefined) {
        if (!isRecord(raw.fields))
            throw invalid('rows fields must map names to selectors.');
        fields = Object.fromEntries(Object.entries(raw.fields).map(([name, spec]) => [name, boundedString(spec, 'field')]));
    }
    return {
        ...base,
        op: 'rows',
        target: parseLocator(raw.target),
        ...(fields ? { fields } : {}),
        ...(limit === undefined ? {} : { limit }),
        ...(offset === undefined ? {} : { offset }),
        ...(maxChars === undefined ? {} : { maxChars }),
    };
}
function parseWaitOp(raw, base) {
    let state;
    if (raw.state !== undefined) {
        if (typeof raw.state !== 'string' || ELEMENT_STATES[raw.state] !== true) {
            throw invalid('state must be visible, hidden, attached or detached.');
        }
        state = raw.state;
    }
    const load = parseLoad(raw.load);
    if (raw.target === undefined && raw.url === undefined && raw.text === undefined && !load) {
        throw invalid('waitFor needs a locator, url, text or load state.');
    }
    return {
        ...base,
        op: 'waitFor',
        ...(raw.target === undefined ? {} : { target: parseLocator(raw.target) }),
        ...(state ? { state } : {}),
        ...(raw.url === undefined ? {} : { url: textMatch(raw.url, 'url') }),
        ...(raw.text === undefined ? {} : { text: textMatch(raw.text, 'text') }),
        ...(load ? { load } : {}),
    };
}
function quoteMatch(value) {
    return typeof value === 'string'
        ? JSON.stringify(value.slice(0, 80))
        : `/${value.regex.slice(0, 80)}/${value.flags ?? ''}`;
}
/** The locator as a program would write it; names targets in the write list and errors. */
export function describeProgramLocator(locator) {
    return describeChain(locator.chain).slice(0, 200);
}
function describeChain(chain) {
    return chain
        .map((step, index) => {
        const dot = index === 0 ? '' : '.';
        switch (step.by) {
            case 'role':
                return `${dot}getByRole(${JSON.stringify(step.role)}${step.name === undefined ? '' : `, ${quoteMatch(step.name)}`})`;
            case 'text':
                return `${dot}getByText(${quoteMatch(step.value)})`;
            case 'label':
                return `${dot}getByLabel(${quoteMatch(step.value)})`;
            case 'placeholder':
                return `${dot}getByPlaceholder(${quoteMatch(step.value)})`;
            case 'css':
                return `${dot}locator(${JSON.stringify(step.selector.slice(0, 120))})`;
            case 'ref':
                return `${dot}ref(${JSON.stringify(step.ref)})`;
            case 'nth':
                return `${dot}nth(${step.index})`;
            case 'filter':
                return `${dot}filter(${step.hasText === undefined ? '' : quoteMatch(step.hasText)})`;
            case 'or':
                return `${dot}or(${step.chains.map(describeChain).join(', ')})`;
            default:
                return '';
        }
    })
        .join('');
}
//# sourceMappingURL=types.js.map