import { eq } from 'drizzle-orm';
import { bunnySpaceSessions } from '../../../infra/db/schema/bunny-store.js';
/** The search index's Session → space links, read from the Bunny store's space links. */
export function createBunnyStoreSearchSpaceLinks(db) {
    return {
        sessionSpace: (sessionId) => db
            .select({ spaceId: bunnySpaceSessions.spaceId })
            .from(bunnySpaceSessions)
            .where(eq(bunnySpaceSessions.sessionId, sessionId))
            .get()?.spaceId,
        spaceSessions: (spaceId) => db
            .select({ sessionId: bunnySpaceSessions.sessionId })
            .from(bunnySpaceSessions)
            .where(eq(bunnySpaceSessions.spaceId, spaceId))
            .all()
            .map((row) => row.sessionId),
    };
}
//# sourceMappingURL=space-links.js.map