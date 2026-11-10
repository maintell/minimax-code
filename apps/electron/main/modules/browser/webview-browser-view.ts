import { browserGuestRegistry } from "./browser-guest-registry.js";
export class WebviewBrowserView {
    constructor(host, id, webContents) {
        this.host = host;
        this.id = id;
        this.webContents = webContents;
        this.releaseRendering = null;
        webContents.once('destroyed', () => this.setRendering(false));
    }
    static async create(host, preferences, signal, transparentBackground = false, anchorKey) {
        const { id, guest } = await browserGuestRegistry.create(host, preferences, signal, transparentBackground, anchorKey);
        return new WebviewBrowserView(host, id, guest);
    }
    layout(bounds, page, visible) {
        return browserGuestRegistry.layout(this.host, this.id, bounds, page, visible);
    }
    setRendering(active) {
        if (!active) {
            this.releaseRendering?.();
            this.releaseRendering = null;
            return;
        }
        if (this.releaseRendering || this.webContents.isDestroyed())
            return;
        const releaseHost = browserGuestRegistry.acquireRendering(this.host);
        try {
            this.webContents.beginFrameSubscription(true, () => undefined);
        }
        catch (error) {
            releaseHost();
            throw error;
        }
        this.releaseRendering = () => {
            try {
                if (!this.webContents.isDestroyed())
                    this.webContents.endFrameSubscription();
            }
            finally {
                releaseHost();
            }
        };
    }
    destroy() {
        this.setRendering(false);
        browserGuestRegistry.destroy(this.host, this.id);
    }
}

