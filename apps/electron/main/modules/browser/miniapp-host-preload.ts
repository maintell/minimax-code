import { ipcRenderer } from "electron";
import { isMiniAppHostErrorCode, parseMiniAppHostUIResponse, parseMiniAppHostUIState, parseMiniAppHostNavigationResponse, parseMiniAppHostNavigationState, readMiniAppHostOpenTarget, parseMiniAppHostOpenResponse } from "@mavis/shared/miniapp-surface";
const GET_STATE = 'miniapp:host-get-state';
const SUBSCRIBE = 'miniapp:host-subscribe';
const UNSUBSCRIBE = 'miniapp:host-unsubscribe';
const EVENT = 'miniapp:host-event';
const OPEN = 'miniapp:host-open';
const READ_TIMEOUT_MS = 10000;
const OPEN_TIMEOUT_MS = 65000;
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
// Electron drops custom properties when copying Error instances across contextBridge.
// A plain rejection value preserves the public code without carrying a Host stack.
function failure(code) {
    return { code, message: code };
}
async function invoke(channel, payload, timeoutMs = READ_TIMEOUT_MS) {
    let timer;
    try {
        return await Promise.race([
            ipcRenderer.invoke(channel, payload),
            new Promise((_resolve, reject) => {
                timer = setTimeout(() => reject(failure('result_unknown')), timeoutMs);
            }),
        ]);
    }
    catch {
        throw failure('result_unknown');
    }
    finally {
        clearTimeout(timer);
    }
}
export function createMiniAppHostAPI(environment) {
    let sequence = 0;
    let ended = false;
    const subscriptions = new Set();
    function subscribe(module, parseState, listener, options) {
        const invalid = typeof listener !== 'function' ||
            (options !== undefined &&
                (!isRecord(options) ||
                    (options.onError !== undefined && typeof options.onError !== 'function')));
        const onError = typeof options?.onError === 'function' ? options.onError : undefined;
        const subscriptionId = `host-${++sequence}`;
        let disposed = false;
        let registered = false;
        let revision = -1;
        let baselineTimer;
        function dispose() {
            if (disposed)
                return;
            disposed = true;
            clearTimeout(baselineTimer);
            subscriptions.delete(dispose);
            if (!registered)
                return;
            ipcRenderer.removeListener(EVENT, receive);
            try {
                ipcRenderer.send(UNSUBSCRIBE, { subscriptionId });
            }
            catch {
                // Main also owns automatic document cleanup.
            }
        }
        function terminate(code) {
            if (disposed)
                return;
            dispose();
            try {
                if (onError)
                    onError(failure(code));
                else
                    console.error('[miniapp] Host subscription ended:', code);
            }
            catch {
                console.error('[miniapp] Host onError handler threw');
            }
        }
        function receive(_event, value) {
            if (disposed || !isRecord(value) || value.subscriptionId !== subscriptionId)
                return;
            if (isRecord(value.error)) {
                terminate(isMiniAppHostErrorCode(value.error.code) ? value.error.code : 'result_unknown');
                return;
            }
            if (!Number.isSafeInteger(value.revision) || value.revision < 0) {
                terminate('result_unknown');
                return;
            }
            if (value.revision <= revision)
                return;
            const state = parseState(value.state);
            if (!state) {
                terminate('result_unknown');
                return;
            }
            revision = value.revision;
            clearTimeout(baselineTimer);
            try {
                listener(state);
            }
            catch {
                console.error('[miniapp] Host state listener threw');
            }
        }
        if (invalid || ended) {
            // Synchronous throws lose custom fields through contextBridge; registration
            // errors use the same callback contract as all other subscription failures.
            queueMicrotask(() => terminate(invalid ? 'invalid_request' : 'host_unavailable'));
            return { dispose };
        }
        // Baseline and later updates share this stream, installed before registration.
        ipcRenderer.on(EVENT, receive);
        registered = true;
        subscriptions.add(dispose);
        baselineTimer = setTimeout(() => terminate('result_unknown'), READ_TIMEOUT_MS);
        void invoke(SUBSCRIBE, { module, subscriptionId }).then((value) => {
            if (disposed) {
                // dispose may precede Main completing an asynchronous permission check.
                try {
                    ipcRenderer.send(UNSUBSCRIBE, { subscriptionId });
                }
                catch {
                    /* document ended */
                }
                return;
            }
            if (isRecord(value) && value.success === true) {
                // A page loads offscreen before its Host presents the panel. Registration
                // may be deliberately paused until it becomes logically visible.
                if (value.paused === true)
                    clearTimeout(baselineTimer);
                return;
            }
            terminate(isRecord(value) && isMiniAppHostErrorCode(value.code) ? value.code : 'result_unknown');
        }, () => terminate('result_unknown'));
        return { dispose };
    }
    environment.onPageHide(() => {
        ended = true;
        for (const dispose of [...subscriptions])
            dispose();
    });
    return {
        ui: {
            async getState() {
                if (ended)
                    throw failure('host_unavailable');
                const result = parseMiniAppHostUIResponse(await invoke(GET_STATE, { module: 'ui' }));
                if (!result)
                    throw failure('result_unknown');
                if (!result.success)
                    throw failure(result.code);
                return result.state;
            },
            subscribe: (listener, options) => subscribe('ui', parseMiniAppHostUIState, listener, options),
        },
        navigation: {
            async getState() {
                if (ended)
                    throw failure('host_unavailable');
                const result = parseMiniAppHostNavigationResponse(await invoke(GET_STATE, { module: 'navigation' }));
                if (!result)
                    throw failure('result_unknown');
                if (!result.success)
                    throw failure(result.code);
                return result.state;
            },
            subscribe: (listener, options) => subscribe('navigation', parseMiniAppHostNavigationState, listener, options),
            async open(target) {
                // Capture activation synchronously, before the first asynchronous boundary.
                const userActivated = environment.isUserActivated();
                if (!userActivated)
                    throw failure('not_permitted');
                if (ended)
                    throw failure('host_unavailable');
                const read = readMiniAppHostOpenTarget(target);
                if (!read.success)
                    throw failure(read.code);
                const result = parseMiniAppHostOpenResponse(await invoke(OPEN, { target: read.target, userActivated }, OPEN_TIMEOUT_MS));
                if (!result)
                    throw failure('result_unknown');
                if (!result.success)
                    throw failure(result.code);
                return result.result;
            },
        },
    };
}
