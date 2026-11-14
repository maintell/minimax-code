import { and, eq, inArray } from 'drizzle-orm';
import { messageRows, sessionAssets } from '../../../infra/db/schema/messages.js';
/** Read deliveries from the same session asset index used by the catalog. */
export function readAssignmentAssets(db, sessionId, turnId) {
    const ids = turnId
        ? db
            .select({ id: messageRows.messageId })
            .from(messageRows)
            .where(and(eq(messageRows.sessionId, sessionId), eq(messageRows.turnId, turnId)))
            .all()
            .map((row) => row.id)
        : undefined;
    return db
        .selectDistinct({ path: sessionAssets.path })
        .from(sessionAssets)
        .where(and(eq(sessionAssets.sessionId, sessionId), eq(sessionAssets.sourceTag, 'deliver-assets'), ids ? inArray(sessionAssets.messageId, ids) : undefined))
        .all();
}
//# sourceMappingURL=report-assets.adapter.js.map