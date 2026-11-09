import { DEFAULT_VIEW_BACKGROUND } from "./controller";
import { OFFSCREEN_BOUNDS, nowMs } from "./embedded-browser-manager-helpers";
import { resolveDetachedWindowMinSize } from "./miniapp-window-handle";
/**
 * Whether a pop-out window is on screen: shown and not minimized. A minimized or hidden one
 * counts as hidden for memory management, like a hidden panel page.
 */
export function isDetachedWindowInView(window) {
    return !window.isDestroyed() && window.isVisible() && !window.isMinimized();
}
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
    const previousController = tab.controller;
    const previousBounds = tab.bounds;
    const pluginId = miniApp?.pluginId;
    // Page request > memory > manifest declaration > wherever the tab last sat in the panel.
    const memory = pluginId ? readMiniAppWindowMemory(pluginId) : null;
    const { minWidth, minHeight } = resolveDetachedWindowMinSize(declaredWindow);
    const window = (host.createWindow
        ? (options) => host.createWindow(tab, options)
        : host.detachedWindowFactory)({
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
    // Listeners first: the window must never own the page without a close path.
    tab.detachedWindow = window;
    tab.detachedPanelVisible = wasVisibleInPanel;
    if (pluginId) {
        tab.detachedWindowBoundsPersistence = attachMiniAppWindowBoundsPersistence(pluginId, window);
    }
    bindDetachedWindow(host, tab, window);
    try {
        // Not a constructor option: Electron only exposes click-through as a method.
        if (declaredWindow?.clickThrough)
            window.setIgnoreMouseEvents(true, { forward: true });
        await attachPageToWindow(host, tab, window, signal);
    }
    catch (error) {
        if (tab.backendSelection?.rendererBackend === 'webview') {
            clearDetachedWindowState(tab);
            if (tab.controller === previousController) {
                tab.bounds = previousBounds;
            }
            else {
                tab.bounds = OFFSCREEN_BOUNDS;
                host.markTabHidden(tab);
            }
            if (!window.isDestroyed())
                window.destroy();
        }
        else
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
    // Shown, so in view; the window's minimize/hide/restore/show listeners track it from here.
    host.onVisibilityChanged(tab);
    // The panel may never observe an intermediate `detached: true` if a fast
    // detach->attach round trip completes between two state polls; bump the
    // revision so a same-value `detached` read still forces a fresh show().
    tab.presentationRevision += 1;
}
/**
 * Hands a page's pop-out window over before the page is destroyed to sleep: the window stays as
 * it is (minimized or hidden) and keeps its position memory, the tab drops every detached-window
 * field and its listeners. Undefined when the tab has no live window.
 */
export function releaseDetachedWindow(tab) {
    const window = tab.detachedWindow;
    if (!window || window.isDestroyed())
        return undefined;
    const boundsPersistence = tab.detachedWindowBoundsPersistence;
    // Moves to the kept window instead of being disposed with the tab's state.
    delete tab.detachedWindowBoundsPersistence;
    clearDetachedWindowState(tab);
    return { window, ...(boundsPersistence ? { boundsPersistence } : {}) };
}
/**
 * Moves a freshly reopened page into the window its previous page slept in. The page is in view
 * only if that window is on screen. Throws (after returning the page to the panel and closing the
 * window) when the page cannot be placed in it.
 */
export async function adoptDetachedWindow(host, tab, kept, signal) {
    const { window } = kept;
    tab.detachedWindow = window;
    // The panel shows the placeholder again on its next layout sync.
    tab.detachedPanelVisible = false;
    if (kept.boundsPersistence)
        tab.detachedWindowBoundsPersistence = kept.boundsPersistence;
    bindDetachedWindow(host, tab, window);
    try {
        await attachPageToWindow(host, tab, window, signal);
    }
    catch (error) {
        await attachDetachedTab(host, tab);
        throw error;
    }
    tab.controller.setAudioMuted(false);
    tab.hiddenAt = isDetachedWindowInView(window) ? null : (tab.hiddenAt ?? nowMs());
}
/** Closes a kept window for good, persisting its final position first. */
export function closeKeptDetachedWindow(kept) {
    if (!kept.window.isDestroyed())
        kept.boundsPersistence?.flush();
    kept.boundsPersistence?.dispose();
    if (!kept.window.isDestroyed())
        kept.window.destroy();
}
/**
 * Listens on a kept window for a sleeping tab: `onShown` once it is restored or shown again,
 * `onClose` when the user closes it (prevented, the owner decides), `onClosed` when it is gone
 * anyway (app quit). Returns the disposer that removes these listeners.
 */
export function bindKeptDetachedWindow(window, handlers) {
    const onShown = () => {
        if (isDetachedWindowInView(window))
            handlers.onShown();
    };
    return listen(window, {
        restore: onShown,
        show: onShown,
        close: (event) => {
            if (handlers.isAppQuitting())
                return;
            event.preventDefault();
            handlers.onClose();
        },
        closed: () => handlers.onClosed(),
    });
}
/** Wires a pop-out window to its live tab; `tab.detachedWindowListeners` removes it again. */
function bindDetachedWindow(host, tab, window) {
    // Every native show/hide is reported: `hiddenAt` records when the page left view, but it is
    // not proof that the runtime's last snapshot matched the window, so it never gates a report.
    // The snapshot reads the window's real state; a stale `hiddenAt` only skews ranking.
    const onHidden = () => {
        if (tab.detachedWindow !== window)
            return;
        tab.hiddenAt ?? (tab.hiddenAt = nowMs());
        host.onVisibilityChanged(tab);
    };
    const onShown = () => {
        if (tab.detachedWindow !== window || !isDetachedWindowInView(window))
            return;
        tab.hiddenAt = null;
        host.onVisibilityChanged(tab);
    };
    tab.detachedWindowListeners = listen(window, {
        resize: () => {
            if (tab.detachedWindow !== window || window.isDestroyed())
                return;
            tab.bounds = detachedContentBounds(window);
            void tab.controller.setBounds(tab.bounds);
        },
        close: (event) => {
            if (tab.detachedWindow !== window || host.isAppQuitting())
                return;
            event.preventDefault();
            requestAttach(host, tab);
        },
        closed: () => {
            if (tab.detachedWindow !== window)
                return;
            // Closed without an attach (app quit or owner teardown): the view has no
            // live parent anymore, so only the bookkeeping needs to follow.
            clearDetachedWindowState(tab);
            tab.controller.setBackgroundColor(DEFAULT_VIEW_BACKGROUND);
            tab.bounds = OFFSCREEN_BOUNDS;
            host.markTabHidden(tab);
        },
        // Cmd/Ctrl+W only reached the page once (Bug 2); later activation
        // (Cmd+Shift+`, a title-bar click or alt-tab) never did (P2).
        // A `BaseWindow` becoming key hands the OS focus to itself, not to a
        // child `WebContentsView` — pull it in on every real focus, not just the
        // first one.
        focus: () => {
            if (tab.detachedWindow !== window || window.isDestroyed())
                return;
            tab.controller.focusPage();
        },
        // Minimized or hidden counts as hidden for memory management; the main window's state never does.
        minimize: onHidden,
        hide: onHidden,
        restore: onShown,
        show: onShown,
    });
    // Cmd/Ctrl+W inside the pop-out is equivalent to the close button: return
    // to the panel instead of falling through to the app menu's `role:
    // 'close'`. See BrowserController's before-input-event handler.
    tab.controller.setOnRequestCloseDetached(() => requestAttach(host, tab));
}
/** Returns the page to the panel: the host's own attach when it has one, else the plain path. */
function requestAttach(host, tab) {
    if (host.requestAttach)
        host.requestAttach(tab);
    else
        void attachDetachedTab(host, tab);
}
/** Adds `listeners` to `window`; the returned disposer removes exactly these again. */
function listen(window, listeners) {
    // Electron types each BaseWindow event separately; these are registered by name.
    const emitter = window;
    for (const [event, listener] of Object.entries(listeners))
        emitter.on(event, listener);
    return () => {
        for (const [event, listener] of Object.entries(listeners)) {
            emitter.removeListener(event, listener);
        }
    };
}
function detachedContentBounds(window) {
    const { width, height } = window.getContentBounds();
    return { x: 0, y: 0, width, height };
}
/** Fills the window's content area with the tab's page. */
async function attachPageToWindow(host, tab, window, signal) {
    tab.bounds = detachedContentBounds(window);
    if (host.transferPage)
        await host.transferPage(tab, window, tab.bounds, signal);
    else
        tab.controller.attachToParent(window, tab.bounds);
    // A transfer may hand the tab a new controller; the close path must follow it.
    tab.controller.setOnRequestCloseDetached(() => requestAttach(host, tab));
    // BaseWindow transparency alone leaves the WebContentsView's own
    // background opaque; a `frame:false, transparent:true` Mini App needs
    // both cleared to an alpha-channel color.
    if (tab.miniApp?.window?.transparent)
        tab.controller.setBackgroundColor('#00000000');
}
/** Returns a detached page to the File Panel host, parked offscreen; a no-op when inline. */
export function attachDetachedTab(host, tab, signal) {
    const window = tab.detachedWindow;
    if (!window)
        return;
    if (tab.backendSelection?.rendererBackend === 'webview' && host.transferPage) {
        const target = host.getHostWindow();
        if (!target)
            return Promise.reject(new Error('BROWSER_WEBVIEW_HOST_UNAVAILABLE'));
        return host.transferPage(tab, target, OFFSCREEN_BOUNDS, signal).then(() => {
            tab.detachedWindowBoundsPersistence?.flush();
            clearDetachedWindowState(tab);
            tab.bounds = OFFSCREEN_BOUNDS;
            tab.presentationRevision += 1;
            host.markTabHidden(tab);
            if (!window.isDestroyed())
                window.destroy();
        });
    }
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
/** Drops every detached-window field and listener; the window itself is left as it is. */
function clearDetachedWindowState(tab) {
    tab.detachedWindowListeners?.();
    delete tab.detachedWindowListeners;
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
