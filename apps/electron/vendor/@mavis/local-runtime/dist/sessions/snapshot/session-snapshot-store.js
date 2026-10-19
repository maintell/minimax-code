import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { resolveV2DirectoryContract } from '../../persistence/layout/v2-paths.js';
import { deleteV2SessionSnapshotSync, ensureV2ArtifactParentDirSync, ensureV2SessionArtifactManifestSync, resolveV2SessionArtifactPathsSync, } from '../../persistence/layout/v2-session-artifacts.js';
import { replayLocalSessionLedger, } from '../projection/index.js';
export const LOCAL_SESSION_SNAPSHOT_SCHEMA_VERSION = 1;
const RESUME_SOURCE_LABELS = {
    'snapshot-tail': 'snapshot_tail',
    'full-ledger': 'full_ledger',
    empty: 'empty',
};
export class FileSessionSnapshotStore {
    dataDir;
    nowMs;
    metricsClient;
    makeSnapshotId;
    constructor(dataDir, options = {}) {
        this.dataDir = dataDir;
        this.nowMs = options.nowMs ?? (() => Date.now());
        this.makeSnapshotId = options.makeSnapshotId ?? defaultSnapshotId;
        this.metricsClient = options.metricsClient;
    }
    async getLatest(sessionId) {
        try {
            const parsed = JSON.parse(await readFile(resolveLocalSessionSnapshotPath(this.dataDir, sessionId), 'utf-8'));
            return isLocalSessionSnapshot(parsed, sessionId) ? parsed : undefined;
        }
        catch (err) {
            if (err.code === 'ENOENT')
                return undefined;
            return undefined;
        }
    }
    async writeLatest(snapshot) {
        const artifactPaths = ensureV2SessionArtifactManifestSync(this.dataDir, snapshot.sessionId, {
            createdAtMs: snapshot.createdAtMs,
            updatedAtMs: snapshot.createdAtMs,
            source: 'local-runtime',
        });
        const snapshotPath = artifactPaths.snapshot;
        const contract = resolveV2DirectoryContract(this.dataDir);
        const snapshotSessionDir = artifactPaths.layout === 'legacy-draft'
            ? path.dirname(snapshotPath)
            : artifactPaths.sessionDir;
        ensureV2ArtifactParentDirSync(snapshotPath, snapshotSessionDir, contract.root);
        const tmpPath = `${snapshotPath}.${process.pid}.${randomUUID()}.tmp`;
        let serialized;
        try {
            serialized = `${JSON.stringify(snapshot)}\n`;
        }
        catch (err) {
            // A heavy session's projection can serialize past V8's max string length
            // (0x1fffffe8, ~512MB), throwing `RangeError: Invalid string length`.
            // The snapshot cache is a best-effort read
            // accelerator — the ledger is the source of truth — so skip the write
            // instead of turning an oversized session into a hard failure. The next
            // read simply falls back to a full ledger replay.
            if (isStringLengthOverflowError(err)) {
                this.metricsClient?.counter('session_snapshot_write_total', 1, {
                    status: 'skipped_oversize',
                });
                return;
            }
            throw err;
        }
        try {
            await writeFile(tmpPath, serialized, 'utf-8');
        }
        catch (err) {
            // Tmp-phase failures (ENOSPC/EACCES) keep throwing through, but must
            // still be visible as failed snapshot writes.
            this.metricsClient?.counter('session_snapshot_write_total', 1, { status: 'error' });
            throw err;
        }
        try {
            await renameWithRetry(tmpPath, snapshotPath);
            this.metricsClient?.counter('session_snapshot_write_total', 1, { status: 'ok' });
        }
        catch {
            await unlink(tmpPath).catch(() => undefined);
            // Snapshot write is best-effort — the ledger is the source of truth.
            this.metricsClient?.counter('session_snapshot_write_total', 1, { status: 'error' });
        }
    }
    async writeSnapshotFromLedger(sessionId, ledgerStore, targetWatermark) {
        let existing = await this.getLatest(sessionId);
        let events;
        try {
            events = await collectReplayEvents(sessionId, ledgerStore, existing, targetWatermark);
        }
        catch {
            existing = undefined;
            events = await collectReplayEvents(sessionId, ledgerStore, undefined, targetWatermark);
        }
        const projection = replayLocalSessionLedger(sessionId, events, existing ? snapshotToReplayBase(existing) : {});
        if (!projection.watermark) {
            await this.deleteSession(sessionId);
            return undefined;
        }
        const currentWatermark = targetWatermark ?? (await ledgerStore.getWatermark(sessionId));
        const watermark = currentWatermark && sameLedgerPoint(currentWatermark, projection.watermark)
            ? currentWatermark
            : projection.watermark;
        const snapshot = projectionToSnapshot({
            projection: { ...projection, watermark },
            snapshotId: this.makeSnapshotId(sessionId, watermark),
            createdAtMs: this.nowMs(),
            piHistoryFacts: Boolean(existing?.piHistoryFacts) || events.some(isPiHistoryFactEvent),
        });
        await this.writeLatest(snapshot);
        return snapshot;
    }
    async readResumeProjection(sessionId, ledgerStore) {
        const startMs = this.nowMs();
        try {
            const result = await this.readResumeProjectionInner(sessionId, ledgerStore);
            const source = RESUME_SOURCE_LABELS[result.source];
            this.metricsClient?.counter('session_resume_load_total', 1, { source, status: 'ok' });
            this.metricsClient?.histogram('session_resume_load_duration_ms', this.nowMs() - startMs, {
                source,
            });
            this.metricsClient?.histogram('session_resume_replayed_events', result.replayedEventCount, {
                source,
            });
            return result;
        }
        catch (err) {
            // The only path that can escape readResumeProjectionInner is the canonical full replay.
            this.metricsClient?.counter('session_resume_load_total', 1, {
                source: 'full_ledger',
                status: 'error',
            });
            throw err;
        }
    }
    async readResumeProjectionInner(sessionId, ledgerStore) {
        const snapshot = await this.getLatest(sessionId);
        if (snapshot) {
            try {
                const events = await collect(ledgerStore.readEventsAfter(sessionId, snapshot.watermark));
                const projection = replayLocalSessionLedger(sessionId, events, snapshotToReplayBase(snapshot));
                return {
                    projection,
                    source: 'snapshot-tail',
                    snapshot,
                    replayedEventCount: events.length,
                    piHistoryFacts: snapshot.piHistoryFacts || events.some(isPiHistoryFactEvent),
                };
            }
            catch {
                // Corrupt snapshot cursor or ledger tail: fall back to canonical full replay below.
                this.metricsClient?.counter('session_resume_snapshot_fallback_total', 1);
            }
        }
        const events = await collect(ledgerStore.readEvents(sessionId));
        const projection = replayLocalSessionLedger(sessionId, events);
        if (!projection.watermark) {
            await this.deleteSession(sessionId);
            return {
                projection,
                source: 'empty',
                replayedEventCount: events.length,
                piHistoryFacts: false,
            };
        }
        const currentWatermark = await ledgerStore.getWatermark(sessionId);
        const watermark = currentWatermark && sameLedgerPoint(currentWatermark, projection.watermark)
            ? currentWatermark
            : projection.watermark;
        const repairedProjection = { ...projection, watermark };
        const repairedSnapshot = projectionToSnapshot({
            projection: repairedProjection,
            snapshotId: this.makeSnapshotId(sessionId, watermark),
            createdAtMs: this.nowMs(),
            piHistoryFacts: events.some(isPiHistoryFactEvent),
        });
        await this.writeLatest(repairedSnapshot);
        return {
            projection: repairedProjection,
            source: 'full-ledger',
            snapshot: repairedSnapshot,
            replayedEventCount: events.length,
            piHistoryFacts: repairedSnapshot.piHistoryFacts,
        };
    }
    async deleteSession(sessionId) {
        deleteV2SessionSnapshotSync(this.dataDir, sessionId);
    }
}
export function resolveLocalSessionSnapshotPath(dataDir, sessionId) {
    return resolveV2SessionArtifactPathsSync(dataDir, sessionId).snapshot;
}
function projectionToSnapshot(input) {
    return {
        schemaVersion: LOCAL_SESSION_SNAPSHOT_SCHEMA_VERSION,
        snapshotId: input.snapshotId,
        sessionId: input.projection.sessionId,
        createdAtMs: input.createdAtMs,
        watermark: input.projection.watermark,
        ...(input.projection.record ? { record: input.projection.record } : {}),
        displayMessages: input.projection.displayMessages,
        piHistory: input.projection.piHistory,
        ...(input.projection.fileApiUploads ? { fileApiUploads: input.projection.fileApiUploads } : {}),
        piHistoryFacts: input.piHistoryFacts,
        deleted: input.projection.deleted,
    };
}
async function collectReplayEvents(sessionId, ledgerStore, existing, targetWatermark) {
    const source = existing
        ? ledgerStore.readEventsAfter(sessionId, existing.watermark)
        : ledgerStore.readEvents(sessionId);
    const events = await collect(source);
    if (!targetWatermark)
        return events;
    return events.filter((event) => event.seq <= targetWatermark.lastSeq);
}
function snapshotToReplayBase(snapshot) {
    return {
        ...(snapshot.record ? { record: snapshot.record } : {}),
        displayMessages: snapshot.displayMessages,
        piHistory: snapshot.piHistory,
        ...(snapshot.fileApiUploads ? { fileApiUploads: snapshot.fileApiUploads } : {}),
        deleted: snapshot.deleted,
        watermark: snapshot.watermark,
    };
}
function sameLedgerPoint(left, right) {
    return left.lastSeq === right.lastSeq && left.lastEventId === right.lastEventId;
}
function isStringLengthOverflowError(err) {
    return err instanceof RangeError && /invalid string length|string longer than/i.test(err.message);
}
async function collect(iterable) {
    const values = [];
    for await (const value of iterable)
        values.push(value);
    return values;
}
function isLocalSessionSnapshot(value, expectedSessionId) {
    if (!value || typeof value !== 'object')
        return false;
    const snapshot = value;
    return (snapshot.schemaVersion === LOCAL_SESSION_SNAPSHOT_SCHEMA_VERSION &&
        snapshot.sessionId === expectedSessionId &&
        typeof snapshot.snapshotId === 'string' &&
        typeof snapshot.createdAtMs === 'number' &&
        isLocalSessionSnapshotWatermark(snapshot.watermark, expectedSessionId) &&
        Array.isArray(snapshot.displayMessages) &&
        Array.isArray(snapshot.piHistory) &&
        isFileApiUploads(snapshot.fileApiUploads) &&
        typeof snapshot.piHistoryFacts === 'boolean' &&
        typeof snapshot.deleted === 'boolean');
}
function isFileApiUploads(value) {
    if (value === undefined)
        return true;
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return false;
    return Object.values(value).every((entry) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry))
            return false;
        const upload = entry;
        return (typeof upload.contentHash === 'string' &&
            typeof upload.endpointHash === 'string' &&
            typeof upload.callerIdentityHash === 'string' &&
            typeof upload.ttlSec === 'number' &&
            typeof upload.fileId === 'string' &&
            typeof upload.createdAtMs === 'number' &&
            typeof upload.expiresAtMs === 'number');
    });
}
function isLocalSessionSnapshotWatermark(value, expectedSessionId) {
    if (!value || typeof value !== 'object')
        return false;
    const watermark = value;
    const lastSeq = watermark.lastSeq;
    const byteOffset = watermark.byteOffset;
    return (watermark.sessionId === expectedSessionId &&
        typeof lastSeq === 'number' &&
        Number.isInteger(lastSeq) &&
        lastSeq >= 0 &&
        typeof watermark.lastEventId === 'string' &&
        typeof watermark.updatedAtMs === 'number' &&
        (byteOffset === undefined ||
            (typeof byteOffset === 'number' && Number.isInteger(byteOffset) && byteOffset >= 0)));
}
function isPiHistoryFactEvent(event) {
    return (event.kind === 'message.pi_history_appended' ||
        event.kind === 'message.pi_history_replaced' ||
        event.kind === 'message.state_deleted' ||
        event.kind === 'session.deleted');
}
function sanitizeSnapshotPathSegment(value) {
    return `session_${Buffer.from(value || 'unknown-session', 'utf-8').toString('base64url')}`;
}
function defaultSnapshotId(sessionId, watermark) {
    return `snapshot_${sanitizeSnapshotPathSegment(sessionId)}_${watermark.lastSeq}_${randomUUID().replace(/-/g, '')}`;
}
/**
 * Async rename with retry for transient Windows EPERM / EACCES errors
 * caused by antivirus, search indexer, or concurrent file handle races.
 */
async function renameWithRetry(src, dest, maxRetries = 3) {
    for (let attempt = 0;; attempt++) {
        try {
            await rename(src, dest);
            return;
        }
        catch (err) {
            const code = err.code;
            if ((code === 'EPERM' || code === 'EACCES') && attempt < maxRetries) {
                await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
                continue;
            }
            throw err;
        }
    }
}
//# sourceMappingURL=session-snapshot-store.js.map