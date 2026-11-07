const BARRIER_WORLD_ID = 1007;
const BARRIER_TIMEOUT_MS = 500;
const MAX_REMOTE_FRAME_DEPTH = 4;
const CDP_ALT = 1;
const CDP_CONTROL = 2;
const CDP_META = 4;
const CDP_SHIFT = 8;
const NAMED_KEYS = {
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    Enter: 'Enter',
    Escape: 'Escape',
    Backspace: 'Backspace',
    Tab: 'Tab',
    Delete: 'Delete',
    Home: 'Home',
    End: 'End',
    PageUp: 'PageUp',
    PageDown: 'PageDown',
    Insert: 'Insert',
    ' ': 'Space',
    Shift: 'Shift',
    Control: 'Control',
    Alt: 'Alt',
    Meta: 'Meta',
};
const CODE_KEYS = {
    Space: 'Space',
    Minus: '-',
    Equal: '=',
    BracketLeft: '[',
    BracketRight: ']',
    Backslash: '\\',
    Semicolon: ';',
    Quote: "'",
    Comma: ',',
    Period: '.',
    Slash: '/',
    Backquote: '`',
};
/**
 * Resolves the frame owner of the focused element when focus sits in a frame
 * this document cannot reach (a cross-origin iframe).
 */
const FOCUSED_REMOTE_FRAME_EXPRESSION = `(() => {
  let active = document.activeElement;
  for (let depth = 0; active && depth < 32; depth += 1) {
    if (active.shadowRoot && active.shadowRoot.activeElement) {
      active = active.shadowRoot.activeElement;
      continue;
    }
    if (active.tagName !== 'IFRAME' && active.tagName !== 'FRAME') return null;
    let inner = null;
    try { inner = active.contentDocument; } catch { inner = null; }
    if (!inner) return active;
    if (!inner.activeElement || inner.activeElement === inner.body) return null;
    active = inner.activeElement;
  }
  return null;
})()`;
/** Runs editing commands (CDP `commands`) in the guest's focused same-process document. */
const editingCommandScript = (commands) => `(() => {
  let doc = document;
  for (let depth = 0; depth < 32; depth += 1) {
    const active = doc.activeElement;
    if (!active || (active.tagName !== 'IFRAME' && active.tagName !== 'FRAME')) break;
    let inner = null;
    try { inner = active.contentDocument; } catch { inner = null; }
    if (!inner) break;
    doc = inner;
  }
  for (const command of ${JSON.stringify(commands)}) doc.execCommand(command);
  return true;
})()`;
/**
 * sendInputEvent reports no completion. The barrier sends an otherwise unused
 * key (F24) and waits until an isolated-world listener has seen it, which
 * proves the earlier input reached the page before anything reads it.
 */
export let BARRIER_INSTALL_SCRIPT = `(() => {
  const state = window.__mavisGuestInputBarrier || (window.__mavisGuestInputBarrier = {
    count: 0, waiters: [], hooked: new WeakSet(),
  });
  // Runs before every barrier: pages add same-origin frames, and a frame that
  // navigates gets a new document whose window has none of the old listeners.
  // Installation is deduplicated per document, the frame walk is not.
  const hook = (target) => {
    try {
      const doc = target.document;
      if (!state.hooked.has(doc)) {
        state.hooked.add(doc);
        target.addEventListener('keydown', (event) => {
          if (event.key === 'F24') event.stopImmediatePropagation();
        }, true);
        target.addEventListener('keyup', (event) => {
          if (event.key !== 'F24') return;
          event.stopImmediatePropagation();
          state.count += 1;
          const waiters = state.waiters;
          state.waiters = [];
          for (const wake of waiters) wake();
        }, true);
      }
      for (const frame of doc.querySelectorAll('iframe,frame'))
        if (frame.contentWindow) hook(frame.contentWindow);
    } catch {
      // Cross-origin frames cannot be hooked; their input uses CDP sessions.
    }
  };
  hook(window);
  return state.count;
})()`;
const barrierWaitScript = (expected) => `new Promise((resolve) => {
  const state = window.__mavisGuestInputBarrier;
  if (!state) return resolve(false);
  const timer = setTimeout(() => resolve(false), ${BARRIER_TIMEOUT_MS});
  const check = () => {
    if (state.count >= ${expected}) {
      clearTimeout(timer);
      resolve(true);
    } else state.waiters.push(check);
  };
  check();
})`;
const agentPointerDepth = new WeakMap();
let agentPointerListener = null;
/** The guest registry forwards announcements to the guest's host document. */
export function setAgentPointerListener(listener) {
    agentPointerListener = listener;
}
/** True while an Agent pointer command is being delivered to this guest. */
export function isAgentPointerActive(guest) {
    return (agentPointerDepth.get(guest) ?? 0) > 0;
}
/**
 * Marks Agent pointer input on a guest. Chromium moves host focus onto the
 * `<webview>` for a pressed button; the guest registry uses this mark to hand
 * focus back to the user's element instead of keeping it on the page.
 */
export async function withAgentPointer(guest, run, options = {}) {
    agentPointerDepth.set(guest, (agentPointerDepth.get(guest) ?? 0) + 1);
    try {
        // Announce before the press so the host can restore focus as soon as the
        // <webview> takes it, ahead of treating it as a user interaction.
        if (options.announce) {
            try {
                agentPointerListener?.(guest);
            }
            catch {
                // Focus restoration must never block pointer input.
            }
        }
        return await run();
    }
    finally {
        const depth = (agentPointerDepth.get(guest) ?? 1) - 1;
        if (depth > 0)
            agentPointerDepth.set(guest, depth);
        else
            agentPointerDepth.delete(guest);
    }
}
function modifierNames(mask, autoRepeat) {
    const names = [];
    if (mask & CDP_ALT)
        names.push('alt');
    if (mask & CDP_CONTROL)
        names.push('control');
    if (mask & CDP_META)
        names.push('meta');
    if (mask & CDP_SHIFT)
        names.push('shift');
    if (autoRepeat)
        names.push('isautorepeat');
    return names;
}
function acceleratorKey(key, code) {
    const named = NAMED_KEYS[key];
    if (named)
        return named;
    if (/^F([1-9]|1[0-9]|2[0-4])$/u.test(key))
        return key;
    const letter = /^Key([A-Z])$/u.exec(code)?.[1];
    if (letter)
        return letter.toLowerCase();
    const digit = /^Digit([0-9])$/u.exec(code)?.[1];
    if (digit)
        return digit;
    const symbol = CODE_KEYS[code];
    if (symbol)
        return symbol;
    if ([...key].length === 1)
        return key.toLowerCase();
    return null;
}
/** Translates one CDP `Input.dispatchKeyEvent` into Electron input events. */
export function cdpKeyEventToElectron(params) {
    const type = typeof params.type === 'string' ? params.type : '';
    const key = typeof params.key === 'string' ? params.key : '';
    const code = typeof params.code === 'string' ? params.code : '';
    const text = typeof params.text === 'string' ? params.text : '';
    const mask = typeof params.modifiers === 'number' ? params.modifiers : 0;
    const modifiers = modifierNames(mask, params.autoRepeat === true);
    // A character event inserts its text as typed, including non-ASCII text.
    // Chromium treats only '\r' as the Enter character.
    const charEvent = (value) => ({
        type: 'char',
        keyCode: value === '\n' ? '\r' : value,
        modifiers,
    });
    if (type === 'char')
        return text ? [charEvent(text)] : [];
    const keyCode = acceleratorKey(key, code);
    if (type === 'keyUp')
        return keyCode ? [{ type: 'keyUp', keyCode, modifiers }] : [];
    if (type !== 'keyDown' && type !== 'rawKeyDown')
        return [];
    const events = keyCode ? [{ type: 'keyDown', keyCode, modifiers }] : [];
    // CDP keyDown with text both dispatches the key and inserts its text.
    if (type === 'keyDown' && text)
        events.push(charEvent(text));
    return events;
}
function editingCommands(params) {
    if (!Array.isArray(params.commands))
        return [];
    return params.commands
        .filter((command) => typeof command === 'string')
        .map((command) => command.charAt(0).toLowerCase() + command.slice(1))
        .filter((command) => /^[a-zA-Z]+$/u.test(command));
}
export function isWebviewGuest(webContents) {
    try {
        return typeof webContents.getType === 'function' && webContents.getType() === 'webview';
    }
    catch {
        return false;
    }
}
export function isGuestKeyboardCommand(method) {
    return method === 'Input.insertText' || method === 'Input.dispatchKeyEvent';
}
function abortedInputError() {
    return new Error('ABORTED: guest keyboard input was cancelled');
}
function throwIfAborted(signal) {
    if (signal?.aborted)
        throw abortedInputError();
}
/**
 * `signal` fires when the caller cancels or the command deadline passes. Each
 * step that could still type into the page checks it first, so no input lands
 * after the caller has already been told the command was aborted.
 */
export async function sendGuestKeyboardCommand(webContents, sendCommand, attachedFrameSession, method, params = {}, signal) {
    const target = await resolveFocusTarget(webContents, sendCommand, attachedFrameSession, signal);
    if (target.kind === 'session') {
        try {
            throwIfAborted(signal);
            return await sendCommand(method, params, target.sessionId);
        }
        finally {
            if (target.temporary)
                await sendCommand('Target.detachFromTarget', { sessionId: target.sessionId }).catch(() => undefined);
        }
    }
    if (method === 'Input.insertText') {
        const text = typeof params.text === 'string' ? params.text : '';
        if (!text)
            return {};
        throwIfAborted(signal);
        if (target.kind === 'guest') {
            await webContents.insertText(text);
            return {};
        }
        for (const char of text) {
            throwIfAborted(signal);
            for (const event of cdpKeyEventToElectron({ type: 'char', text: char }))
                webContents.sendInputEvent(event);
        }
        await inputBarrier(webContents);
        return {};
    }
    throwIfAborted(signal);
    for (const event of cdpKeyEventToElectron(params))
        webContents.sendInputEvent(event);
    await inputBarrier(webContents);
    const commands = editingCommands(params);
    throwIfAborted(signal);
    if (commands.length > 0 && params.type !== 'keyUp')
        await webContents.executeJavaScriptInIsolatedWorld(BARRIER_WORLD_ID, [
            { code: editingCommandScript(commands) },
        ]);
    return {};
}
async function inputBarrier(webContents) {
    try {
        const count = await webContents.executeJavaScriptInIsolatedWorld(BARRIER_WORLD_ID, [
            { code: BARRIER_INSTALL_SCRIPT },
        ]);
        if (typeof count !== 'number')
            return;
        webContents.sendInputEvent({ type: 'keyDown', keyCode: 'F24' });
        webContents.sendInputEvent({ type: 'keyUp', keyCode: 'F24' });
        await webContents.executeJavaScriptInIsolatedWorld(BARRIER_WORLD_ID, [
            { code: barrierWaitScript(count + 1) },
        ]);
    }
    catch {
        // Ordering is best effort when the page cannot run the barrier.
    }
}
async function resolveFocusTarget(webContents, sendCommand, attachedFrameSession, signal) {
    let target = { kind: 'guest' };
    const temporaries = [];
    try {
        for (let depth = 0; depth < MAX_REMOTE_FRAME_DEPTH; depth += 1) {
            throwIfAborted(signal);
            const sessionId = target.kind === 'session' ? target.sessionId : undefined;
            const evaluated = (await sendCommand('Runtime.evaluate', { expression: FOCUSED_REMOTE_FRAME_EXPRESSION }, sessionId));
            const objectId = evaluated?.result?.subtype === 'node' ? evaluated.result.objectId : '';
            if (!objectId)
                break;
            let frameId;
            try {
                const described = (await sendCommand('DOM.describeNode', { objectId }, sessionId));
                frameId = described?.node?.frameId;
            }
            finally {
                await sendCommand('Runtime.releaseObject', { objectId }, sessionId).catch(() => undefined);
            }
            if (!frameId)
                break;
            const known = attachedFrameSession(frameId);
            if (known) {
                target = { kind: 'session', sessionId: known, temporary: false };
                continue;
            }
            const attached = (await sendCommand('Target.attachToTarget', { targetId: frameId, flatten: true }, sessionId).catch(() => null));
            if (!attached?.sessionId) {
                // No target of its own: the frame renders in the guest process.
                if (target.kind === 'guest')
                    target = { kind: 'local-frame' };
                break;
            }
            temporaries.push(attached.sessionId);
            target = { kind: 'session', sessionId: attached.sessionId, temporary: true };
        }
    }
    catch {
        // Unresolvable focus falls back to the guest widget, unless the command was
        // cancelled: a failed probe must not turn into typing into the page.
    }
    const aborted = signal?.aborted === true;
    // Only the innermost temporary session is kept for the command itself.
    for (const sessionId of temporaries)
        if (aborted || target.kind !== 'session' || sessionId !== target.sessionId)
            await sendCommand('Target.detachFromTarget', { sessionId }).catch(() => undefined);
    if (aborted)
        throw abortedInputError();
    return target;
}
