const guarded = new WeakSet();
/**
 * Detach the debugger while a page is being destroyed, whoever destroys it.
 * Electron 42's Debugger does not detach itself, so a page that goes away with
 * a client still attached (a guest that runs `window.close()`, a host that
 * drops it) can leave Chromium dispatching CDP messages into freed memory and
 * crash the main process. Electron emits the internal 'will-destroy' before
 * the native WebContents goes away, while detach still works.
 */
export function detachDebuggerBeforeDestroy(contents) {
    const events = contents;
    if (guarded.has(contents) || typeof events.once !== 'function')
        return;
    guarded.add(contents);
    events.once.call(contents, 'will-destroy', () => {
        try {
            if (contents.debugger.isAttached())
                contents.debugger.detach();
        }
        catch {
            // A page already tearing down may reject debugger access.
        }
    });
}
