import { ipcRenderer } from "electron";
import { isMiniAppFileOpen, isMiniAppHostErrorCode } from "@mavis/shared/miniapp-surface";
const SUBSCRIBE = 'miniapp:files-subscribe';
const UNSUBSCRIBE = 'miniapp:files-unsubscribe';
const EVENT = 'miniapp:files-event';
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const failure = (code) => ({ code, message: code });
/**
 * One Main subscription per document, shared by every page listener. Main replays what it queued
 * once per page subscribe, when the first listener attaches; every listener present when that
 * replay arrives receives it, and a listener added after that only sees later opens.
 */
export function createMiniAppFilesAPI(environment) {
    const entries = new Set();
    let ended = false;
    let registered = false;
    let registration = 0;
    const receive = (_event, value) => {
        if (!isRecord(value) || !isMiniAppFileOpen(value.open))
            return;
        for (const { listener } of [...entries]) {
            try {
                listener(value.open);
            }
            catch {
                console.error('[miniapp] files listener threw');
            }
        }
    };
    const unregister = () => {
        if (!registered)
            return;
        registered = false;
        ipcRenderer.removeListener(EVENT, receive);
        try {
            ipcRenderer.send(UNSUBSCRIBE, {});
        }
        catch {
            /* document ended */
        }
    };
    const terminateAll = (code) => {
        const current = [...entries];
        entries.clear();
        unregister();
        for (const { onError } of current) {
            try {
                if (onError)
                    onError(failure(code));
                else
                    console.error('[miniapp] files subscription ended:', code);
            }
            catch {
                console.error('[miniapp] files onError handler threw');
            }
        }
    };
    const register = () => {
        // A reply that arrives after its registration ended answers that one, not the current.
        const generation = ++registration;
        registered = true;
        ipcRenderer.on(EVENT, receive);
        void ipcRenderer.invoke(SUBSCRIBE, {}).then((value) => {
            if (!registered || generation !== registration)
                return;
            if (isRecord(value) && value.success === true)
                return;
            terminateAll(isRecord(value) && isMiniAppHostErrorCode(value.code) ? value.code : 'result_unknown');
        }, () => {
            if (generation !== registration)
                return;
            terminateAll('result_unknown');
        });
    };
    environment.onPageHide(() => {
        ended = true;
        terminateAll('host_unavailable');
    });
    return {
        subscribe(listener, options) {
            const invalid = typeof listener !== 'function' ||
                (options !== undefined &&
                    (!isRecord(options) ||
                        (options.onError !== undefined && typeof options.onError !== 'function')));
            const onError = typeof options?.onError === 'function' ? options.onError : undefined;
            if (invalid || ended) {
                queueMicrotask(() => {
                    try {
                        if (onError)
                            onError(failure(invalid ? 'invalid_request' : 'host_unavailable'));
                    }
                    catch {
                        console.error('[miniapp] files onError handler threw');
                    }
                });
                return { dispose: () => { } };
            }
            const entry = { listener, onError };
            entries.add(entry);
            if (!registered)
                register();
            return {
                dispose: () => {
                    if (entries.delete(entry) && entries.size === 0)
                        unregister();
                },
            };
        },
    };
}
