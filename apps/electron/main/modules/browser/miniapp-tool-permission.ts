import { randomUUID } from "node:crypto";
import { readMiniAppToolPermissionDecision } from "@mavis/shared/miniapp-surface";
/**
 * Host prompt for Mini App tool permissions, one at a time like the composer confirmation.
 * Requests come from the Utility (Node `context.tool` or a page `tool.request`), so Main picks
 * the window: the Host window when visible or when the plugin has an open page. A prompt that
 * cannot be shown is `unavailable`; one whose answer is lost after it was shown is a deny.
 */
export class MiniAppToolPermissionBroker {
    constructor(options) {
        this.options = options;
        this.pending = null;
        this.queued = [];
        this.closed = false;
    }
    request(input) {
        if (this.closed || input.signal.aborted)
            return Promise.resolve('unavailable');
        const target = this.options.manager.resolveMiniAppPromptTarget(input.pluginId);
        if (!target)
            return Promise.resolve('unavailable');
        const request = {
            requestId: randomUUID(),
            mode: input.mode,
            pluginId: input.pluginId,
            pluginName: target.pluginName,
            tools: input.tools,
        };
        return new Promise((resolve) => {
            const onAbort = () => this.finish(prompt, prompt.sent ? { decision: 'deny' } : 'unavailable', true);
            const stopWatching = this.options.manager.observeHostDocumentEnd(target.host, () => this.finish(prompt, prompt.sent ? { decision: 'deny' } : 'unavailable'));
            const prompt = {
                request,
                host: target.host,
                frame: target.frame,
                sent: false,
                resolve,
                dispose: () => {
                    stopWatching();
                    input.signal.removeEventListener('abort', onAbort);
                },
            };
            input.signal.addEventListener('abort', onAbort, { once: true });
            this.queued.push(prompt);
            this.startNext();
        });
    }
    /** The IPC adapter verified the Host origin; match the shown document and request here. */
    reply(sender, value) {
        const pending = this.pending;
        if (!pending || !value || typeof value !== 'object')
            return;
        const input = value;
        if (input.requestId !== pending.request.requestId ||
            sender.sender !== pending.host ||
            sender.senderFrame !== pending.frame ||
            pending.frame.detached) {
            return;
        }
        // `null`: the Host UI was not mounted and showed nothing.
        if (input.result === null) {
            this.finish(pending, 'unavailable');
            return;
        }
        this.finish(pending, readMiniAppToolPermissionDecision(input.result) ?? { decision: 'deny' });
    }
    dispose() {
        this.closed = true;
        if (this.pending)
            this.finish(this.pending, { decision: 'deny' });
        for (const prompt of [...this.queued])
            this.finish(prompt, 'unavailable');
    }
    startNext() {
        if (this.pending || this.closed)
            return;
        const prompt = this.queued.shift();
        if (!prompt)
            return;
        this.pending = prompt;
        if (prompt.host.isDestroyed() || prompt.frame.detached) {
            this.finish(prompt, 'unavailable');
            return;
        }
        prompt.sent = true;
        try {
            this.options.send(prompt.frame, prompt.request);
        }
        catch {
            this.finish(prompt, { decision: 'deny' });
        }
    }
    finish(prompt, answer, withdraw = false) {
        const wasActive = this.pending === prompt;
        if (wasActive)
            this.pending = null;
        else {
            const index = this.queued.indexOf(prompt);
            if (index === -1)
                return;
            this.queued.splice(index, 1);
        }
        prompt.dispose();
        if (withdraw && prompt.sent) {
            try {
                this.options.cancel(prompt.frame, prompt.request.requestId);
            }
            catch {
                // The Host document is gone; nothing left to close.
            }
        }
        if (wasActive)
            queueMicrotask(() => this.startNext());
        prompt.resolve(answer);
    }
}

let activeBroker = null;
/** Set by the IPC setup that owns the reply channel; `null` on teardown. */
export function setActiveMiniAppToolPermissionBroker(broker) {
    activeBroker = broker;
}
/** The Utility hook: without a registered Host UI, nobody can be asked. */
export function requestMiniAppToolPermission(input) {
    return activeBroker ? activeBroker.request(input) : Promise.resolve('unavailable');
}
