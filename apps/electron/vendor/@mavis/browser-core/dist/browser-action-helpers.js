import { asString, isRecord } from './browser-state.js';
/** Classify root-page and iframe lifecycle events consistently for every provider. */
export function classifyBrowserNavigationEvent(event, transport, mainFrameId) {
    if (!event ||
        (event.method !== 'Page.frameNavigated' && event.method !== 'Page.navigatedWithinDocument')) {
        return 'unknown';
    }
    const params = isRecord(event.params) ? event.params : {};
    const frame = isRecord(params.frame) ? params.frame : {};
    const frameId = asString(frame.id) || asString(params.frameId);
    const eventSessionId = event.sessionId;
    if (eventSessionId &&
        (transport.listAttachedFrames?.() ?? []).some((candidate) => candidate.sessionId === eventSessionId)) {
        return 'child';
    }
    if (asString(frame.parentId))
        return 'child';
    if (mainFrameId && frameId)
        return frameId === mainFrameId ? 'main' : 'child';
    if (eventSessionId && eventSessionId !== transport.sessionId)
        return 'unknown';
    return frameId ? 'main' : 'unknown';
}
export function waitExpression(input) {
    const selector = asString(input.selector);
    const text = asString(input.text);
    const url = asString(input.url);
    const kind = asString(input.kind);
    const load = input.load === true || kind === 'load';
    const selectorState = asString(input.state, selector ? 'visible' : 'attached');
    if (selector && !new Set(['attached', 'detached', 'visible', 'hidden']).has(selectorState)) {
        throw new Error(`Unsupported Browser wait selector state: ${selectorState}`);
    }
    return `(() => {
    ${selector
        ? `
      const elements = Array.from(document.querySelectorAll(${JSON.stringify(selector)}));
      const state = ${JSON.stringify(selectorState)};
      const matched = elements.length;
      if (state === 'attached' || state === 'detached') {
        if ((state === 'attached') !== (matched > 0)) return { met: false, matched };
      } else {
        let visible = 0;
        for (const element of elements) {
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          if (!element.hasAttribute('hidden') &&
            style.display !== 'none' && style.visibility !== 'hidden' &&
            style.opacity !== '0' && rect.width > 0 && rect.height > 0) {
            visible += 1;
            if (state === 'visible') break;
          }
        }
        if ((state === 'visible') !== (visible > 0)) return { met: false, matched, visible };
      }
    `
        : ''}
    ${text ? `if (!String(document.body?.innerText || '').includes(${JSON.stringify(text)})) return { met: false };` : ''}
    ${url ? `if (!location.href.includes(${JSON.stringify(url)})) return { met: false };` : ''}
    ${load ? "if (document.readyState !== 'complete') return { met: false };" : ''}
    return { met: true };
  })()`;
}
/**
 * Recovery for a selector wait that timed out, from the counts of its last
 * poll. Without it the model could not tell a wrong selector from a hidden
 * first match or a page that never finished.
 */
export function waitSelectorTimeoutRecovery(selector, state, poll) {
    const matched = poll.matched;
    if (matched === undefined)
        return undefined;
    const quoted = JSON.stringify(selector);
    if ((state === 'visible' || state === 'attached') && matched === 0) {
        return `No element matches ${quoted}. Inspect the page or query kind "text" to find the element instead of guessing the selector.`;
    }
    if (state === 'visible') {
        return `${matched} element(s) match ${quoted} but none is visible. Use a more specific selector for the visible element, or pass state: "attached" if presence is enough.`;
    }
    if (state === 'hidden') {
        return `${poll.visible ?? 0} of ${matched} element(s) matching ${quoted} are still visible.`;
    }
    return state === 'detached' ? `${matched} element(s) still match ${quoted}.` : undefined;
}
export function buttonName(value) {
    return value === 'right' || value === 'middle' ? value : 'left';
}
export function modifierBit(value) {
    switch (value.toLowerCase()) {
        case 'alt':
            return 1;
        case 'control':
        case 'ctrl':
            return 2;
        case 'meta':
        case 'command':
            return 4;
        case 'shift':
            return 8;
        default:
            return 0;
    }
}
/**
 * The keys of a combo such as "Control+Shift+A", modifiers first: a trailing
 * "+" is the plus key ("Control++"), and a single character is itself. The
 * run_script keyboard splits a combo by the same rules.
 */
export function splitKeyCombo(combo) {
    if (combo.length <= 1 || combo.indexOf('+') <= 0)
        return [combo];
    const parts = combo.split('+');
    if (parts[parts.length - 1] === '') {
        parts.pop();
        parts[parts.length - 1] = '+';
    }
    return parts.filter((part) => part.length > 0);
}
/** Playwright's "ControlOrMeta": Meta on macOS, Control elsewhere; any other name as it is. */
export function platformModifier(name) {
    if (name.toLowerCase() !== 'controlormeta')
        return name;
    return process.platform === 'darwin' ? 'Meta' : 'Control';
}
//# sourceMappingURL=browser-action-helpers.js.map