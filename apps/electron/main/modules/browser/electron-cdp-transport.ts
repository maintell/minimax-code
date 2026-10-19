import { browserTransportInterruptionError } from "@mavis/browser-core";
/**
 * Electron implementation of the provider-neutral BrowserPageTransport.
 *
 * This is deliberately the only place in the extracted transport boundary
 * that knows about WebContents.debugger. Browser Core must not import
 * Electron types.
 */
export class ElectronCdpTransport {
    constructor(webContents, options = {}) {
        this.webContents = webContents;
        this.attached = false;
        this.ownsAttachment = false;
        this.autoAttachConfigured = false;
        this.attachedFrames = new Map();
        this.listeners = new Set();
        this.messageHandler = null;
        this.autoAttachOopifEnabled = options.autoAttachOopif !== false;
    }
    get sessionId() {
        return String(this.webContents.id);
    }
    /** Let the shared Core claim OOPIF routing on an existing legacy transport. */
    enableOopifAutoAttach() {
        this.autoAttachOopifEnabled = true;
    }
    async start(signal) {
        this.ensureAvailable();
        if (signal?.aborted)
            throw new Error('ABORTED: Browser transport startup was cancelled');
        this.ensureAttached();
        if (!this.autoAttachOopifEnabled || this.autoAttachConfigured)
            return;
        this.ensureMessageHandler();
        await this.send('Target.setAutoAttach', {
            autoAttach: true,
            waitForDebuggerOnStart: false,
            flatten: true,
        }, undefined, { signal });
        this.autoAttachConfigured = true;
    }
    async send(method, params, sessionId, options = {}) {
        this.ensureAvailable();
        return abortableCommand(() => {
            this.ensureAttached();
            return (sessionId === undefined
                ? this.webContents.debugger.sendCommand(method, params)
                : this.webContents.debugger.sendCommand(method, params, sessionId));
        }, method, options);
    }
    async evaluate(expression, options = {}) {
        this.ensureAvailable();
        return abortableCommand(() => this.webContents.executeJavaScript(expression, true), 'Runtime.evaluate', options);
    }
    async evaluateInAllFrames(expression, options = {}) {
        this.ensureAvailable();
        const frames = this.webContents.mainFrame.framesInSubtree.filter((frame) => !frame.isDestroyed() && !frame.detached);
        return Promise.all(frames.map((frame) => abortableCommand(() => frame.executeJavaScript(expression), 'Runtime.evaluate(frame)', options)));
    }
    listAttachedFrames() {
        return [...this.attachedFrames.values()];
    }
    onEvent(listener) {
        this.listeners.add(listener);
        this.ensureMessageHandler();
        return () => {
            this.listeners.delete(listener);
            if (this.listeners.size === 0)
                this.removeMessageHandler();
        };
    }
    waitForEvent(method, timeoutMs = 5000, options) {
        return new Promise((resolve) => {
            let done = false;
            const unsubscribe = this.onEvent((event) => {
                if (event.method !== method)
                    return;
                finish(event.params);
            });
            const timer = setTimeout(() => finish(undefined), timeoutMs);
            const finish = (value) => {
                if (done)
                    return;
                done = true;
                clearTimeout(timer);
                options?.signal?.removeEventListener('abort', onAbort);
                unsubscribe();
                resolve(value);
            };
            const onAbort = () => finish(undefined);
            options?.signal?.addEventListener('abort', onAbort, { once: true });
            if (options?.signal?.aborted)
                onAbort();
        });
    }
    async stopLoading() {
        this.ensureAvailable();
        this.webContents.stop();
    }
    async close() {
        this.removeMessageHandler();
        this.attachedFrames.clear();
        this.autoAttachConfigured = false;
        if (!this.attached || this.webContents.isDestroyed?.())
            return;
        if (!this.ownsAttachment) {
            this.attached = false;
            return;
        }
        try {
            this.webContents.debugger.detach();
        }
        catch {
            // A renderer that is already closing may reject detach; cleanup is best effort.
        }
        finally {
            this.attached = false;
            this.ownsAttachment = false;
        }
    }
    async resetConnection() {
        this.removeMessageHandler();
        this.attachedFrames.clear();
        this.autoAttachConfigured = false;
        if (this.webContents.isDestroyed?.()) {
            this.attached = false;
            this.ownsAttachment = false;
            this.recoveryFailure = undefined;
            return;
        }
        const debuggerAttached = this.readDebuggerAttachmentState();
        if (debuggerAttached === undefined) {
            throw this.poisonAfterUnprovenReset(new Error('Electron debugger attachment state is unavailable'));
        }
        if (debuggerAttached) {
            try {
                // Recovery is stricter than normal close. This transport sent the
                // uncertain command through the shared WebContents debugger, so even a
                // borrowed attachment must be detached before another action can run.
                this.webContents.debugger.detach();
            }
            catch (error) {
                if (this.readDebuggerAttachmentState() !== false) {
                    throw this.poisonAfterUnprovenReset(error);
                }
            }
        }
        if (this.readDebuggerAttachmentState() !== false) {
            throw this.poisonAfterUnprovenReset(new Error('Electron debugger remained attached after reset'));
        }
        this.attached = false;
        this.ownsAttachment = false;
        this.recoveryFailure = undefined;
    }
    ensureAvailable() {
        if (this.recoveryFailure)
            throw this.recoveryFailure;
        if (this.webContents.isDestroyed?.())
            throw new Error('WebContents not available');
    }
    readDebuggerAttachmentState() {
        try {
            return this.webContents.debugger.isAttached();
        }
        catch {
            return undefined;
        }
    }
    poisonAfterUnprovenReset(cause) {
        const error = Object.assign(new Error('BROWSER_SESSION_POISONED: Electron debugger recovery could not prove the old attachment was isolated; recreate the Browser page before continuing'), { cause });
        this.recoveryFailure = error;
        return error;
    }
    ensureAttached() {
        if (this.attached)
            return;
        try {
            this.webContents.debugger.attach('1.3');
            this.ownsAttachment = true;
        }
        catch {
            // Electron throws when another owner already attached the debugger. The
            // existing Browser implementation treats that state as usable.
            this.ownsAttachment = false;
        }
        this.attached = true;
    }
    ensureMessageHandler() {
        if (this.messageHandler)
            return;
        this.ensureAvailable();
        this.ensureAttached();
        const handler = (_event, method, params, sessionId) => {
            this.trackAttachedTarget(method, params, sessionId);
            const event = {
                method,
                ...(params === undefined ? {} : { params }),
                ...(sessionId ? { sessionId } : {}),
            };
            for (const listener of this.listeners)
                listener(event);
        };
        this.messageHandler = handler;
        this.webContents.debugger.on('message', handler);
    }
    removeMessageHandler() {
        const handler = this.messageHandler;
        if (!handler)
            return;
        try {
            this.webContents.debugger.removeListener('message', handler);
        }
        catch {
            // Renderer teardown can race listener removal.
        }
        this.messageHandler = null;
    }
    trackAttachedTarget(method, params, parentSessionId) {
        const values = asRecord(params);
        if (method === 'Target.attachedToTarget') {
            const childSessionId = asString(values.sessionId);
            const targetInfo = asRecord(values.targetInfo);
            const frameId = asString(targetInfo.targetId);
            if (!childSessionId || !frameId || asString(targetInfo.type) !== 'iframe')
                return;
            this.attachedFrames.set(childSessionId, {
                sessionId: childSessionId,
                frameId,
                ...(parentSessionId ? { parentSessionId } : {}),
                ...(asString(targetInfo.url) ? { url: asString(targetInfo.url) } : {}),
            });
            void this.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, childSessionId).catch(() => undefined);
            return;
        }
        if (method === 'Target.detachedFromTarget') {
            const childSessionId = asString(values.sessionId);
            if (childSessionId)
                this.attachedFrames.delete(childSessionId);
        }
    }
}

function asRecord(value) {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value
        : {};
}
function asString(value) {
    return typeof value === 'string' ? value : '';
}
function abortableCommand(createCommand, label, options) {
    if (options.signal?.aborted) {
        return Promise.reject(browserTransportInterruptionError('ABORTED', `CDP command aborted: ${label}`));
    }
    const command = createCommand();
    if (!options.signal && !options.timeoutMs)
        return command;
    return new Promise((resolve, reject) => {
        let settled = false;
        let timer;
        const finish = (callback) => {
            if (settled)
                return;
            settled = true;
            if (timer)
                clearTimeout(timer);
            options.signal?.removeEventListener('abort', onAbort);
            callback();
        };
        const onAbort = () => finish(() => reject(browserTransportInterruptionError('ABORTED', `CDP command aborted: ${label}`)));
        options.signal?.addEventListener('abort', onAbort, { once: true });
        if (options.timeoutMs && options.timeoutMs > 0) {
            timer = setTimeout(() => finish(() => reject(browserTransportInterruptionError('BROWSER_OPERATION_TIMEOUT', `CDP command timed out: ${label}`))), options.timeoutMs);
            timer.unref?.();
        }
        command.then((value) => finish(() => resolve(value)), (error) => finish(() => reject(error)));
    });
}
