import { browserErrorTripleResult } from './browser-errors.js';
export const BROWSER_TAB_FAILURES = {
    TAB_NOT_FOUND: {
        reason: 'No open Browser tab in this session has that tabId.',
        next: 'Call list_tabs for the current tabs.',
    },
    TAB_LIMIT_REACHED: {
        reason: 'This session already keeps the maximum number of Browser tabs.',
        next: 'Call list_tabs, close a tab you no longer need with close_tab { tabId }, then retry.',
    },
};
export function browserTabFailure(code, tabId) {
    return { ...browserErrorTripleResult({ code, ...BROWSER_TAB_FAILURES[code] }), code, tabId };
}
/** Reads the optional numeric `tabId` of a tab action input. */
export function readBrowserTabId(input) {
    const value = input.tabId;
    return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}
//# sourceMappingURL=browser-tabs.js.map