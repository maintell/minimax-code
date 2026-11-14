/**
 * Per-WebContents gate registry. null records that Electron's private dialog
 * contract did not hold, so the page keeps its native dialogs. Kept free of
 * runtime imports so transports can read it without loading the gate.
 */
export let browserJsDialogGates = new WeakMap();
/** The installed gate, null when Electron's contract did not hold, undefined when never installed. */
export function getBrowserJsDialogGate(webContents) {
    return browserJsDialogGates.get(webContents);
}
