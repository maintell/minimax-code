import { and, count, desc, eq, lt, or } from 'drizzle-orm';
import { bunnyArtifactLibrary } from '../../../../infra/db/schema/bunny-store.js';
/** An imported file in catalog shape: no session, so nothing to open as its source. */
function catalogRow(row) {
    return {
        assetKey: row.assetKey,
        name: row.name,
        category: row.category,
        path: row.path,
        sessionId: '',
        sessionTitle: '',
        sessionArchived: 0,
        workspaceDir: row.workspaceDir,
        messageId: '',
        deliveredAtMs: row.importedAtMs,
        spaceId: row.spaceId,
        updatedAtMs: row.updatedAtMs,
        origin: 'import',
        sourceAvailable: 0,
        externalDelivery: 0,
    };
}
/**
 * The files the user imported into spaces, read from the Bunny store in the catalog's order.
 * Their session ID is empty, so a cursor taken from a session delivery of the same time lets
 * every import of that time through, and one taken from an import compares asset keys.
 */
export function createImportedArtifacts(bunny) {
    const table = bunnyArtifactLibrary;
    return {
        page: ({ spaceId, before, limit }) => bunny
            .select()
            .from(table)
            .where(and(spaceId ? eq(table.spaceId, spaceId) : undefined, before
            ? or(lt(table.importedAtMs, before.time), and(eq(table.importedAtMs, before.time), before.session === '' ? lt(table.assetKey, before.key) : undefined))
            : undefined))
            .orderBy(desc(table.importedAtMs), desc(table.assetKey))
            .limit(limit + 1)
            .all()
            .map(catalogRow),
        find: (assetKey) => {
            const row = bunny.select().from(table).where(eq(table.assetKey, assetKey)).get();
            return row ? catalogRow(row) : undefined;
        },
        countsBySpace: () => bunny
            .select({ spaceId: table.spaceId, count: count() })
            .from(table)
            .groupBy(table.spaceId)
            .all(),
    };
}
//# sourceMappingURL=imports.js.map