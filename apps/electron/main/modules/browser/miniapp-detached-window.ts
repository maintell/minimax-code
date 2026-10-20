import { DEFAULT_VIEW_BACKGROUND } from "./controller";
import { OFFSCREEN_BOUNDS } from "./embedded-browser-manager-helpers";
import { resolveDetachedWindowMinSize } from "./miniapp-window-handle";
export async function openDetachedWindow(host, tab, signal, initialSize,
/**
 * Whether a user gesture drove this detach. Mirrors the userActivated/
 * show() vs showInactive() split already used for window patches
 * (miniapp-window-handle.ts): gates whether the pop-out is allowed to
 * take OS focus when it first appears (Bug 2 / P2).
 */
userActivated = true) {
    // Batched with the existing await so loading memory adds no new suspension point.
    const [, { readMiniAppWindowMemory, attachMiniAppWindowBoundsPersistence }] = await Promise.all([
        host.claimForeground(tab),
        host.loadWindowMemory(),
    ]);
    // Stop or tab close can land while that action drains; never orphan a window.
    signal.throwIfAborted();
    host.requireCurrentTab(tab);
    const miniApp = tab.miniApp?.miniApp;
    const declaredWindow = tab.miniApp?.window;
    const initialPanelSize = tab.lastForegroundBounds ?? tab.bounds;
    // Captured before any mutation below: was the page visible in the panel
    // right before this detach.
    const wasVisibleInPanel = tab.hiddenAt == null && tab.bounds.x >= 0 && tab.bounds.y >= 0;
    const pluginId = miniApp?.pluginId;
    // Page request > memory > manifest declaration > wherever the tab last sat in the panel.
    const memory = pluginId ? readMiniAppWindowMemory(pluginId) : null;
    const { minWidth, minHeight } = resolveDetachedWindowMinSize(declaredWindow);
    const window = host.detachedWindowFactory({
        title: miniApp ? (miniApp.displayName ?? miniApp.pluginId) : tab.title,
        width: Math.max(minWidth, Math.round(initialSize?.width ?? memory?.width ?? declaredWindow?.width ?? initialPanelSize.width)),
        height: Math.max(minHeight, Math.round(initialSize?.height ?? memory?.height ?? declaredWindow?.height ?? initialPanelSize.height)),
        minWidth,
        minHeight,
        useContentSize: true,
        // Intentionally not `parent: host`: a child NSWindow on macOS cannot be
        // minimized independently of its parent (Electron #39578 / #26031). The
        // pop-out is its own top-level window with independent visibility, including
        // when the main window is hidden to the tray or moves between fullscreen Spaces.
        // A remembered position that no longer sits on any display resolves to
        // `{ width, height }` only (no x/y) — fall through to Electron's own
        // default placement instead of forcing the window off-screen again.
        ...(memory?.x !== undefined && memory?.y !== undefined ? { x: memory.x, y: memory.y } : {}),
        ...(declaredWindow?.resizable !== undefined ? { resizable: declaredWindow.resizable } : {}),
        ...(declaredWindow?.frame !== undefined ? { frame: declaredWindow.frame } : {}),
        ...(declaredWindow?.transparent !== undefined
            ? { transparent: declaredWindow.transparent }
            : {}),
        // Electron transparent windows require an explicit alpha-channel background,
        // and its default `hasShadow: true` draws a system shadow around the
        // transparent rectangle, producing a hard grey outline. Non-transparent
        // windows keep the platform defaults.
        ...(declaredWindow?.transparent ? { backgroundColor: '#00000000', hasShadow: false } : {}),
        ...(declaredWindow?.alwaysOnTop !== undefined
            ? { alwaysOnTop: declaredWindow.alwaysOnTop }
            : {}),
        ...(declaredWindow?.skipTaskbar !== undefined
            ? { skipTaskbar: declaredWindow.skipTaskbar }
            : {}),
        // Never let Electron's own construction default (`show: true`) hand the
        // OS key-window/focus state to the page before `userActivated` below
        // decides whether this pop-out is allowed to take it (Bug 2 / P2).
        show: false,
    });
    const contentBounds = () => {
        const { width, height } = window.getContentBounds();
        return { x: 0, y: 0, width, height };
    };
    // Listeners first: the window must never own the page without a close path.
    tab.detachedWindow = window;
    tab.detachedPanelVisible = wasVisibleInPanel;
    if (pluginId) {
        tab.detachedWindowBoundsPersistence = attachMiniAppWindowBoundsPersistence(pluginId, window);
    }
    window.on('resize', () => {
        if (tab.detachedWindow !== window || window.isDestroyed())
            return;
        tab.bounds = contentBounds();
        void tab.controller.setBounds(tab.bounds);
    });
    window.on('close', (event) => {
        if (tab.detachedWindow !== window || host.isAppQuitting())
            return;
        event.preventDefault();
        attachDetachedTab(host, tab);
    });
    // Cmd/Ctrl+W inside the pop-out is equivalent to the close button: return
    // to the panel instead of falling through to the app menu's `role:
    // 'close'`. See BrowserController's before-input-event handler.
    tab.controller.setOnRequestCloseDetached(() => attachDetachedTab(host, tab));
    window.on('closed', () => {
        if (tab.detachedWindow !== window)
            return;
        // Closed without an attach (app quit or owner teardown): the view has no
        // live parent anymore, so only the bookkeeping needs to follow.
        clearDetachedWindowState(tab);
        tab.controller.setBackgroundColor(DEFAULT_VIEW_BACKGROUND);
        tab.bounds = OFFSCREEN_BOUNDS;
        host.markTabHidden(tab);
    });
    // Cmd/Ctrl+W only reached the page once (Bug 2); later activation
    // (Cmd+Shift+`, a title-bar click or alt-tab) never did (P2).
    // A `BaseWindow` becoming key hands the OS focus to itself, not to a
    // child `WebContentsView` — pull it in on every real focus, not just the
    // first one.
    window.on('focus', () => {
        if (tab.detachedWindow !== window || window.isDestroyed())
            return;
        tab.controller.focusPage();
    });
    try {
        // Not a constructor option: Electron only exposes click-through as a method.
        if (declaredWindow?.clickThrough)
            window.setIgnoreMouseEvents(true, { forward: true });
        tab.bounds = contentBounds();
        tab.controller.attachToParent(window, tab.bounds);
        // BaseWindow transparency alone leaves the WebContentsView's own
        // background opaque; a `frame:false, transparent:true` Mini App needs
        // both cleared to an alpha-channel color.
        if (declaredWindow?.transparent)
            tab.controller.setBackgroundColor('#00000000');
    }
    catch (error) {
        attachDetachedTab(host, tab);
        throw error;
    }
    tab.hiddenAt = null;
    tab.controller.setAudioMuted(false);
    // Constructed with `show: false` above so this is the only place the
    // pop-out becomes visible: `show()` also makes it key, emitting the
    // `focus` above that pulls the page's own keyboard focus in with it;
    // `showInactive()` (agent-initiated pop-outs, e.g. background opens)
    // shows it without taking focus away from whatever the user is doing.
    if (userActivated)
        window.show();
    else
        window.showInactive();
    // The panel may never observe an intermediate `detached: true` if a fast
    // detach->attach round trip completes between two state polls; bump the
    // revision so a same-value `detached` read still forces a fresh show().
    tab.presentationRevision += 1;
}
/** Returns a detached page to the File Panel host, parked offscreen; a no-op when inline. */
export function attachDetachedTab(host, tab) {
    const window = tab.detachedWindow;
    if (!window)
        return;
    // Final write before the window goes away: resize/move only persist on a
    // throttle, so a quick pop-out/attach could otherwise lose the latest bounds.
    tab.detachedWindowBoundsPersistence?.flush();
    clearDetachedWindowState(tab);
    // Park before reparenting so window-local bounds never paint in the host.
    // The File Panel reveals it with real bounds on its next layout sync.
    void tab.controller.setBounds(OFFSCREEN_BOUNDS);
    tab.bounds = OFFSCREEN_BOUNDS;
    const hostWindow = host.getHostWindow();
    if (hostWindow)
        tab.controller.addToParent(hostWindow);
    // A transparent detached window leaves an alpha-channel background on the
    // WebContentsView; restore Electron's opaque default before it rejoins the panel.
    tab.controller.setBackgroundColor(DEFAULT_VIEW_BACKGROUND);
    // See the matching comment in openDetachedWindow: same reasoning, opposite direction.
    tab.presentationRevision += 1;
    host.markTabHidden(tab);
    if (!window.isDestroyed())
        window.destroy();
}
/** Destroys a detached tab's window as part of tearing the tab down; a no-op when inline. */
export function closeDetachedWindow(tab) {
    const window = tab.detachedWindow;
    if (!window)
        return;
    // Same final-write rationale as attachDetachedTab: the tab is about to be
    // destroyed, so this is the last chance to persist its window position.
    tab.detachedWindowBoundsPersistence?.flush();
    // Clearing the state first turns the window's close/closed handlers into no-ops.
    clearDetachedWindowState(tab);
    tab.controller.setBackgroundColor(DEFAULT_VIEW_BACKGROUND);
    if (!window.isDestroyed())
        window.destroy();
}
/** Drops every detached-window field; afterwards the window's own handlers are no-ops. */
function clearDetachedWindowState(tab) {
    tab.detachedWindowBoundsPersistence?.dispose();
    delete tab.detachedWindowBoundsPersistence;
    delete tab.detachedWindow;
    delete tab.detachedPanelVisible;
    tab.controller.setOnRequestCloseDetached(null);
}
/**
 * The File Panel placed its placeholder slot for a detached Mini App. Records
 * where the page would sit in the panel and parks whichever inline tab still
 * occupies it: a detached Mini App can be selected while an ordinary inline
 * tab is still painting over the placeholder page.
 */
export function showDetachedPlaceholder(host, tab, normalizedBounds) {
    tab.lastForegroundBounds = normalizedBounds;
    tab.detachedPanelVisible = true;
    host.parkOtherVisibleInlineTabs(tab, 'detached-tab-switch');
    return { success: true, tabId: tab.tabId, ignored: 'detached-window' };
}
/** The File Panel hid the placeholder slot; the detached window itself stays as it is. */
export function hideDetachedPlaceholder(tab) {
    tab.detachedPanelVisible = false;
    return { success: true, tabId: tab.tabId, ignored: 'detached-window' };
}
