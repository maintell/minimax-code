import { resolve } from 'node:path';
import { sha256File } from '../files/local-file.js';
import { cloudDriveNodeIdOf, localMediaKind } from './service.js';
/** Recent deliveries checked per pass; older ones were checked when their Turn ended. */
const RECENT_FILES_LIMIT = 50;
/** Deliveries already checked in this process, oldest forgotten first. */
const MAX_ATTEMPTED = 1024;
/**
 * Links generated media a local Session delivered to the Drive node it came from.
 *
 * MCP generation writes the image or video to Drive without a Session, and a desktop
 * Session id means nothing to the cloud, so the link is kept locally: when a Turn ends,
 * recent local image and video deliveries without a sync record go through
 * `SessionMediaIdentityService.enrich`, and each one it proves to be a node of this
 * Session's generation receipts is recorded with `recordSessionFileSync`. The Space
 * library then finds the Session by node id. Every delivery is tried once per message in
 * this process; failures are logged and never reach the Turn.
 */
export class SessionMediaNodeBinder {
    options;
    running = new Map();
    attempted = new Set();
    constructor(options) {
        this.options = options;
    }
    /** Never rejects. A Turn end during a pass makes that pass run once more. */
    async onTurnEnded(sessionId) {
        const active = this.running.get(sessionId);
        if (active) {
            active.rerun = true;
            return;
        }
        const state = { rerun: true };
        this.running.set(sessionId, state);
        try {
            while (state.rerun) {
                state.rerun = false;
                try {
                    await this.bindOnce(sessionId);
                }
                catch (error) {
                    this.warn({ sessionId, error }, 'Linking delivered media to Drive nodes failed');
                }
            }
        }
        finally {
            this.running.delete(sessionId);
        }
    }
    async bindOnce(sessionId) {
        const pending = await this.pendingMedia(sessionId);
        if (!pending.length)
            return;
        // `enrich` maps the files one to one, in order.
        const enriched = await this.options.identity.enrich(sessionId, pending.map((item) => item.file));
        for (const [index, file] of enriched.entries()) {
            const nodeId = cloudDriveNodeIdOf(file);
            const item = pending[index];
            if (nodeId && item)
                await this.record(sessionId, item.path, nodeId);
        }
    }
    async pendingMedia(sessionId) {
        const session = await this.options.sessions.get(sessionId);
        if (!session)
            return [];
        const { files } = await this.options.files.listSessionFiles({
            sessionId,
            limit: RECENT_FILES_LIMIT,
        });
        const media = files
            .filter((file) => localMediaKind(file))
            .map((file) => ({ file, path: resolve(session.workspaceDir, file.path) }));
        if (!media.length)
            return [];
        const synced = await this.options.files.getSessionFileSyncs({
            sessionId,
            paths: media.map((item) => item.path),
        });
        const recorded = new Set(synced.map((state) => state.path));
        return media.filter((item) => !recorded.has(item.path) && this.claim(sessionId, item.file));
    }
    /** False when this delivery was already tried; a later message delivering it again retries. */
    claim(sessionId, file) {
        const key = `${sessionId}\0${file.assetKey}\0${file.messageId}`;
        if (this.attempted.has(key))
            return false;
        this.attempted.add(key);
        if (this.attempted.size > MAX_ATTEMPTED) {
            const oldest = this.attempted.values().next();
            if (!oldest.done)
                this.attempted.delete(oldest.value);
        }
        return true;
    }
    async record(sessionId, path, nodeId) {
        const sha256 = await sha256File(path);
        if (!sha256)
            return;
        try {
            await this.options.files.recordSessionFileSync({ sessionId, path, nodeId, sha256 });
        }
        catch (error) {
            this.warn({ sessionId, nodeId, error }, 'Recording a delivered media Drive node failed');
        }
    }
    warn(fields, message) {
        try {
            this.options.logger?.warn(fields, message);
        }
        catch {
            /* Logging must not break the pass. */
        }
    }
}
//# sourceMappingURL=session-node-binder.js.map