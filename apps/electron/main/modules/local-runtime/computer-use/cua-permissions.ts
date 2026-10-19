import { randomUUID } from "node:crypto";
/** Query Electron main before every driver operation, including retained task use. */
export function createCuaPermissionChecker(port, generation) {
    const pending = new Map();
    port.on('message', ({ data }) => {
        if (!data || typeof data !== 'object')
            return;
        const message = data;
        if (message.type !== 'cua-permissions-response' || message.generation !== generation)
            return;
        if (typeof message.requestId === 'string')
            pending.get(message.requestId)?.(message);
    });
    return (signal) => {
        signal.throwIfAborted();
        return new Promise((resolve, reject) => {
            const requestId = randomUUID();
            const finish = (error) => {
                clearTimeout(timer);
                signal.removeEventListener('abort', abort);
                pending.delete(requestId);
                if (error)
                    reject(error);
                else
                    resolve();
            };
            const abort = () => finish(new Error('computer_aborted'));
            const timer = setTimeout(() => finish(new Error('computer_permission_check_failed')), 2000);
            pending.set(requestId, (message) => {
                if (message.ready === true)
                    finish();
                else
                    finish(new Error('computer_permission_required: Open the Computer Use plugin and grant Screen Recording and Accessibility before continuing. Do not retry or switch delivery modes to bypass permissions.'));
            });
            signal.addEventListener('abort', abort, { once: true });
            try {
                port.postMessage({ type: 'cua-permissions-request', generation, requestId });
            }
            catch {
                finish(new Error('computer_permission_check_failed'));
            }
        });
    };
}
