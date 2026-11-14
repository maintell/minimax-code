import { BROWSER_JS_DIALOG_NOT_ACTIVE, isRecord, normalizeBrowserJsDialogType, boundBrowserJsDialogMessage } from "@mavis/browser-core";
import { getCategoryLogger } from "../../utils/logger";
import { browserJsDialogGates } from "./browser-js-dialog-registry";
export { getBrowserJsDialogGate } from "./browser-js-dialog-registry";

const browserInputDiagnosticLogger = getCategoryLogger('archon', 'browser-input');
/**
 * Process-wide sequence: a page that is torn down and recreated gets a new
 * gate, and a stale dialog ref from the old page must not match its dialogs.
 */
let dialogSequence = 0;
/** Electron-private event that owns renderer JavaScript dialogs (alert/confirm/prompt). */
export let ELECTRON_RUN_DIALOG_EVENT = '-run-dialog';
const ELECTRON_CANCEL_DIALOGS_EVENT = '-cancel-dialogs';
/** Electron reports beforeunload here, not through `-run-dialog`; preventDefault leaves the page. */
const ELECTRON_WILL_PREVENT_UNLOAD_EVENT = 'will-prevent-unload';
const USER_INPUT_TYPES = new Set(['mouseDown', 'keyDown', 'rawKeyDown', 'char']);
/**
 * Takes over Electron's JavaScript dialog UI for one Agent-controlled page.
 *
 * Electron shows a native message box for every renderer dialog, even when CDP
 * handles it, and the box blocks the page. While the Agent controls the page
 * the gate holds the dialog instead and lets Browser Core report it; outside
 * Agent control, and when control ends, Electron's original listener shows the
 * native box as before.
 */
export class BrowserJsDialogGate {
    constructor(webContents, fallback, options) {
        this.webContents = webContents;
        this.fallback = fallback;
        this.options = options;
        this.pending = null;
        this.disposed = false;
        /** Native boxes shown for this page and not yet answered. */
        this.nativeDialogs = 0;
        this.lastUserInputAt = Number.NEGATIVE_INFINITY;
        this.listeners = new Set();
        this.clearPending = () => {
            this.nativeDialogs = 0;
            this.settle(null, 'cleared');
        };
        this.destroyed = () => this.dispose();
        this.userInput = (_event, input) => this.onInput(input);
        this.willPreventUnload = (event) => this.onWillPreventUnload(event);
        this.now = options.now ?? Date.now;
        this.runDialog = (info, callback) => this.onRunDialog(info, callback);
    }
    /**
     * Install once per WebContents. Returns null, and leaves Electron untouched,
     * when the private listener contract (exactly one `-run-dialog` listener)
     * does not hold.
     */
    static install(webContents, options) {
        if (browserJsDialogGates.has(webContents)) {
            const installed = browserJsDialogGates.get(webContents);
            return installed instanceof BrowserJsDialogGate ? installed : null;
        }
        const existing = typeof webContents.listeners === 'function'
            ? webContents.listeners(ELECTRON_RUN_DIALOG_EVENT)
            : [];
        const fallback = existing.length === 1 ? existing[0] : undefined;
        if (typeof fallback !== 'function' || webContents.isDestroyed()) {
            browserInputDiagnosticLogger.warn({
                msg: '[BrowserJsDialogGate] unsupported',
                webContentsId: webContents.id,
                listenerCount: existing.length,
            });
            browserJsDialogGates.set(webContents, null);
            return null;
        }
        const gate = new BrowserJsDialogGate(webContents, fallback, options);
        webContents.removeListener(ELECTRON_RUN_DIALOG_EVENT, fallback);
        webContents.on(ELECTRON_RUN_DIALOG_EVENT, gate.runDialog);
        webContents.on(ELECTRON_CANCEL_DIALOGS_EVENT, gate.clearPending);
        webContents.on('render-process-gone', gate.clearPending);
        webContents.on(ELECTRON_WILL_PREVENT_UNLOAD_EVENT, gate.willPreventUnload);
        webContents.on('destroyed', gate.destroyed);
        webContents.on('before-input-event', gate.userInput);
        webContents.on('before-mouse-event', gate.userInput);
        browserJsDialogGates.set(webContents, gate);
        return gate;
    }
    current() {
        return this.pending?.state ?? null;
    }
    /** The page is blocked on a dialog: held here, or shown in the native box and not yet answered. */
    hasOpenDialog() {
        return this.pending !== null || this.nativeDialogs > 0;
    }
    /** A dialog shown in the native box is still waiting for the user's answer. */
    awaitingUser() {
        return this.nativeDialogs > 0;
    }
    onChange(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
    async handle(dialogId, accept, promptText) {
        const pending = this.pending;
        if (!pending || pending.state.dialogId !== dialogId) {
            throw new Error(`${BROWSER_JS_DIALOG_NOT_ACTIVE}: JavaScript dialog is no longer active`);
        }
        // An alert has a single button: either decision closes it.
        const outcome = pending.state.type === 'alert' ? 'closed' : accept ? 'accepted' : 'dismissed';
        this.settle(null, outcome);
        pending.callback(accept, promptText ?? '');
    }
    /** Agent control ended: show the held dialog in Electron's native box. */
    releaseToUser() {
        const pending = this.pending;
        if (!pending)
            return false;
        this.settle(null, 'released');
        if (this.webContents.isDestroyed())
            return false;
        this.showNativeDialog(pending.info, pending.callback);
        return true;
    }
    /**
     * The user drove the page from the host UI (address bar, back, forward,
     * reload): Agent control ends until the Agent's next operation.
     */
    noteUserTakeover() {
        this.lastUserInputAt = this.now();
        if (this.pending)
            this.releaseToUser();
    }
    dispose() {
        if (this.disposed)
            return;
        this.disposed = true;
        // A live page must not stay blocked on a dialog nobody can see.
        if (!this.releaseToUser())
            this.settle(null, 'cleared');
        this.listeners.clear();
        this.webContents.removeListener(ELECTRON_RUN_DIALOG_EVENT, this.runDialog);
        this.webContents.removeListener(ELECTRON_CANCEL_DIALOGS_EVENT, this.clearPending);
        this.webContents.removeListener('render-process-gone', this.clearPending);
        this.webContents.removeListener(ELECTRON_WILL_PREVENT_UNLOAD_EVENT, this.willPreventUnload);
        this.webContents.removeListener('destroyed', this.destroyed);
        this.webContents.removeListener('before-input-event', this.userInput);
        this.webContents.removeListener('before-mouse-event', this.userInput);
        if (!this.webContents.isDestroyed()) {
            this.webContents.on(ELECTRON_RUN_DIALOG_EVENT, this.fallback);
        }
        browserJsDialogGates.delete(this.webContents);
    }
    onRunDialog(info, callback) {
        const record = isRecord(info) ? info : {};
        const type = normalizeBrowserJsDialogType(record.dialogType);
        if (!type ||
            type === 'beforeunload' ||
            this.disposed ||
            this.pending ||
            !this.isAgentControlled()) {
            this.showNativeDialog(info, callback);
            return;
        }
        dialogSequence += 1;
        const state = {
            dialogId: `d${dialogSequence}`,
            type,
            message: boundBrowserJsDialogMessage(record.messageText),
            defaultPrompt: boundBrowserJsDialogMessage(record.defaultPromptText),
            url: frameUrl(record.frame) || safeUrl(this.webContents),
            openedAt: this.now(),
        };
        this.pending = { state, info, callback };
        browserInputDiagnosticLogger.info({
            msg: '[BrowserJsDialogGate] held',
            webContentsId: this.webContents.id,
            dialogId: state.dialogId,
            dialogType: type,
        });
        this.emit(state);
    }
    /**
     * Show a dialog in Electron's native box. The page stays blocked until the
     * user answers, so the box counts as open until its callback runs.
     */
    showNativeDialog(info, callback) {
        this.nativeDialogs += 1;
        let answered = false;
        this.fallback.call(this.webContents, info, (accept, promptText) => {
            if (!answered) {
                answered = true;
                this.nativeDialogs = Math.max(0, this.nativeDialogs - 1);
            }
            callback(accept, promptText);
        });
    }
    /**
     * Only the Agent's own in-flight action leaves a beforeunload page without
     * asking. Any other unload keeps Electron's default, which stays on the page.
     */
    onWillPreventUnload(event) {
        if (this.disposed || !this.options.isOperationActive())
            return;
        event.preventDefault();
        browserInputDiagnosticLogger.info({
            msg: '[BrowserJsDialogGate] beforeunload-accepted',
            webContentsId: this.webContents.id,
        });
    }
    /**
     * The Agent owns dialogs during its operations and its keepalive window,
     * unless the user has used the page since the Agent's last operation.
     */
    isAgentControlled() {
        const since = this.options.agentKeepaliveSince();
        if (since === null)
            return false;
        return this.options.isOperationActive() || this.lastUserInputAt < since;
    }
    /**
     * Agent input never runs while the page is idle, and Browser Core sends no
     * input while a dialog is held, so idle input is the user's. The user takes
     * the page back: a held dialog shows in the native box.
     */
    onInput(input) {
        if (this.options.isOperationActive())
            return;
        const type = isRecord(input) ? input.type : undefined;
        if (typeof type !== 'string' || !USER_INPUT_TYPES.has(type))
            return;
        this.noteUserTakeover();
    }
    settle(next, outcome) {
        const previous = this.pending;
        if (!previous)
            return;
        this.pending = next;
        browserInputDiagnosticLogger.info({
            msg: `[BrowserJsDialogGate] ${outcome}`,
            webContentsId: this.webContents.id,
            dialogId: previous.state.dialogId,
            dialogType: previous.state.type,
            heldMs: Math.max(0, this.now() - previous.state.openedAt),
        });
        this.emit(null);
    }
    emit(dialog) {
        for (const listener of [...this.listeners])
            listener(dialog);
    }
}

export function installBrowserJsDialogGate(webContents, options) {
    return BrowserJsDialogGate.install(webContents, options);
}
function frameUrl(frame) {
    if (!isRecord(frame))
        return '';
    try {
        return typeof frame.url === 'string' ? frame.url : '';
    }
    catch {
        // A disposed WebFrameMain throws on property access.
        return '';
    }
}
function safeUrl(webContents) {
    try {
        return webContents.isDestroyed() ? '' : webContents.getURL();
    }
    catch {
        return '';
    }
}
