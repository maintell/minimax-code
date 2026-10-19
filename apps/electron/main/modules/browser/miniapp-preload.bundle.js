"use strict";

// main/modules/browser/preload.ts
var import_electron = require("electron");
var EMBEDDED_BROWSER_COMMENT_BRIDGE_EVENT = "embedded-browser:comment-bridge-event";
var EMBEDDED_BROWSER_AGENT_CURSOR_EVENT = "embedded-browser:agent-cursor-event";
var EMBEDDED_COMMENT_WORLD_ID = 1004;
var EMBEDDED_AGENT_CURSOR_WORLD_ID = 1005;
var EMBEDDED_COMMENT_BRIDGE_API_KEY = "mavisEmbeddedBrowserBridge";
var EMBEDDED_AGENT_CURSOR_BRIDGE_API_KEY = "mavisEmbeddedBrowserCursorBridge";
var MAX_PENDING_COMMENT_MESSAGES = 256;
var pendingMessages = [];
var drainPromise = null;
var retryTimer = null;
function scheduleRetry() {
  if (retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void drainPendingMessages();
  }, 250);
}
function drainPendingMessages() {
  if (drainPromise) return drainPromise;
  drainPromise = (async () => {
    while (pendingMessages.length > 0) {
      const pending = pendingMessages[0];
      try {
        const result = await import_electron.ipcRenderer.invoke(
          EMBEDDED_BROWSER_COMMENT_BRIDGE_EVENT,
          pending.envelope
        );
        if (result && typeof result === "object" && result.success === false && result.retryable === true) {
          scheduleRetry();
          return;
        }
        pendingMessages.shift();
        pending.resolve(result);
      } catch {
        scheduleRetry();
        return;
      }
    }
  })().finally(() => {
    drainPromise = null;
  });
  return drainPromise;
}
import_electron.contextBridge.exposeInIsolatedWorld(EMBEDDED_COMMENT_WORLD_ID, EMBEDDED_COMMENT_BRIDGE_API_KEY, {
  emitCommentEvent(envelope) {
    if (pendingMessages.length >= MAX_PENDING_COMMENT_MESSAGES) {
      return Promise.resolve({ success: false, error: "Browser comment transport queue is full" });
    }
    return new Promise((resolve) => {
      pendingMessages.push({ envelope, resolve });
      void drainPendingMessages();
    });
  }
});
import_electron.contextBridge.exposeInIsolatedWorld(
  EMBEDDED_AGENT_CURSOR_WORLD_ID,
  EMBEDDED_AGENT_CURSOR_BRIDGE_API_KEY,
  {
    emitCursorEvent(envelope) {
      return import_electron.ipcRenderer.invoke(EMBEDDED_BROWSER_AGENT_CURSOR_EVENT, envelope);
    }
  }
);

// main/modules/browser/miniapp-preload.ts
var import_electron2 = require("electron");

// ../../packages/shared/dist/miniapp-surface.js
var MINIAPP_COMPOSER_MAX_TEXT_LENGTH = 1e5;
var MINIAPP_COMPOSER_FAILURE_CODES = [
  "user_cancelled",
  "invalid_request",
  "text_too_large",
  "not_allowed",
  "target_unavailable",
  "result_unknown"
];
function parseMiniAppComposerAppendResult(value) {
  if (!value || typeof value !== "object")
    return null;
  const result = value;
  if (result.success === true)
    return { success: true };
  const code = MINIAPP_COMPOSER_FAILURE_CODES.find((candidate) => candidate === result.code);
  return result.success === false && code ? { success: false, code } : null;
}

// main/modules/browser/miniapp-preload.ts
var MINIAPP_COMPOSER_APPEND = "miniapp:composer-append";
if (process.isMainFrame) {
  import_electron2.contextBridge.exposeInMainWorld("mcode", {
    miniapp: {
      message: {
        // Only an individually confirmed draft append. Sent messages are never writable here.
        async append(text) {
          if (typeof text !== "string") {
            throw new Error("invalid_request");
          }
          if (text.length > MINIAPP_COMPOSER_MAX_TEXT_LENGTH) {
            throw new Error("text_too_large");
          }
          let response;
          try {
            response = await import_electron2.ipcRenderer.invoke(MINIAPP_COMPOSER_APPEND, { text });
          } catch {
            throw new Error("result_unknown");
          }
          const result = parseMiniAppComposerAppendResult(response);
          if (!result) throw new Error("result_unknown");
          if (!result.success) throw new Error(result.code);
        }
      }
    }
  });
}
