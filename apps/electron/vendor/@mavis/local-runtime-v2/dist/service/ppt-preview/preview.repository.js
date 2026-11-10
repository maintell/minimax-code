import { and, asc, eq, gt } from 'drizzle-orm';
import { pptPreviewArtifacts as artifacts, pptPreviewRequests as requests, pptPreviewEvents as events, } from '../../infra/db/schema/ppt-preview.js';
import { PptPreviewError } from '@mavis/shared/ppt-preview';
/** Publishes the aggregate, event cursor and request receipt in one transaction. */
export class PreviewRepository {
    db;
    nowMs;
    constructor(db, nowMs) {
        this.db = db;
        this.nowMs = nowMs;
    }
    list(sessionId) {
        return this.db
            .select()
            .from(artifacts)
            .where(eq(artifacts.sessionId, sessionId))
            .all()
            .map((r) => JSON.parse(r.stateJson));
    }
    all() {
        return this.db
            .select()
            .from(artifacts)
            .all()
            .map((r) => JSON.parse(r.stateJson));
    }
    receipt(sessionId, requestId, fingerprint) {
        const r = this.db
            .select()
            .from(requests)
            .where(and(eq(requests.sessionId, sessionId), eq(requests.requestId, requestId)))
            .get();
        if (!r)
            return undefined;
        if (fingerprint !== undefined && r.fingerprint !== fingerprint)
            throw new PptPreviewError('IDEMPOTENCY_KEY_REUSED', 'requestId was already used for different content');
        return JSON.parse(r.resultJson);
    }
    events(sessionId, cursor) {
        return this.db
            .select()
            .from(events)
            .where(and(eq(events.sessionId, sessionId), gt(events.cursor, cursor)))
            .orderBy(asc(events.cursor))
            .limit(100)
            .all()
            .map((r) => ({
            eventCursor: r.cursor,
            artifactId: r.artifactId,
            createdAtMs: r.createdAtMs,
            event: JSON.parse(r.eventJson),
        }));
    }
    commit(a, event, receipt) {
        this.db.transaction((tx) => {
            const createdAtMs = this.nowMs();
            const e = tx
                .insert(events)
                .values({
                sessionId: a.sessionId,
                artifactId: a.artifactId,
                eventJson: JSON.stringify({
                    type: event,
                    generationId: a.generation.generationId,
                    revision: a.generation.acceptedRevision,
                }),
                createdAtMs,
            })
                .returning({ cursor: events.cursor })
                .get();
            a.eventCursor = e.cursor;
            a.updatedAtMs = createdAtMs;
            tx.insert(artifacts)
                .values({
                artifactId: a.artifactId,
                sessionId: a.sessionId,
                artifactKey: a.artifactKey,
                stateJson: JSON.stringify(a),
                updatedAtMs: createdAtMs,
            })
                .onConflictDoUpdate({
                target: artifacts.artifactId,
                set: { stateJson: JSON.stringify(a), updatedAtMs: createdAtMs },
            })
                .run();
            if (receipt)
                tx.insert(requests)
                    .values({
                    sessionId: a.sessionId,
                    requestId: receipt.requestId,
                    fingerprint: receipt.fingerprint,
                    resultJson: JSON.stringify(receipt.result),
                    createdAtMs,
                })
                    .run();
        }, { behavior: 'immediate' });
    }
}
//# sourceMappingURL=preview.repository.js.map