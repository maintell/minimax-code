import { ipcRenderer, contextBridge } from "electron";
const EMBEDDED_BROWSER_COMMENT_BRIDGE_EVENT = 'embedded-browser:comment-bridge-event';
const EMBEDDED_BROWSER_AGENT_CURSOR_EVENT = 'embedded-browser:agent-cursor-event';
const EMBEDDED_COMMENT_WORLD_ID = 1004;
const EMBEDDED_AGENT_CURSOR_WORLD_ID = 1005;
const EMBEDDED_COMMENT_BRIDGE_API_KEY = 'mavisEmbeddedBrowserBridge';
const EMBEDDED_AGENT_CURSOR_BRIDGE_API_KEY = 'mavisEmbeddedBrowserCursorBridge';
const MAX_PENDING_COMMENT_MESSAGES = 256;
const pendingMessages = [];
let drainPromise = null;
let retryTimer = null;
function scheduleRetry() {
    if (retryTimer)
        return;
    retryTimer = setTimeout(() => {
        retryTimer = null;
        void drainPendingMessages();
    }, 250);
}
function drainPendingMessages() {
    if (drainPromise)
        return drainPromise;
    drainPromise = (async () => {
        while (pendingMessages.length > 0) {
            const pending = pendingMessages[0];
            try {
                const result = await ipcRenderer.invoke(EMBEDDED_BROWSER_COMMENT_BRIDGE_EVENT, pending.envelope);
                if (result &&
                    typeof result === 'object' &&
                    result.success === false &&
                    result.retryable === true) {
                    scheduleRetry();
                    return;
                }
                pendingMessages.shift();
                pending.resolve(result);
            }
            catch {
                scheduleRetry();
                return;
            }
        }
    })().finally(() => {
        drainPromise = null;
    });
    return drainPromise;
}
contextBridge.exposeInIsolatedWorld(EMBEDDED_COMMENT_WORLD_ID, EMBEDDED_COMMENT_BRIDGE_API_KEY, {
    emitCommentEvent(envelope) {
        if (pendingMessages.length >= MAX_PENDING_COMMENT_MESSAGES) {
            return Promise.resolve({ success: false, error: 'Browser comment transport queue is full' });
        }
        return new Promise((resolve) => {
            pendingMessages.push({ envelope, resolve });
            void drainPendingMessages();
        });
    },
});
contextBridge.exposeInIsolatedWorld(EMBEDDED_AGENT_CURSOR_WORLD_ID, EMBEDDED_AGENT_CURSOR_BRIDGE_API_KEY, {
    emitCursorEvent(envelope) {
        return ipcRenderer.invoke(EMBEDDED_BROWSER_AGENT_CURSOR_EVENT, envelope);
    },
});
