import { matchesKeyboardEvent } from "@mavis/shared/keyboard-shortcuts";
import { toKeyboardEvent } from "./embedded-browser-host-shortcut";
/**
 * Reload of a Browser page, driven by the page itself.
 *
 * Cmd+R (macOS) / Ctrl+R (Windows) inside a page reloads that page. The page
 * claims the key in its own `before-input-event`: Electron cancels the app
 * menu shortcuts when that event is prevented, so the Window ▸ Reload
 * accelerator never reloads the whole app window while the page owns the
 * focus. Outside a page the menu accelerator keeps reloading the app window.
 */
/** The page reload accelerator of each platform. */
const RELOAD_ACCELERATOR = {
    mac: 'Command+R',
    windows: 'Ctrl+R',
};
/** Cmd+R (macOS) / Ctrl+R (Windows) pressed inside a Browser page. */
export function isEmbeddedBrowserReloadShortcut(input, platform = process.platform) {
    if (input.type !== 'keyDown' || input.isAutoRepeat || input.isComposing)
        return false;
    const shortcutPlatform = platform === 'darwin' ? 'mac' : 'windows';
    return matchesKeyboardEvent(RELOAD_ACCELERATOR[shortcutPlatform], toKeyboardEvent(input), shortcutPlatform);
}
