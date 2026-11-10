import { matchesEmbeddedBrowserShortcutAction } from "./embedded-browser-host-shortcut";
/**
 * Find-in-page for Browser tabs, driven by the renderer's shared Cmd/Ctrl+F
 * bar. Chromium paints and scrolls the matches inside the page itself, so this
 * works the same for a WebContentsView page and a `<webview>` guest: both are
 * a WebContents in Main. Only the latest request of a tab is reported back.
 */
/** Longer queries are not useful for page find and would bloat IPC traffic. */
export let MAX_FIND_IN_PAGE_TEXT_LENGTH = 1000;
/**
 * Chromium answers the first find in a page with a final, empty result before it
 * has counted the matches; the counted result follows (~150ms on a large page).
 * An empty first result of a new find waits this long for it.
 */
export let PROVISIONAL_EMPTY_FIND_RESULT_MS = 250;
export function normalizeFindInPageRequest(value) {
    if (!value || typeof value !== 'object')
        return null;
    const raw = value;
    if (typeof raw.text !== 'string')
        return null;
    const text = raw.text.slice(0, MAX_FIND_IN_PAGE_TEXT_LENGTH);
    if (!text.trim())
        return null;
    return { text, forward: raw.forward !== false, findNext: raw.findNext === true };
}
export function normalizeFindInPageStopAction(value) {
    return value === 'keepSelection' ? 'keepSelection' : 'clearSelection';
}
/**
 * Starts (findNext=false) or continues (findNext=true) a case-insensitive page find.
 * Electron's own `findNext` option is inverted: it is Chromium's `new_session`, so it
 * must be true for a new find and false for next/previous. A new find sent with
 * `findNext: false` gets no `found-in-page` reply at all.
 */
export function runFindInPage(contents, request) {
    const requestId = contents.findInPage(request.text, {
        forward: request.forward,
        findNext: !request.findNext,
        matchCase: false,
    });
    return { text: request.text, requestId, newSession: !request.findNext };
}
/** Projects one Electron `found-in-page` result; stale request ids return null. */
export function toEmbeddedBrowserFindResult(identity, state, raw) {
    if (!state || !raw || typeof raw !== 'object')
        return null;
    const result = raw;
    if (result.requestId !== state.requestId)
        return null;
    const count = (value) => typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
    return {
        ...identity,
        text: state.text,
        requestId: state.requestId,
        activeMatchOrdinal: count(result.activeMatchOrdinal),
        matches: count(result.matches),
        finalUpdate: result.finalUpdate === true,
    };
}
/** The old document's matches are gone; the new one is searched once it loads. */
export function pendingEmbeddedBrowserFindResult(identity, state) {
    return {
        ...identity,
        text: state.text,
        requestId: state.requestId,
        activeMatchOrdinal: 0,
        matches: 0,
        finalUpdate: false,
    };
}
/**
 * Forwards a tab's find results to the search bar. An empty first result of a new
 * find is held for `holdMs`: the counted result that Chromium sends next replaces
 * it, so the bar does not flash "0 results" before the real count. A result that
 * stays empty is still reported, only later.
 */
export function createEmbeddedBrowserFindReporter(options) {
    const holdMs = options.holdMs ?? PROVISIONAL_EMPTY_FIND_RESULT_MS;
    let held = null;
    let lastReportedRequestId = null;
    const cancel = () => {
        if (held === null)
            return;
        clearTimeout(held);
        held = null;
    };
    return {
        report(result) {
            cancel();
            const state = options.current();
            if (!state || state.requestId !== result.requestId)
                return;
            const first = lastReportedRequestId !== result.requestId;
            lastReportedRequestId = result.requestId;
            if (first && state.newSession && result.finalUpdate && result.matches === 0) {
                held = setTimeout(() => {
                    held = null;
                    if (options.current()?.requestId === result.requestId)
                        options.emit(result);
                }, holdMs);
                return;
            }
            options.emit(result);
        },
        cancel,
    };
}
/** Cmd+F (macOS) / Ctrl+F (Windows) pressed inside a Browser page. */
export function isEmbeddedBrowserFindShortcut(input, overrides, platform = process.platform) {
    return matchesEmbeddedBrowserShortcutAction(input, 'session.find', overrides, platform);
}
