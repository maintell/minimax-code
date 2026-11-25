import { randomBytes } from "node:crypto";
/**
 * Electron never reports wheel or touch scrolling through `before-mouse-event`
 * (Electron 42: a prevented `mouseWheel` still scrolls), so blocking input on
 * the Agent-controlled page cannot stop the user from scrolling it. This guard
 * cancels `wheel` and `touchmove` in every frame of that page instead.
 *
 * The Agent's own CDP wheel and drag input fires the same trusted DOM events;
 * the transport opens a short pass right before sending it.
 */
/** Opaque per-process name so a page cannot guess the control by reading our source. */
const GUARD_KEY = `__mavisAgentScrollGuard_${randomBytes(8).toString('hex')}`;
const AGENT_SCROLL_PASS_MS = 2000;
const FRAME_SCRIPT_TIMEOUT_MS = 250;
const INSTALL_SCRIPT = `(() => {
  const key = ${JSON.stringify(GUARD_KEY)};
  const existing = window[key];
  if (existing) { existing.block(true); return true; }
  let blocked = true;
  let passUntil = 0;
  const stop = (event) => {
    if (blocked && Date.now() > passUntil && event.cancelable) event.preventDefault();
  };
  for (const type of ['wheel', 'touchmove']) {
    window.addEventListener(type, stop, { capture: true, passive: false });
  }
  Object.defineProperty(window, key, {
    value: Object.freeze({
      block: (value) => { blocked = value === true; },
      pass: (ms) => { passUntil = Date.now() + ms; },
    }),
  });
  return true;
})()`;
const RELEASE_SCRIPT = `window[${JSON.stringify(GUARD_KEY)}]?.block(false)`;
const PASS_SCRIPT = `window[${JSON.stringify(GUARD_KEY)}]?.pass(${AGENT_SCROLL_PASS_MS})`;
const guarded = new WeakSet();
function runInFrames(contents, script) {
    let frames;
    try {
        if (contents.isDestroyed())
            return Promise.resolve();
        frames = contents.mainFrame.framesInSubtree;
    }
    catch {
        // Destroyed or not yet committed: nothing to guard.
        return Promise.resolve();
    }
    const runs = frames.map((frame) => Promise.resolve()
        .then(() => (frame.isDestroyed() ? undefined : frame.executeJavaScript(script)))
        .catch(() => undefined));
    // A busy page must not stall the Agent action or the control change.
    return Promise.race([
        Promise.all(runs).then(() => undefined),
        new Promise((resolve) => {
            const timer = setTimeout(resolve, FRAME_SCRIPT_TIMEOUT_MS);
            timer.unref?.();
        }),
    ]);
}
export function isUserScrollGuarded(contents) {
    return guarded.has(contents);
}
/** Turns the guard on or off; repeat calls re-install it in frames loaded since. */
export function setUserScrollGuard(contents, on) {
    if (on) {
        guarded.add(contents);
        return runInFrames(contents, INSTALL_SCRIPT);
    }
    if (!guarded.has(contents))
        return Promise.resolve();
    guarded.delete(contents);
    return runInFrames(contents, RELEASE_SCRIPT);
}
/** Agent CDP input that scrolls (wheel, press, drag, touch) passes the guard briefly. */
export function isAgentScrollInput(method, params) {
    if (method === 'Input.dispatchTouchEvent' || method.startsWith('Input.synthesize'))
        return true;
    if (method !== 'Input.dispatchMouseEvent')
        return false;
    const type = params?.type;
    if (type === 'mouseWheel' || type === 'mousePressed')
        return true;
    return type === 'mouseMoved' && typeof params?.buttons === 'number' && params.buttons > 0;
}
export function passAgentScroll(contents) {
    if (!guarded.has(contents))
        return Promise.resolve();
    return runInFrames(contents, PASS_SCRIPT);
}
