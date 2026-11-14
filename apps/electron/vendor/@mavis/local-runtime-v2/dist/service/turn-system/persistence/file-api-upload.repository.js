import { and, eq } from 'drizzle-orm';
import { fileApiUploads } from '../../../infra/db/schema/file-api.js';
/**
 * The Files API wiring of a product's model requests: the per-Session upload cache in the runtime
 * database, plus the product's fetch and logger. The Turn executor and the advisor both use it,
 * so their requests upload media the same way and share uploads.
 */
export function createFileApiRuntime(options) {
    return {
        uploadStores: createFileApiUploadStoreSource({
            db: options.db,
            ...(options.nowMs ? { nowMs: options.nowMs } : {}),
        }),
        ...(options.product?.fetchImpl ? { fetchImpl: options.product.fetchImpl } : {}),
        ...(options.product?.logger ? { logger: options.product.logger } : {}),
    };
}
/** @internal Exported only for focused tests; production wiring uses {@link createFileApiRuntime}. */
export function createFileApiUploadStoreSource(options) {
    const nowMs = options.nowMs ?? Date.now;
    return {
        forSession: (sessionId) => createSessionStore(options.db, sessionId, nowMs),
    };
}
function createSessionStore(db, sessionId, nowMs) {
    return {
        get: (cacheKey, key) => {
            const row = db
                .select()
                .from(fileApiUploads)
                .where(and(eq(fileApiUploads.sessionId, sessionId), eq(fileApiUploads.cacheKey, cacheKey)))
                .get();
            if (!row || !matchesKey(row, key))
                return undefined;
            if (row.expiresAtMs <= nowMs()) {
                db.delete(fileApiUploads)
                    .where(and(eq(fileApiUploads.sessionId, sessionId), eq(fileApiUploads.cacheKey, cacheKey)))
                    .run();
                return undefined;
            }
            return { fileId: row.fileId, expiresAtMs: row.expiresAtMs };
        },
        set: (cacheKey, _entry, record) => {
            const now = nowMs();
            db.insert(fileApiUploads)
                .values({
                sessionId,
                cacheKey,
                contentHash: record.contentHash,
                endpointHash: record.endpointHash,
                callerIdentityHash: record.callerIdentityHash,
                ttlSec: record.ttlSec,
                fileId: record.fileId,
                expiresAtMs: record.expiresAtMs,
                createdAtMs: now,
                updatedAtMs: now,
            })
                .onConflictDoUpdate({
                target: [fileApiUploads.sessionId, fileApiUploads.cacheKey],
                set: {
                    contentHash: record.contentHash,
                    endpointHash: record.endpointHash,
                    callerIdentityHash: record.callerIdentityHash,
                    ttlSec: record.ttlSec,
                    fileId: record.fileId,
                    expiresAtMs: record.expiresAtMs,
                    updatedAtMs: now,
                },
            })
                .run();
        },
    };
}
function matchesKey(row, key) {
    return (row.contentHash === key.contentHash &&
        row.endpointHash === key.endpointHash &&
        row.callerIdentityHash === key.callerIdentityHash &&
        row.ttlSec === key.ttlSec);
}
//# sourceMappingURL=file-api-upload.repository.js.map