import { randomUUID } from "node:crypto";
import { MINIAPP_COMPOSER_MAX_TEXT_LENGTH, parseMiniAppComposerAppendResult } from "@mavis/shared/miniapp-surface";
const failure = (code) => ({ success: false, code });
/** One Host confirmation at a time; the returned Promise settles after its append result. */
export class MiniAppComposerBroker {
    constructor(options) {
        this.options = options;
        this.pending = null;
        this.queued = [];
        this.hostWatches = new Map();
        this.closed = false;
    }
    append(sender, value) {
        if (this.closed || !this.options.getAccountId())
            return Promise.resolve(failure('not_allowed'));
        if (!value || typeof value !== 'object')
            return Promise.resolve(failure('invalid_request'));
        const input = value;
        if (typeof input.text !== 'string') {
            return Promise.resolve(failure('invalid_request'));
        }
        if (input.text.length > MINIAPP_COMPOSER_MAX_TEXT_LENGTH) {
            return Promise.resolve(failure('text_too_large'));
        }
        const source = this.options.manager.captureMiniAppComposerSource(sender.sender, sender.senderFrame);
        if (!source)
            return Promise.resolve(failure('not_allowed'));
        const { sessionId, ownerWebContents: host, ownerFrame: frame } = source;
        if (!sessionId ||
            !host ||
            !frame ||
            host.isDestroyed() ||
            frame.detached ||
            host.mainFrame !== frame) {
            return Promise.resolve(failure('target_unavailable'));
        }
        const request = {
            requestId: randomUUID(),
            sessionId,
            pluginId: source.pluginId,
            pluginName: source.pluginName,
            text: input.text,
        };
        return new Promise((resolve) => {
            const pending = { request, host, frame, sent: false, resolve };
            this.queued.push(pending);
            this.watchHost(pending);
            this.startNext();
        });
    }
    /** The IPC adapter verifies the Host origin; match the original document and request here. */
    reply(sender, value) {
        const pending = this.pending;
        if (!pending || !value || typeof value !== 'object')
            return;
        const input = value;
        if (input.requestId !== pending.request.requestId ||
            sender.sender !== pending.host ||
            sender.senderFrame !== pending.frame ||
            sender.sender.isDestroyed() ||
            sender.sender.mainFrame !== pending.frame ||
            pending.frame.detached) {
            return;
        }
        const result = parseMiniAppComposerAppendResult(input.result);
        this.finish(pending, result ?? failure('result_unknown'));
    }
    dispose() {
        this.closed = true;
        if (this.pending)
            this.finish(this.pending, failure('result_unknown'));
        for (const pending of [...this.queued]) {
            this.finish(pending, failure('target_unavailable'));
        }
    }
    startNext() {
        if (this.pending || this.closed)
            return;
        const pending = this.queued.shift();
        if (!pending)
            return;
        this.pending = pending;
        if (pending.host.isDestroyed() ||
            pending.frame.detached ||
            pending.host.mainFrame !== pending.frame) {
            this.finish(pending, failure('target_unavailable'));
            return;
        }
        pending.sent = true;
        try {
            this.options.send(pending.frame, pending.request);
        }
        catch {
            // Once dispatch was attempted, never retry an append whose delivery is uncertain.
            this.finish(pending, failure('result_unknown'));
        }
    }
    watchHost(pending) {
        let watch = this.hostWatches.get(pending.host);
        if (!watch) {
            const requests = new Set();
            const ended = () => {
                for (const request of [...requests]) {
                    this.finish(request, failure(request.sent ? 'result_unknown' : 'target_unavailable'));
                }
            };
            const host = pending.host;
            watch = {
                requests,
                dispose: this.options.manager.observeHostDocumentEnd(host, ended),
            };
            this.hostWatches.set(host, watch);
        }
        watch.requests.add(pending);
    }
    finish(pending, result) {
        const wasActive = this.pending === pending;
        if (wasActive)
            this.pending = null;
        else {
            const index = this.queued.indexOf(pending);
            if (index === -1)
                return;
            this.queued.splice(index, 1);
        }
        const watch = this.hostWatches.get(pending.host);
        if (watch) {
            watch.requests.delete(pending);
            if (watch.requests.size === 0) {
                watch.dispose();
                this.hostWatches.delete(pending.host);
            }
        }
        // Let a terminal Host event remove its whole queue before another request is dispatched.
        if (wasActive)
            queueMicrotask(() => this.startNext());
        pending.resolve(result);
    }
}

