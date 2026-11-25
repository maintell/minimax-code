import { jsonEqual } from '@mavis/shared/plugin-extension';
/** Minimal assertions; values may come from another vm realm, so no prototype checks. */
export function createMatchers(actual) {
    const build = (negate) => {
        const check = (pass, describe) => {
            if (pass !== negate)
                return;
            throw new AssertionFailure(`expected ${show(actual)} ${negate ? 'not ' : ''}${describe}`.slice(0, 2_000));
        };
        return {
            toBe: (expected) => check(Object.is(actual, expected), `to be ${show(expected)}`),
            toEqual: (expected) => check(jsonEqual(actual, expected), `to equal ${show(expected)}`),
            toBeTruthy: () => check(Boolean(actual), 'to be truthy'),
            toBeDefined: () => check(actual !== undefined, 'to be defined'),
            toContain: (expected) => check(contains(actual, expected), `to contain ${show(expected)}`),
            toMatch: (expected) => check(typeof actual === 'string' &&
                (typeof expected === 'string'
                    ? actual.includes(expected)
                    : new RegExp(expected).test(actual)), `to match ${show(expected)}`),
        };
    };
    return { ...build(false), not: build(true) };
}
class AssertionFailure extends Error {
    name = 'AssertionFailure';
}
function contains(actual, expected) {
    if (typeof actual === 'string')
        return typeof expected === 'string' && actual.includes(expected);
    if (Array.isArray(actual))
        return actual.some((item) => jsonEqual(item, expected));
    return false;
}
function show(value) {
    if (typeof value === 'string')
        return JSON.stringify(value);
    if (typeof value === 'object' && value !== null && Symbol.match in value)
        return String(value);
    try {
        return JSON.stringify(value) ?? String(value);
    }
    catch {
        return String(value);
    }
}
//# sourceMappingURL=expect.js.map