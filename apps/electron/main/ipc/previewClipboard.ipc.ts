import { BrowserWindow, ipcMain, clipboard } from "electron";
import { isDev } from "../config";
import { DEV_SERVER_URL, IPC_CHANNELS } from "../config/constants";
/** Allows a 100MiB plain-text document plus bounded UTF-8 expansion overhead. */
export let PREVIEW_CLIPBOARD_MAX_TOTAL_BYTES = 128 * 1024 * 1024;
function isWritePayload(value) {
    if (!value || typeof value !== 'object')
        return false;
    const payload = value;
    return (typeof payload.text === 'string' &&
        (payload.html === undefined || typeof payload.html === 'string') &&
        Number.isSafeInteger(payload.declaredTotalBytes) &&
        Number(payload.declaredTotalBytes) >= 0);
}
function payloadByteLength(payload) {
    return Buffer.byteLength(payload.text, 'utf8') + Buffer.byteLength(payload.html ?? '', 'utf8');
}
function trustedHostRenderer(event) {
    if (event.sender.isDestroyed())
        return false;
    if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame)
        return false;
    const owner = BrowserWindow.fromWebContents(event.sender);
    if (!owner || owner.isDestroyed() || owner.webContents.id !== event.sender.id)
        return false;
    try {
        const url = new URL(event.sender.getURL());
        if (url.pathname !== '/archon' && url.pathname !== '/archon/')
            return false;
        if (!isDev)
            return url.protocol === 'app:' && url.hostname === '.';
        return url.origin === new URL(DEV_SERVER_URL).origin;
    }
    catch {
        return false;
    }
}
export function setupPreviewClipboardIPC() {
    ipcMain.handle(IPC_CHANNELS.PREVIEW_CLIPBOARD_WRITE, (event, value) => {
        if (!trustedHostRenderer(event))
            return { ok: false, code: 'untrusted_sender' };
        if (!isWritePayload(value))
            return { ok: false, code: 'invalid_payload' };
        if (value.declaredTotalBytes > PREVIEW_CLIPBOARD_MAX_TOTAL_BYTES ||
            payloadByteLength(value) > PREVIEW_CLIPBOARD_MAX_TOTAL_BYTES) {
            return { ok: false, code: 'payload_too_large' };
        }
        const startedAt = performance.now();
        try {
            if (value.html === undefined)
                clipboard.writeText(value.text);
            else
                clipboard.write({ text: value.text, html: value.html });
            return { ok: true, writeMs: Math.round((performance.now() - startedAt) * 100) / 100 };
        }
        catch {
            return { ok: false, code: 'write_failed' };
        }
    });
}
