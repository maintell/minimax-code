import { and, eq, sql } from 'drizzle-orm';
import { bunnyMediaDescriptions } from '../../../infra/db/schema/bunny-store.js';
import { indexedAttachmentAssetId, } from '../../session-system/index.js';
/**
 * Media descriptions in the Bunny store, keyed by (session, message ID, asset ID).
 * A later compaction that describes the same attachment replaces the line.
 * The compactor names an attachment by its path; the row takes the asset ID the
 * message's own attachment carries, the one its search index line uses (15.2).
 */
export function createBunnyMediaDescriptionRepository(options) {
    const nowMs = options.nowMs ?? Date.now;
    const { db } = options;
    const list = (sessionId) => db
        .select({
        sessionId: bunnyMediaDescriptions.sessionId,
        messageId: bunnyMediaDescriptions.messageId,
        assetId: bunnyMediaDescriptions.assetId,
        description: bunnyMediaDescriptions.description,
        seen: bunnyMediaDescriptions.seen,
        compactionId: bunnyMediaDescriptions.compactionId,
    })
        .from(bunnyMediaDescriptions)
        .where(eq(bunnyMediaDescriptions.sessionId, sessionId))
        .orderBy(bunnyMediaDescriptions.messageId, bunnyMediaDescriptions.assetId)
        .all();
    return {
        upsert: async (sessionId, described, compactionId) => {
            if (described.length === 0)
                return;
            const items = await Promise.all(described.map((item) => withIndexedAssetId(options.messages, sessionId, item)));
            const now = nowMs();
            db.transaction((tx) => {
                for (const item of items) {
                    tx.insert(bunnyMediaDescriptions)
                        .values({
                        sessionId,
                        messageId: item.messageId,
                        assetId: item.assetId,
                        description: item.description,
                        seen: item.seen,
                        compactionId,
                        createdAtMs: now,
                        updatedAtMs: now,
                    })
                        .onConflictDoUpdate({
                        target: [
                            bunnyMediaDescriptions.sessionId,
                            bunnyMediaDescriptions.messageId,
                            bunnyMediaDescriptions.assetId,
                        ],
                        set: {
                            description: item.description,
                            seen: item.seen,
                            compactionId,
                            updatedAtMs: sql `excluded.updated_at_ms`,
                        },
                    })
                        .run();
                }
            });
        },
        list,
        describedAssets: async (sessionId) => new Map(list(sessionId).map((row) => [row.assetId, row.description])),
    };
}
/**
 * The stored descriptions the conversation search index appends to an attachment's
 * file-name line (spec 12.6); without one the line is the file name.
 */
export function storedMediaDescriptions(db) {
    return {
        describe: (key) => {
            try {
                return db
                    .select({ description: bunnyMediaDescriptions.description })
                    .from(bunnyMediaDescriptions)
                    .where(and(eq(bunnyMediaDescriptions.sessionId, key.sessionId), eq(bunnyMediaDescriptions.messageId, key.messageId), eq(bunnyMediaDescriptions.assetId, key.assetId)))
                    .get()?.description;
            }
            catch {
                // A description is a supplement; the file name line stands without it.
                return undefined;
            }
        },
    };
}
/** Rows per insert statement, well below SQLite's bound-variable limit. */
const RESTORE_CHUNK = 100;
/**
 * The media descriptions' part of a Bunny reset. Only Bunny's segment compaction writes
 * them, so a reset backs up and clears them all; clearing and restoring join the caller's
 * Bunny-store transaction.
 */
export function createMediaDescriptionReset(db) {
    return {
        snapshot: () => db.select().from(bunnyMediaDescriptions).all(),
        clear: (tx) => {
            tx.delete(bunnyMediaDescriptions).run();
        },
        /** Puts back the rows a backup recorded; a row with the same key that exists now is kept. */
        restore: (tx, rows = []) => {
            for (let start = 0; start < rows.length; start += RESTORE_CHUNK)
                tx.insert(bunnyMediaDescriptions)
                    .values(rows.slice(start, start + RESTORE_CHUNK))
                    .onConflictDoNothing()
                    .run();
        },
    };
}
async function withIndexedAssetId(messages, sessionId, item) {
    if (!messages)
        return item;
    try {
        const message = await messages.get(sessionId, item.messageId);
        const assetId = message && indexedAttachmentAssetId(message, item.assetId);
        return assetId ? { ...item, assetId } : item;
    }
    catch {
        return item;
    }
}
//# sourceMappingURL=media-descriptions.js.map