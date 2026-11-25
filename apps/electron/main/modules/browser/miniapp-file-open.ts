import { IPC_CHANNELS } from "../../config/constants.js";
import { getEmbeddedBrowserManager } from "./embedded-browser-manager.js";
const MAX_PENDING_PER_TAB = 16;
const withoutHash = (url) => url.split('#', 1)[0] ?? url;
/**
 * Holds file opens for a Mini App tab until its page subscribes, then streams them. One queue per
 * tab and run: the page document ending, or the tab serving a new run, discards what was queued.
 * A reload of the same URL keeps the queue, but the new document must subscribe again.
 */
export class MiniAppFileOpenBroker {
    constructor(options) {
        this.options = options;
        this.queues = new Map();
    }
    /** Never throws: the open that produced this file is already visible and must not fail for it. */
    deliver(tabId, open) {
        try {
            const queue = this.queue(tabId);
            if (!queue)
                return;
            if (queue.subscribed) {
                this.send(queue, open);
                return;
            }
            if (queue.pending.length >= MAX_PENDING_PER_TAB)
                queue.pending.shift();
            queue.pending.push(open);
        }
        catch {
            // A tab torn down mid-delivery has no page left to show the file.
        }
    }
    subscribe(sender) {
        const identity = this.options.manager.identifyMiniAppPageTab(sender.sender, sender.senderFrame);
        if (!identity)
            return { success: false, code: 'host_unavailable' };
        const queue = this.queue(identity.tabId);
        if (!queue || queue.page !== sender.sender)
            return { success: false, code: 'host_unavailable' };
        queue.subscribed = true;
        for (const open of queue.pending.splice(0))
            this.send(queue, open);
        return { success: true };
    }
    unsubscribe(sender) {
        const identity = this.options.manager.identifyMiniAppPageTab(sender.sender, sender.senderFrame);
        const queue = identity ? this.queues.get(identity.tabId) : undefined;
        if (queue && queue.page === sender.sender)
            queue.subscribed = false;
    }
    dispose() {
        for (const queue of this.queues.values())
            queue.stopObserving();
        this.queues.clear();
    }
    /** The tab's current queue; a run change or a page swap starts a fresh one. */
    queue(tabId) {
        const live = this.options.manager.miniAppTabPage(tabId);
        if (!live) {
            this.drop(tabId);
            return null;
        }
        const existing = this.queues.get(tabId);
        if (existing && existing.runId === live.runId && existing.page === live.page)
            return existing;
        this.drop(tabId);
        const queue = {
            runId: live.runId,
            page: live.page,
            url: withoutHash(live.page.getURL()),
            pending: [],
            subscribed: false,
            stopObserving: () => { },
        };
        queue.stopObserving = this.observe(tabId, queue);
        this.queues.set(tabId, queue);
        return queue;
    }
    /**
     * `did-navigate` fires on every committed main-frame navigation, including a reload; only a
     * different URL is a different document that the queued files were not meant for.
     */
    observe(tabId, queue) {
        const page = queue.page;
        const end = () => {
            if (this.queues.get(tabId) === queue)
                this.drop(tabId);
        };
        const onNavigate = (_event, url) => {
            if (typeof url === 'string' && withoutHash(url) === queue.url) {
                queue.subscribed = false;
                return;
            }
            end();
        };
        page.on('did-navigate', onNavigate);
        const stopDeath = this.options.manager.observeMiniAppPageDeath(page, end);
        return () => {
            page.removeListener('did-navigate', onNavigate);
            stopDeath();
        };
    }
    drop(tabId) {
        const queue = this.queues.get(tabId);
        if (!queue)
            return;
        this.queues.delete(tabId);
        queue.stopObserving();
    }
    send(queue, open) {
        try {
            this.options.sendOpen(queue.page, open);
        }
        catch {
            // A page torn down between the check and the send has nothing to receive.
        }
    }
}

let broker = null;
export function getMiniAppFileOpenBroker() {
    broker ?? (broker = new MiniAppFileOpenBroker({
        manager: getEmbeddedBrowserManager(),
        sendOpen: (page, open) => page.send(IPC_CHANNELS.MINIAPP_FILES_EVENT, { open }),
    }));
    return broker;
}
