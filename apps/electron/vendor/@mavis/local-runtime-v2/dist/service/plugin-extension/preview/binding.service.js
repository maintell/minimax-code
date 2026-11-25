import { and, eq } from 'drizzle-orm';
import { extensionPreviewBindings } from '../../../infra/db/schema/plugin.js';
/**
 * The session preview record: per `(session, plugin)`, the candidate the session's preview last
 * bound. A record means the session previews the plugin (restored on resume); a record whose
 * `boundDigest` is the installed version was installed, so the installed tier merges its store
 * overlay, withdraws the preview and deletes the record. Whether the Agent may preview at all is an `extension` /
 * `preview` permission rule, not a record here. SQLite is the authority; the map only saves reads.
 */
export class PreviewBindingService {
    db;
    nowMs;
    cache = new Map();
    constructor(db, nowMs = Date.now) {
        this.db = db;
        this.nowMs = nowMs;
    }
    find(sessionId, pluginId) {
        const key = cacheKey(sessionId, pluginId);
        if (this.cache.has(key))
            return this.cache.get(key) ?? undefined;
        return this.reload(sessionId, pluginId);
    }
    /** Binds the candidate the session's preview of the plugin activates next. */
    bind(sessionId, pluginId, digest) {
        const now = this.nowMs();
        this.db
            .insert(extensionPreviewBindings)
            .values({
            sessionId,
            pluginId,
            boundDigest: digest,
            updatedAtMs: now,
        })
            .onConflictDoUpdate({
            target: [extensionPreviewBindings.sessionId, extensionPreviewBindings.pluginId],
            set: { boundDigest: digest, updatedAtMs: now },
        })
            .run();
        return this.reload(sessionId, pluginId);
    }
    /** The session no longer previews the plugin. */
    unbind(sessionId, pluginId) {
        this.db.delete(extensionPreviewBindings).where(this.key(sessionId, pluginId)).run();
        this.cache.set(cacheKey(sessionId, pluginId), null);
    }
    list() {
        return this.db.select().from(extensionPreviewBindings).all().map(toBinding);
    }
    deleteSession(sessionId) {
        this.db
            .delete(extensionPreviewBindings)
            .where(eq(extensionPreviewBindings.sessionId, sessionId))
            .run();
        for (const key of [...this.cache.keys()]) {
            if (key.startsWith(`${sessionId}\u0000`))
                this.cache.delete(key);
        }
    }
    reload(sessionId, pluginId) {
        const row = this.db
            .select()
            .from(extensionPreviewBindings)
            .where(this.key(sessionId, pluginId))
            .get();
        const binding = row ? toBinding(row) : undefined;
        this.cache.set(cacheKey(sessionId, pluginId), binding ?? null);
        return binding;
    }
    key(sessionId, pluginId) {
        return and(eq(extensionPreviewBindings.sessionId, sessionId), eq(extensionPreviewBindings.pluginId, pluginId));
    }
}
function cacheKey(sessionId, pluginId) {
    return `${sessionId}\u0000${pluginId}`;
}
function toBinding(row) {
    return {
        sessionId: row.sessionId,
        pluginId: row.pluginId,
        boundDigest: row.boundDigest,
        updatedAtMs: row.updatedAtMs,
    };
}
//# sourceMappingURL=binding.service.js.map