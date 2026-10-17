const modifierCodes = new Set([
    'ControlLeft',
    'ControlRight',
    'AltLeft',
    'AltRight',
    'ShiftLeft',
    'ShiftRight',
    'MetaLeft',
    'MetaRight',
    'Fn',
]);
const codeToKey = {
    Digit0: '0',
    Digit1: '1',
    Digit2: '2',
    Digit3: '3',
    Digit4: '4',
    Digit5: '5',
    Digit6: '6',
    Digit7: '7',
    Digit8: '8',
    Digit9: '9',
    Space: 'Space',
    Enter: 'Enter',
    Tab: 'Tab',
    Escape: 'Escape',
    Backspace: 'Backspace',
    Delete: 'Delete',
    Insert: 'Insert',
    Home: 'Home',
    End: 'End',
    PageUp: 'PageUp',
    PageDown: 'PageDown',
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    Minus: '-',
    Equal: '=',
    BracketLeft: '[',
    BracketRight: ']',
    Backslash: '\\',
    Semicolon: ';',
    Quote: "'",
    Backquote: '`',
    Comma: ',',
    Period: '.',
    Slash: '/',
};
const modifierAliases = {
    cmd: 'Command',
    command: 'Command',
    meta: 'Command',
    ctrl: 'Ctrl',
    control: 'Ctrl',
    alt: 'Alt',
    option: 'Alt',
    opt: 'Alt',
    shift: 'Shift',
    fn: 'Fn',
};
const modifierOrder = ['Command', 'Ctrl', 'Alt', 'Shift', 'Fn'];
/** `KeyboardEvent.key` reported when the modifier key itself is pressed or released. */
const modifierEventKeys = {
    Command: 'Meta',
    Ctrl: 'Control',
    Alt: 'Alt',
    Shift: 'Shift',
    Fn: 'Fn',
};
function isAcceleratorModifier(value) {
    return modifierOrder.includes(value);
}
function keyFromEvent(event) {
    if (modifierCodes.has(event.code))
        return null;
    if (event.code.startsWith('Key') && event.code.length === 4) {
        return event.code.slice(3).toUpperCase();
    }
    if (/^F(?:[1-9]|1[0-2])$/.test(event.code)) {
        return event.code;
    }
    const mapped = codeToKey[event.code];
    if (mapped)
        return mapped;
    if (event.key.length === 1 && /[a-zA-Z0-9]/.test(event.key)) {
        return event.key.toUpperCase();
    }
    return null;
}
export function keyboardEventToAccelerator(event, platform) {
    const key = keyFromEvent(event);
    if (!key)
        return null;
    if (platform === 'windows' && event.metaKey)
        return null;
    // Windows AltGr (right Alt) reports ctrlKey+altKey both true while the user
    // is just typing a layout character (e.g. AltGr+C = ć on Polish layouts), so
    // an AltGraph-active combination must count as typing, never as a shortcut.
    // Deliberately scoped to Windows: macOS Chromium's AltGraph reporting for
    // the Option key varies across versions and a global guard could kill
    // legitimate Command+Option shortcuts. The optional call keeps environments
    // without getModifierState (plain objects, older jsdom) matching normally
    // (fail-open).
    if (platform === 'windows' && event.getModifierState?.('AltGraph'))
        return null;
    const modifiers = [];
    if (event.metaKey)
        modifiers.push('Command');
    if (event.ctrlKey)
        modifiers.push('Ctrl');
    if (event.altKey)
        modifiers.push('Alt');
    if (event.shiftKey)
        modifiers.push('Shift');
    if (event.getModifierState?.('Fn'))
        modifiers.push('Fn');
    if (modifiers.length === 0)
        return null;
    return [...modifiers, key].join('+');
}
export function normalizeAccelerator(accelerator) {
    const parts = accelerator
        .split('+')
        .map((part) => part.trim())
        .filter(Boolean);
    const modifiers = new Set();
    let key = '';
    for (const part of parts) {
        const modifier = modifierAliases[part.toLowerCase()];
        if (modifier) {
            modifiers.add(modifier);
        }
        else {
            key = part.length === 1 ? part.toUpperCase() : part;
        }
    }
    return [
        ...modifierOrder.filter((modifier) => modifiers.has(modifier)),
        ...(key ? [key] : []),
    ].join('+');
}
/**
 * Returns the `KeyboardEvent.key` of the accelerator's leading modifier (in the
 * normalized modifier order), or null when there is no accelerator or no modifier.
 * Lets hold-to-reveal affordances listen for the modifier a user actually
 * configured (e.g. `Alt` for `Alt+1`) instead of a platform default.
 */
export function getLeadingModifierEventKey(accelerator) {
    if (!accelerator)
        return null;
    const [leading = ''] = normalizeAccelerator(accelerator).split('+');
    return isAcceleratorModifier(leading) ? modifierEventKeys[leading] : null;
}
export function matchesKeyboardEvent(accelerator, event, platform) {
    const fromEvent = keyboardEventToAccelerator(event, platform);
    return fromEvent !== null && normalizeAccelerator(accelerator) === fromEvent;
}
export function formatShortcut(accelerator, platform) {
    if (!accelerator)
        return '';
    const normalized = normalizeAccelerator(accelerator);
    if (platform === 'windows')
        return normalized;
    return normalized
        .split('+')
        .map((part) => {
        if (part === 'Command')
            return '⌘';
        if (part === 'Ctrl')
            return '⌃';
        if (part === 'Alt')
            return '⌥';
        if (part === 'Shift')
            return '⇧';
        if (part === 'Fn')
            return 'fn';
        return part;
    })
        .join('');
}
//# sourceMappingURL=accelerator.js.map