import { eq, inArray } from 'drizzle-orm';
import { bunnyArtifactLibrary, bunnySpaces, bunnySpaceSessions, } from '../../../../infra/db/schema/bunny-store.js';
/** Rows per insert statement, well below SQLite's bound-variable limit. */
const CHUNK = 100;
export function createLibraryReset(bunny) {
    return {
        spaces: () => bunny
            .select()
            .from(bunnySpaces)
            .all()
            .map((space) => ({ id: space.id, name: space.name })),
        links: (spaceId) => bunny
            .select({ sessionId: bunnySpaceSessions.sessionId, spaceId: bunnySpaceSessions.spaceId })
            .from(bunnySpaceSessions)
            .where(spaceId === undefined ? undefined : eq(bunnySpaceSessions.spaceId, spaceId))
            .all(),
        imports: (spaceIds) => bunny
            .select()
            .from(bunnyArtifactLibrary)
            .where(inArray(bunnyArtifactLibrary.spaceId, [...spaceIds]))
            .all(),
        clear: (tx, spaceIds) => {
            tx.delete(bunnySpaceSessions).run();
            tx.delete(bunnySpaces).run();
            tx.delete(bunnyArtifactLibrary)
                .where(inArray(bunnyArtifactLibrary.spaceId, [...spaceIds]))
                .run();
        },
        restoreImports: (tx, rows = []) => {
            for (let start = 0; start < rows.length; start += CHUNK)
                tx.insert(bunnyArtifactLibrary)
                    .values(rows.slice(start, start + CHUNK))
                    .onConflictDoNothing()
                    .run();
        },
        detach: (tx, spaceId) => {
            if (spaceId === undefined) {
                tx.delete(bunnySpaceSessions).run();
                tx.delete(bunnySpaces).run();
                tx.update(bunnyArtifactLibrary).set({ spaceId: null }).run();
                return;
            }
            tx.delete(bunnySpaceSessions).where(eq(bunnySpaceSessions.spaceId, spaceId)).run();
            tx.delete(bunnySpaces).where(eq(bunnySpaces.id, spaceId)).run();
            tx.update(bunnyArtifactLibrary)
                .set({ spaceId: null })
                .where(eq(bunnyArtifactLibrary.spaceId, spaceId))
                .run();
        },
    };
}
//# sourceMappingURL=reset.js.map