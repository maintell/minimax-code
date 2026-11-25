import { and, eq, inArray, isNull } from 'drizzle-orm';
import { sessionMergeRequests } from '../../infra/db/schema/session-merge-requests.js';
import { mergeRequestKey } from './code-host/urls.js';
/** When the same merge request is recorded twice, the stronger source is kept. */
const SOURCE_RANK = {
    branch: 0,
    manual: 1,
    created: 2,
};
export class SessionMergeRequestLinkStore {
    db;
    constructor(db) {
        this.db = db;
    }
    listActive(sessionIds) {
        if (sessionIds.length === 0)
            return [];
        return this.db
            .select()
            .from(sessionMergeRequests)
            .where(and(inArray(sessionMergeRequests.sessionId, [...sessionIds]), isNull(sessionMergeRequests.removedAtMs)))
            .all()
            .flatMap(toLink);
    }
    /**
     * Records a link found automatically. Returns true when the Session gained a
     * link it did not have. A link the user removed stays removed.
     */
    record(link) {
        const existing = this.find(link.sessionId, link.ref);
        if (existing?.removedAtMs != null)
            return false;
        if (existing) {
            if (SOURCE_RANK[link.source] > rankOf(existing.source)) {
                this.updateSource(link.sessionId, link.ref, link.source);
            }
            return false;
        }
        this.insert(link);
        return true;
    }
    /** The user linked it: active again even after an earlier removal. Returns true when it was not active. */
    link(entry) {
        const existing = this.find(entry.sessionId, entry.ref);
        if (!existing) {
            this.insert({ ...entry, source: 'manual' });
            return true;
        }
        if (existing.removedAtMs == null)
            return false;
        this.db
            .update(sessionMergeRequests)
            .set({
            removedAtMs: null,
            source: 'manual',
            linkedAtMs: entry.linkedAtMs,
            webUrl: entry.webUrl,
        })
            .where(this.matches(entry.sessionId, entry.ref))
            .run();
        return true;
    }
    /** Returns false when the Session had no active link to this merge request. */
    remove(sessionId, ref, nowMs) {
        const result = this.db
            .update(sessionMergeRequests)
            .set({ removedAtMs: nowMs })
            .where(and(this.matches(sessionId, ref), isNull(sessionMergeRequests.removedAtMs)))
            .run();
        return result.changes > 0;
    }
    /** Sessions with an active link to this merge request. */
    sessionsLinking(ref) {
        return this.db
            .select({ sessionId: sessionMergeRequests.sessionId })
            .from(sessionMergeRequests)
            .where(and(eq(sessionMergeRequests.refKey, mergeRequestKey(ref)), isNull(sessionMergeRequests.removedAtMs)))
            .all()
            .map((row) => row.sessionId);
    }
    deleteSession(sessionId) {
        this.db.delete(sessionMergeRequests).where(eq(sessionMergeRequests.sessionId, sessionId)).run();
    }
    /** Hosts that some Session links to, for the settings page. */
    listHosts() {
        const rows = this.db
            .selectDistinct({ platform: sessionMergeRequests.platform, host: sessionMergeRequests.host })
            .from(sessionMergeRequests)
            .where(isNull(sessionMergeRequests.removedAtMs))
            .all();
        return rows.flatMap((row) => row.platform === 'gitlab' || row.platform === 'github'
            ? [{ platform: row.platform, host: row.host }]
            : []);
    }
    find(sessionId, ref) {
        return this.db.select().from(sessionMergeRequests).where(this.matches(sessionId, ref)).get();
    }
    insert(link) {
        this.db
            .insert(sessionMergeRequests)
            .values({
            sessionId: link.sessionId,
            refKey: mergeRequestKey(link.ref),
            platform: link.ref.platform,
            host: link.ref.host,
            projectPath: link.ref.projectPath,
            number: link.ref.number,
            webUrl: link.webUrl,
            source: link.source,
            linkedAtMs: link.linkedAtMs,
        })
            .run();
    }
    updateSource(sessionId, ref, source) {
        this.db.update(sessionMergeRequests).set({ source }).where(this.matches(sessionId, ref)).run();
    }
    matches(sessionId, ref) {
        return and(eq(sessionMergeRequests.sessionId, sessionId), eq(sessionMergeRequests.refKey, mergeRequestKey(ref)));
    }
}
function rankOf(source) {
    return source === 'branch' || source === 'manual' || source === 'created'
        ? SOURCE_RANK[source]
        : 0;
}
function toLink(row) {
    if (row.platform !== 'gitlab' && row.platform !== 'github')
        return [];
    if (row.source !== 'branch' && row.source !== 'manual' && row.source !== 'created')
        return [];
    return [
        {
            sessionId: row.sessionId,
            ref: {
                platform: row.platform,
                host: row.host,
                projectPath: row.projectPath,
                number: row.number,
            },
            webUrl: row.webUrl,
            source: row.source,
            linkedAtMs: row.linkedAtMs,
        },
    ];
}
//# sourceMappingURL=link-store.js.map