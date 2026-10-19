require("./preload.js");
import { contextBridge, ipcRenderer } from "electron";
import { MINIAPP_COMPOSER_MAX_TEXT_LENGTH, parseMiniAppComposerAppendResult } from "@mavis/shared/miniapp-surface";
const MINIAPP_COMPOSER_APPEND = 'miniapp:composer-append';
if (process.isMainFrame) {
    contextBridge.exposeInMainWorld('mcode', {
        miniapp: {
            message: {
                // Only an individually confirmed draft append. Sent messages are never writable here.
                async append(text) {
                    if (typeof text !== 'string') {
                        throw new Error('invalid_request');
                    }
                    if (text.length > MINIAPP_COMPOSER_MAX_TEXT_LENGTH) {
                        throw new Error('text_too_large');
                    }
                    let response;
                    try {
                        response = await ipcRenderer.invoke(MINIAPP_COMPOSER_APPEND, { text });
                    }
                    catch {
                        // An invoke failure can race with a committed append. Never retry
                        // implicitly or expose transport errors to the untrusted page.
                        throw new Error('result_unknown');
                    }
                    const result = parseMiniAppComposerAppendResult(response);
                    if (!result)
                        throw new Error('result_unknown');
                    if (!result.success)
                        throw new Error(result.code);
                },
            },
        },
    });
}
