import { withLocalRuntimeDb } from '../persistence/db.js';
const REVISION_PATCH_COLUMNS = {
    archiveOssKey: 'archive_oss_key',
    manifestOssKey: 'manifest_oss_key',
    remoteState: 'remote_state',
    retryCount: 'retry_count',
    nextRetryAtMs: 'next_retry_at_ms',
    lastErrorCode: 'last_error_code',
    embeddingModel: 'embedding_model',
    dimensions: 'dimensions',
    normalization: 'normalization',
    indexSha256: 'index_sha256',
    indexSizeBytes: 'index_size_bytes',
    indexArchivePath: 'index_archive_path',
    updatedAtMs: 'updated_at_ms',
};
export class SqliteWorkspaceIndexingStore {
    dataDir;
    constructor(dataDir) {
        this.dataDir = dataDir;
    }
    async getSession(sessionId) {
        return this.withDb((db) => toSessionRecord(db
            .prepare(`SELECT * FROM local_runtime_workspace_indexing_sessions WHERE session_id = ?`)
            .get(sessionId)));
    }
    async putSession(record) {
        this.withDb((db) => this.putSessionInDb(db, record));
    }
    putSessionInDb(db, record) {
        db.prepare(`
          INSERT INTO local_runtime_workspace_indexing_sessions (
            session_id, workspace_id, workspace_real_path, status,
            initial_revision_id, latest_revision_id, latest_root_hash, skip_reason,
            policy_workspace_version, created_at_ms, updated_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(session_id) DO UPDATE SET
            workspace_id = excluded.workspace_id,
            workspace_real_path = excluded.workspace_real_path,
            status = excluded.status,
            initial_revision_id = excluded.initial_revision_id,
            latest_revision_id = excluded.latest_revision_id,
            latest_root_hash = excluded.latest_root_hash,
            skip_reason = excluded.skip_reason,
            policy_workspace_version = excluded.policy_workspace_version,
            updated_at_ms = excluded.updated_at_ms
        `).run(record.sessionId, record.workspaceId, record.workspaceRealPath, record.status, record.initialRevisionId ?? null, record.latestRevisionId ?? null, record.latestRootHash ?? null, record.skipReason ?? null, record.policyWorkspaceVersion ?? null, record.createdAtMs, record.updatedAtMs);
    }
    async getRevision(revisionId) {
        return this.withDb((db) => toRevisionRecord(db
            .prepare(`SELECT * FROM local_runtime_workspace_indexing_revisions WHERE revision_id = ?`)
            .get(revisionId)));
    }
    async getLatestRevision(sessionId) {
        return this.withDb((db) => toRevisionRecord(db
            .prepare(`
              SELECT *
              FROM local_runtime_workspace_indexing_revisions
              WHERE session_id = ?
              ORDER BY sequence DESC
              LIMIT 1
            `)
            .get(sessionId)));
    }
    async listRevisions(sessionId) {
        return this.withDb((db) => db
            .prepare(`
            SELECT *
            FROM local_runtime_workspace_indexing_revisions
            WHERE session_id = ?
            ORDER BY sequence ASC
          `)
            .all(sessionId)
            .map(toRequiredRevisionRecord));
    }
    async insertRevision(record) {
        this.withDb((db) => this.insertRevisionInDb(db, record));
    }
    async commitCapture(session, revision) {
        this.withDb((db) => runInTransaction(db, () => {
            this.putSessionInDb(db, session);
            this.insertRevisionInDb(db, revision);
        }));
    }
    insertRevisionInDb(db, record) {
        db.prepare(`
          INSERT INTO local_runtime_workspace_indexing_revisions (
            revision_id, session_id, workspace_id, sequence, kind, root_hash,
            base_revision_id, base_root_hash, archive_path, manifest_path,
            archive_sha256, manifest_sha256, archive_oss_key, manifest_oss_key,
            remote_state, retry_count, next_retry_at_ms, last_error_code,
            embedding_model, dimensions, normalization, index_sha256,
            index_size_bytes, index_archive_path, created_at_ms, updated_at_ms
          ) VALUES (
            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
          )
        `).run(record.revisionId, record.sessionId, record.workspaceId, record.sequence, record.kind, record.rootHash, record.baseRevisionId ?? null, record.baseRootHash ?? null, record.archivePath, record.manifestPath, record.archiveSha256, record.manifestSha256, record.archiveOssKey ?? null, record.manifestOssKey ?? null, record.remoteState, record.retryCount, record.nextRetryAtMs, record.lastErrorCode ?? null, record.embeddingModel ?? null, record.dimensions ?? null, record.normalization ?? null, record.indexSha256 ?? null, record.indexSizeBytes ?? null, record.indexArchivePath ?? null, record.createdAtMs, record.updatedAtMs);
    }
    async patchRevision(revisionId, patch) {
        const entries = Object.entries(patch).filter(([, value]) => value !== undefined);
        if (entries.length === 0)
            return;
        this.withDb((db) => {
            const assignments = entries.map(([key]) => `${REVISION_PATCH_COLUMNS[key]} = ?`);
            db.prepare(`UPDATE local_runtime_workspace_indexing_revisions SET ${assignments.join(', ')}
         WHERE revision_id = ?`).run(...entries.map(([, value]) => value), revisionId);
        });
    }
    async listRemoteWork(nowMs, limit) {
        const normalizedLimit = Math.max(1, Math.floor(limit));
        return this.withDb((db) => db
            .prepare(`
            SELECT *
            FROM local_runtime_workspace_indexing_revisions
            WHERE remote_state NOT IN ('ready', 'failed_terminal')
              AND next_retry_at_ms <= ?
            ORDER BY next_retry_at_ms ASC, created_at_ms ASC
            LIMIT ?
          `)
            .all(nowMs, normalizedLimit)
            .map(toRequiredRevisionRecord));
    }
    async countRemoteWork(nowMs) {
        return this.withDb((db) => {
            const row = db
                .prepare(`
            SELECT COUNT(*) AS pending, MIN(created_at_ms) AS oldest_created_at_ms
            FROM local_runtime_workspace_indexing_revisions
            WHERE remote_state NOT IN ('ready', 'failed_terminal')
              AND next_retry_at_ms <= ?
          `)
                .get(nowMs);
            return {
                pending: row?.pending ?? 0,
                ...(row?.oldest_created_at_ms === null || row?.oldest_created_at_ms === undefined
                    ? {}
                    : { oldestCreatedAtMs: row.oldest_created_at_ms }),
            };
        });
    }
    async deleteSession(sessionId) {
        this.withDb((db) => {
            db.prepare(`DELETE FROM local_runtime_workspace_indexing_sessions WHERE session_id = ?`).run(sessionId);
        });
    }
    withDb(fn) {
        return withLocalRuntimeDb(this.dataDir, fn);
    }
}
function runInTransaction(db, fn) {
    if (db.transaction)
        return db.transaction(fn)();
    return fn();
}
function toSessionRecord(row) {
    if (!row)
        return undefined;
    return {
        sessionId: row.session_id,
        workspaceId: row.workspace_id,
        workspaceRealPath: row.workspace_real_path,
        status: row.status,
        ...(row.initial_revision_id ? { initialRevisionId: row.initial_revision_id } : {}),
        ...(row.latest_revision_id ? { latestRevisionId: row.latest_revision_id } : {}),
        ...(row.latest_root_hash ? { latestRootHash: row.latest_root_hash } : {}),
        ...(row.skip_reason ? { skipReason: row.skip_reason } : {}),
        ...(row.policy_workspace_version
            ? { policyWorkspaceVersion: row.policy_workspace_version }
            : {}),
        createdAtMs: row.created_at_ms,
        updatedAtMs: row.updated_at_ms,
    };
}
function toRevisionRecord(row) {
    if (!row)
        return undefined;
    return {
        revisionId: row.revision_id,
        sessionId: row.session_id,
        workspaceId: row.workspace_id,
        sequence: row.sequence,
        kind: row.kind,
        rootHash: row.root_hash,
        ...(row.base_revision_id ? { baseRevisionId: row.base_revision_id } : {}),
        ...(row.base_root_hash ? { baseRootHash: row.base_root_hash } : {}),
        archivePath: row.archive_path,
        manifestPath: row.manifest_path,
        archiveSha256: row.archive_sha256,
        manifestSha256: row.manifest_sha256,
        ...(row.archive_oss_key ? { archiveOssKey: row.archive_oss_key } : {}),
        ...(row.manifest_oss_key ? { manifestOssKey: row.manifest_oss_key } : {}),
        remoteState: row.remote_state,
        retryCount: row.retry_count,
        nextRetryAtMs: row.next_retry_at_ms,
        ...(row.last_error_code ? { lastErrorCode: row.last_error_code } : {}),
        ...(row.embedding_model ? { embeddingModel: row.embedding_model } : {}),
        ...(row.dimensions !== null ? { dimensions: row.dimensions } : {}),
        ...(row.normalization ? { normalization: row.normalization } : {}),
        ...(row.index_sha256 ? { indexSha256: row.index_sha256 } : {}),
        ...(row.index_size_bytes !== null ? { indexSizeBytes: row.index_size_bytes } : {}),
        ...(row.index_archive_path ? { indexArchivePath: row.index_archive_path } : {}),
        createdAtMs: row.created_at_ms,
        updatedAtMs: row.updated_at_ms,
    };
}
function toRequiredRevisionRecord(row) {
    const record = toRevisionRecord(row);
    if (!record) {
        throw new Error('workspace_indexing_revision_row_missing');
    }
    return record;
}
//# sourceMappingURL=store.js.map