import { hasMinimumVisibleArea } from "../window-state/bounds";
import { currentWorkAreas } from "../window-state/displays";
/** Host defaults for a popped-out window when the manifest leaves `min*` undeclared. */
const DETACHED_WINDOW_MIN_WIDTH = 480;
const DETACHED_WINDOW_MIN_HEIGHT = 360;
/**
 * A rejected `x`/`y`/`width`/`height` change needs at least this many px of
 * overlap with a display's `workArea`, on both axes, to count as on-screen.
 */
const ON_SCREEN_MIN_VISIBLE_PX = 40;
/**
 * Electron exposes no getter for click-through or skip-taskbar, so the last
 * applied value is tracked per native window (GC'd with it). A window with no
 * entry still carries its manifest declaration from construction.
 */
const appliedFlags = new WeakMap();
/** Tabs with a mode switch in flight; every other handle call reports `busy`. */
const switchingTabs = new WeakSet();
/** Minimum content size of a popped-out window: the manifest declaration, else the Host default. */
export function resolveDetachedWindowMinSize(declared) {
    return {
        minWidth: declared?.minWidth ?? DETACHED_WINDOW_MIN_WIDTH,
        minHeight: declared?.minHeight ?? DETACHED_WINDOW_MIN_HEIGHT,
    };
}
function fail(code) {
    return { success: false, code };
}
function liveWindow(tab) {
    const window = tab.detachedWindow;
    return window && !window.isDestroyed() ? window : null;
}
export function readMiniAppWindowState(tab) {
    const window = liveWindow(tab);
    if (!window)
        return { mode: 'inline' };
    const declared = tab.miniApp?.window;
    const flags = appliedFlags.get(window);
    const bounds = window.getContentBounds();
    return {
        mode: 'window',
        window: {
            width: bounds.width,
            height: bounds.height,
            ...resolveDetachedWindowMinSize(declared),
            x: bounds.x,
            y: bounds.y,
            visible: window.isVisible(),
            resizable: window.isResizable(),
            frame: declared?.frame ?? true,
            transparent: declared?.transparent ?? false,
            alwaysOnTop: window.isAlwaysOnTop(),
            clickThrough: flags?.clickThrough ?? declared?.clickThrough ?? false,
            skipTaskbar: flags?.skipTaskbar ?? declared?.skipTaskbar ?? false,
        },
    };
}
function omit(patch, keys) {
    return Object.fromEntries(Object.entries(patch).filter(([key]) => !keys.includes(key)));
}
function hasFields(fields) {
    return Object.keys(fields).length > 0;
}
function changesSize(fields) {
    return fields.width !== undefined || fields.height !== undefined;
}
/**
 * A size change is refused when the manifest declares the window non-resizable,
 * or when the window would be non-resizable once this patch lands.
 */
function forbidsResize(tab, fields, currentlyResizable) {
    return (changesSize(fields) &&
        (tab.miniApp?.window?.resizable === false || !(fields.resizable ?? currentlyResizable)));
}
/** `alwaysOnTop` / `clickThrough` can only be switched on when the manifest declares them. */
function exceedsDeclaredCeiling(tab, fields) {
    const declared = tab.miniApp?.window;
    return ((fields.alwaysOnTop === true && declared?.alwaysOnTop !== true) ||
        (fields.clickThrough === true && declared?.clickThrough !== true));
}
function errorCode(error) {
    const code = error && typeof error === 'object' && 'code' in error
        ? error.code
        : undefined;
    return code === 'busy' ? 'busy' : 'result_unknown';
}
/**
 * Validates every rule against the live window before touching it, so a
 * rejected patch never leaves a partially applied window behind.
 */
function applyToWindow(tab, window, fields, userActivated) {
    if (forbidsResize(tab, fields, window.isResizable()))
        return 'not_permitted';
    const { minWidth, minHeight } = resolveDetachedWindowMinSize(tab.miniApp?.window);
    const base = window.getContentBounds();
    const target = {
        x: Math.round(fields.x ?? base.x),
        y: Math.round(fields.y ?? base.y),
        width: Math.max(minWidth, Math.round(fields.width ?? base.width)),
        height: Math.max(minHeight, Math.round(fields.height ?? base.height)),
    };
    const changesGeometry = fields.x !== undefined ||
        fields.y !== undefined ||
        fields.width !== undefined ||
        fields.height !== undefined;
    // Any nonzero overlap used to pass, and only an x/y change re-ran this
    // check — so a resize-only patch after an earlier move could still end
    // fully off-screen. Re-check the final (post-min-clamp) bounds whenever
    // any of x/y/width/height changes.
    if (changesGeometry &&
        !hasMinimumVisibleArea(target, currentWorkAreas(), ON_SCREEN_MIN_VISIBLE_PX)) {
        return 'not_permitted';
    }
    if (fields.resizable !== undefined)
        window.setResizable(fields.resizable);
    // Content bounds match what getState reports, so a read-modify-write round trip is exact.
    if (changesGeometry)
        window.setContentBounds(target);
    if (fields.alwaysOnTop !== undefined)
        window.setAlwaysOnTop(fields.alwaysOnTop);
    const flags = appliedFlags.get(window) ?? {};
    if (fields.clickThrough !== undefined) {
        window.setIgnoreMouseEvents(fields.clickThrough, { forward: true });
        flags.clickThrough = fields.clickThrough;
    }
    if (fields.skipTaskbar !== undefined) {
        window.setSkipTaskbar(fields.skipTaskbar);
        flags.skipTaskbar = fields.skipTaskbar;
    }
    appliedFlags.set(window, flags);
    if (fields.visible === false)
        window.hide();
    // Without a user gesture the page may reveal its window but never steal focus.
    else if (fields.visible === true)
        userActivated ? window.show() : window.showInactive();
    return null;
}
async function switchMode(tab, target, fields, options) {
    switchingTabs.add(tab);
    try {
        if (target === 'inline') {
            await options.host.attach(tab);
            return null;
        }
        // Patch size is explicit intent: patch > position memory > manifest > panel size.
        await options.host.detach(tab, { width: fields.width, height: fields.height }, options.userActivated);
        const window = liveWindow(tab);
        if (!window)
            return 'result_unknown';
        const rest = omit(fields, ['width', 'height']);
        if (!hasFields(rest))
            return null;
        const rejected = applyToWindow(tab, window, rest, options.userActivated);
        // Position is only checkable against the created window; undo the pop-out.
        if (rejected)
            await options.host.attach(tab);
        return rejected;
    }
    catch (error) {
        return errorCode(error);
    }
    finally {
        switchingTabs.delete(tab);
    }
}
export async function updateMiniAppWindow(tab, patch, options) {
    if (switchingTabs.has(tab))
        return fail('busy');
    // Main re-checks the preload gate: a mode switch opens or closes a window.
    if (patch.mode !== undefined && !options.userActivated)
        return fail('not_permitted');
    const current = liveWindow(tab) ? 'window' : 'inline';
    const target = patch.mode ?? current;
    const fields = omit(patch, ['mode']);
    if (target === 'inline' && hasFields(fields))
        return fail('inline_mode');
    if (exceedsDeclaredCeiling(tab, fields))
        return fail('not_permitted');
    if (target !== current) {
        // No window exists yet, so only the declaration and the patch itself can forbid sizing.
        if (forbidsResize(tab, fields, true))
            return fail('not_permitted');
        const rejected = await switchMode(tab, target, fields, options);
        if (rejected)
            return fail(rejected);
    }
    else {
        const window = liveWindow(tab);
        if (window && hasFields(fields)) {
            const rejected = applyToWindow(tab, window, fields, options.userActivated);
            if (rejected)
                return fail(rejected);
        }
    }
    return { success: true, state: readMiniAppWindowState(tab) };
}
export function focusMiniAppWindow(tab, options) {
    if (!options.userActivated)
        return fail('not_permitted');
    if (switchingTabs.has(tab))
        return fail('busy');
    const window = liveWindow(tab);
    if (window)
        revealMiniAppWindow(window);
    else
        options.host.selectInline(tab);
    return { success: true, state: readMiniAppWindowState(tab) };
}
/**
 * An `open`/`focus` request is intent to see the app; a hidden or minimized
 * detached window must come back, not just gain OS focus.
 */
export function revealMiniAppWindow(window) {
    if (window.isMinimized())
        window.restore();
    if (!window.isVisible())
        window.show();
    window.focus();
}
