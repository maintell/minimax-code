/**
 * Counts in-flight downloads per initiating page across the Browser sessions.
 * Reclaiming the initiating page mid-transfer can interrupt the download or
 * its save prompt, so the hidden-tab sweep treats an active download as a keepalive.
 */
export class EmbeddedBrowserDownloadTracker {
    constructor(onSettled = () => undefined) {
        this.onSettled = onSettled;
        this.active = new Map();
        this.sessions = new Set();
    }
    /** Idempotent per session; the listener lives as long as the session. */
    watch(session) {
        if (!session || typeof session.on !== 'function' || this.sessions.has(session))
            return;
        this.sessions.add(session);
        session.on('will-download', (_event, item, contents) => this.track(item, contents));
    }
    hasActiveDownload(contents) {
        return contents ? (this.active.get(contents.id) ?? 0) > 0 : false;
    }
    track(item, contents) {
        if (!contents)
            return;
        const id = contents.id;
        this.active.set(id, (this.active.get(id) ?? 0) + 1);
        let settled = false;
        item.once('done', () => {
            if (settled)
                return;
            settled = true;
            const remaining = (this.active.get(id) ?? 1) - 1;
            if (remaining > 0)
                this.active.set(id, remaining);
            else
                this.active.delete(id);
            this.onSettled();
        });
    }
}

