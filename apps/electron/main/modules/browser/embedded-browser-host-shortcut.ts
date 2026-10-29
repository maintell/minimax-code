import { resolveShortcutBindings, matchesKeyboardEvent, keyboardEventToAccelerator } from "@mavis/shared/keyboard-shortcuts";
const EMBEDDED_BROWSER_SHORTCUT_ACTIONS = [
    'workspacePanel.closeCurrentTab',
    'browser.open',
    'files.open',
];
function toKeyboardEvent(input) {
    // Electron's before-input-event Input has no getModifierState. Some
    // Electron versions surface an 'altgr' entry in Input.modifiers — honor it
    // so AltGr typing on Windows layouts is never treated as a shortcut (the
    // shared matcher applies its Windows AltGraph guard). When the entry is
    // absent this stays fail-open, which is acceptable: the forwarded surface
    // is only Ctrl+W/T/P and default bindings carry no Alt, so plain AltGr
    // combinations (Ctrl+Alt) cannot match them anyway. Needs real-Windows
    // verification for the exact modifiers payload.
    const altGr = input.modifiers?.some((modifier) => modifier.toLowerCase() === 'altgr') ?? false;
    return {
        code: input.code,
        key: input.key,
        ctrlKey: input.control,
        metaKey: input.meta,
        altKey: input.alt,
        shiftKey: input.shift,
        getModifierState: (state) => state === 'AltGraph' && altGr,
    };
}
/**
 * True when a raw `before-input-event` Input matches one action's resolved
 * bindings. Shared by `forwardEmbeddedBrowserHostShortcut` (which forwards a
 * batch of actions to the File Panel host) and callers that need to
 * recognize a single action locally — e.g. a detached Mini App window
 * handling its own Cmd/Ctrl+W instead of forwarding it.
 */
export function matchesEmbeddedBrowserShortcutAction(input, action, overrides, platform = process.platform) {
    if (input.type !== 'keyDown' || input.isAutoRepeat || input.isComposing)
        return false;
    const shortcutPlatform = platform === 'darwin' ? 'mac' : 'windows';
    const keyboardEvent = toKeyboardEvent(input);
    return resolveShortcutBindings(action, overrides, shortcutPlatform).some((binding) => matchesKeyboardEvent(binding, keyboardEvent, shortcutPlatform));
}
/** Native page key events do not bubble into the host renderer. */
export function forwardEmbeddedBrowserHostShortcut(event, input, host, overrides, platform = process.platform) {
    const matches = EMBEDDED_BROWSER_SHORTCUT_ACTIONS.some((action) => matchesEmbeddedBrowserShortcutAction(input, action, overrides, platform));
    const contents = host?.webContents;
    if (!matches || !host || host.isDestroyed() || !contents || contents.isDestroyed())
        return false;
    const shortcutPlatform = platform === 'darwin' ? 'mac' : 'windows';
    const keyboardEvent = toKeyboardEvent(input);
    const modifiers = [];
    if (input.control)
        modifiers.push('control');
    if (input.meta)
        modifiers.push('meta');
    if (input.alt)
        modifiers.push('alt');
    if (input.shift)
        modifiers.push('shift');
    event.preventDefault();
    contents.focus();
    // Send a balanced pair; the host owns action routing and modal/dirty guards.
    const keyCode = keyboardEventToAccelerator(keyboardEvent, shortcutPlatform)?.split('+').at(-1) ?? input.key;
    contents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    contents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
    return true;
}
