/**
 * Terminal IPC handler — translates renderer-facing IPC calls into
 * `TerminalManager` operations and pumps PTY events back over IPC.
 *
 * Channels and payload contracts are pinned in the design doc
 * (`docs/design/sidebar-terminal-panel.md` §6.2). Downstream UI work depends
 * on this contract; renaming a channel here is a breaking change.
 */
import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../config/constants";
import { logger } from "../utils";
import { getTerminalManager } from "../modules/terminal";
let registered = false;
/**
 * Register every `terminal:*` IPC handler. Idempotent so it can be called
 * from `setupAllIPC` without guarding at the call site.
 */
export function setupTerminalIPC() {
    if (registered)
        return;
    registered = true;
    ipcMain.handle(IPC_CHANNELS.TERMINAL_CREATE, async (_evt, params) => {
        requireString(params?.sessionId, 'sessionId');
        requireString(params?.cwd, 'cwd');
        return getTerminalManager().create({
            sessionId: params.sessionId,
            cwd: params.cwd,
            shellOverride: params.shellOverride,
        });
    });
    ipcMain.handle(IPC_CHANNELS.TERMINAL_LIST, async (_evt, params) => {
        requireString(params?.sessionId, 'sessionId');
        return getTerminalManager().list({ sessionId: params.sessionId });
    });
    ipcMain.handle(IPC_CHANNELS.TERMINAL_ATTACH, async (evt, params) => {
        requireString(params?.terminalId, 'terminalId');
        requirePositiveInt(params?.cols, 'cols');
        requirePositiveInt(params?.rows, 'rows');
        const subscriber = wrapWebContents(evt.sender);
        return getTerminalManager().attach(params.terminalId, subscriber, params.cols, params.rows);
    });
    ipcMain.handle(IPC_CHANNELS.TERMINAL_INPUT, async (_evt, params) => {
        requireString(params?.terminalId, 'terminalId');
        if (typeof params?.data !== 'string') {
            throw new Error('terminal:input: data must be a string');
        }
        getTerminalManager().write(params.terminalId, params.data);
    });
    ipcMain.handle(IPC_CHANNELS.TERMINAL_RESIZE, async (_evt, params) => {
        requireString(params?.terminalId, 'terminalId');
        requirePositiveInt(params?.cols, 'cols');
        requirePositiveInt(params?.rows, 'rows');
        getTerminalManager().resize(params.terminalId, params.cols, params.rows);
    });
    ipcMain.handle(IPC_CHANNELS.TERMINAL_DISPOSE, async (_evt, params) => {
        requireString(params?.terminalId, 'terminalId');
        getTerminalManager().dispose(params.terminalId);
    });
    logger.info('[TerminalIPC] handlers registered');
}
// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------
function requireString(value, name) {
    if (typeof value !== 'string' || value.length === 0) {
        throw new Error(`terminal:* IPC: '${name}' must be a non-empty string`);
    }
}
function requirePositiveInt(value, name) {
    if (typeof value !== 'number' ||
        !Number.isFinite(value) ||
        value < 1 ||
        !Number.isInteger(value)) {
        throw new Error(`terminal:* IPC: '${name}' must be a positive integer`);
    }
}
// ---------------------------------------------------------------------------
// WebContents adapter
// ---------------------------------------------------------------------------
/**
 * Wrap an Electron `WebContents` so it conforms to `TerminalSubscriber`.
 * Exported for tests; production callers should rely on `setupTerminalIPC`.
 */
export function wrapWebContents(wc) {
    return {
        id: wc.id,
        isDestroyed: () => wc.isDestroyed(),
        send: (channel, payload) => {
            // Defensive: WebContents.send is fire-and-forget but it throws when
            // the renderer is gone; the manager already filters destroyed
            // subscribers but a renderer can be torn down between checks.
            try {
                wc.send(channel, payload);
            }
            catch {
                // Swallowed — manager will prune on the next iteration.
            }
        },
        removeListener: (event, listener) => {
            wc.removeListener(event, listener);
        },
        once: (event, listener) => {
            wc.once(event, listener);
        },
    };
}
/**
 * Visible for tests — reset the registration guard so the handlers can be
 * re-installed on a fresh `ipcMain` mock.
 */
export function __resetTerminalIPCForTests() {
    registered = false;
}
