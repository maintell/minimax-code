import { ipcMain } from "electron";
import { randomUUID } from "node:crypto";
/** Session-scoped bridge shared by the live Word and Excel tools. */
export function createOfficeEditorBroker(channel) {
    const owners = new Map();
    const pending = new Map();
    const operations = new Map();
    let installed = false;
    const watched = new WeakSet();
    function setup() {
        if (installed)
            return;
        installed = true;
        ipcMain.handle(`${channel}:register`, (event, input) => {
            if (!input ||
                typeof input.documentId !== 'string' ||
                !input.documentId ||
                input.documentId.length > 8192 ||
                typeof input.sessionId !== 'string' ||
                !input.sessionId)
                throw new Error('Invalid Office editor registration');
            const old = owners.get(input.documentId);
            if (old && old.sender !== event.sender && !old.sender.isDestroyed())
                throw new Error('Office document is open in another window');
            owners.set(input.documentId, { sessionId: input.sessionId, sender: event.sender });
            if (watched.has(event.sender))
                return;
            watched.add(event.sender);
            event.sender.once('destroyed', () => {
                for (const [key, owner] of owners)
                    if (owner.sender === event.sender)
                        owners.delete(key);
                for (const [id, task] of pending)
                    if (task.sender === event.sender) {
                        clearTimeout(task.timer);
                        pending.delete(id);
                        task.reject(new Error('Office editor window closed'));
                    }
            });
        });
        ipcMain.on(`${channel}:unregister`, (event, documentId) => {
            if (owners.get(documentId)?.sender === event.sender)
                owners.delete(documentId);
        });
        ipcMain.on(`${channel}:result`, (event, result) => {
            const task = pending.get(result?.requestId);
            if (!task || task.sender !== event.sender)
                return;
            pending.delete(result.requestId);
            clearTimeout(task.timer);
            if (result.error)
                task.reject(new Error(result.error));
            else
                task.resolve(result.value);
        });
    }
    async function invoke(sender, sessionId, input, signal) {
        if (sender.isDestroyed())
            throw new Error('Office editor window closed');
        return new Promise((resolve, reject) => {
            const requestId = randomUUID();
            if (signal.aborted) {
                reject(new Error('Office operation canceled'));
                return;
            }
            const cancel = () => {
                pending.delete(requestId);
                clearTimeout(timer);
                signal.removeEventListener('abort', cancel);
                try {
                    if (!sender.isDestroyed())
                        sender.send(`${channel}:cancel`, requestId);
                }
                catch {
                    /* Window closed during cancellation. */
                }
                reject(new Error('Office operation canceled; inspect current state'));
            };
            const timer = setTimeout(cancel, 55000);
            signal.addEventListener('abort', cancel, { once: true });
            pending.set(requestId, {
                sender,
                resolve: (value) => {
                    signal.removeEventListener('abort', cancel);
                    resolve(value);
                },
                reject: (error) => {
                    signal.removeEventListener('abort', cancel);
                    reject(error);
                },
                timer,
            });
            try {
                sender.send(`${channel}:request`, { requestId, sessionId, input });
            }
            catch (error) {
                pending.delete(requestId);
                clearTimeout(timer);
                signal.removeEventListener('abort', cancel);
                reject(error);
            }
        });
    }
    function handleMessage(target, message) {
        if (!message || typeof message !== 'object' || !('type' in message))
            return false;
        if (message.type === `${channel}-cancel` && 'requestId' in message) {
            const operation = operations.get(String(message.requestId));
            if (operation?.target === target)
                operation.controller.abort();
            return true;
        }
        if (message.type !== `${channel}-request`)
            return false;
        const request = message;
        const controller = new AbortController();
        if (operations.has(request.requestId))
            return true;
        operations.set(request.requestId, { target, controller });
        void (async () => {
            if (typeof request.requestId !== 'string' ||
                typeof request.sessionId !== 'string' ||
                !request.sessionId ||
                !request.input ||
                typeof request.input !== 'object')
                throw new Error('Invalid Office editor request');
            const entries = [...owners.entries()].filter(([, owner]) => owner.sessionId === request.sessionId && !owner.sender.isDestroyed());
            if (request.input.action === 'list') {
                const windows = [...new Set(entries.map(([, owner]) => owner.sender))];
                const results = await Promise.all(windows.map((sender) => invoke(sender, request.sessionId, request.input, controller.signal)));
                return results.flat();
            }
            if (typeof request.input.documentId !== 'string' || !request.input.documentId)
                throw new Error('Office editor request is missing documentId; send it as a top-level string field');
            const owner = owners.get(request.input.documentId);
            if (!owner || owner.sessionId !== request.sessionId)
                throw new Error('Office editor is not open in this session');
            return invoke(owner.sender, request.sessionId, request.input, controller.signal);
        })()
            .then((value) => target.postMessage({ type: `${channel}-result`, requestId: request.requestId, value }), (error) => target.postMessage({
            type: `${channel}-result`,
            requestId: request.requestId,
            error: error instanceof Error ? error.message : String(error),
        }))
            .catch(() => { })
            .finally(() => operations.delete(request.requestId));
        return true;
    }
    return { setup, handleMessage };
}
