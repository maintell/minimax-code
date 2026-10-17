import { randomUUID } from "node:crypto";
/** The utility uses the authenticated parent channel; there is no local HTTP endpoint. */
export class UtilityOfficeEditorClient {
    constructor(send, channel) {
        this.send = send;
        this.channel = channel;
        this.pending = new Map();
        this.closed = false;
        this.port = {
            execute: (sessionId, input, signal) => new Promise((resolve, reject) => {
                if (this.closed) {
                    reject(new Error('Office editor connection closed'));
                    return;
                }
                if (signal?.aborted) {
                    reject(new Error('Operation canceled'));
                    return;
                }
                const requestId = randomUUID();
                const cancel = () => {
                    this.pending.delete(requestId);
                    cleanup();
                    try {
                        this.send({ type: `${this.channel}-cancel`, requestId });
                    }
                    catch {
                        /* Parent already closed. */
                    }
                    reject(new Error('Office request canceled; inspect current state before retrying'));
                };
                const timer = setTimeout(cancel, 60000);
                const cleanup = () => {
                    clearTimeout(timer);
                    signal?.removeEventListener('abort', cancel);
                };
                this.pending.set(requestId, { resolve, reject, cleanup });
                signal?.addEventListener('abort', cancel, { once: true });
                try {
                    this.send({ type: `${this.channel}-request`, requestId, sessionId, input });
                }
                catch (error) {
                    this.pending.delete(requestId);
                    cleanup();
                    reject(error);
                }
            }),
        };
    }
    handleMessage(message) {
        if (!message ||
            typeof message !== 'object' ||
            !('type' in message) ||
            message.type !== `${this.channel}-result`)
            return false;
        const result = message;
        const task = this.pending.get(result.requestId);
        if (task) {
            this.pending.delete(result.requestId);
            task.cleanup();
            if (result.error)
                task.reject(new Error(result.error));
            else
                task.resolve(result.value);
        }
        return true;
    }
    close() {
        this.closed = true;
        for (const [requestId, task] of this.pending) {
            try {
                this.send({ type: `${this.channel}-cancel`, requestId });
            }
            catch {
                /* Parent already closed. */
            }
            task.cleanup();
            task.reject(new Error('Office editor connection closed'));
        }
        this.pending.clear();
    }
}

