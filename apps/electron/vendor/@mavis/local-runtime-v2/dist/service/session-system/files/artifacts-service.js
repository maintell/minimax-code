import { setImmediate } from 'node:timers/promises';
import { pendingArtifactSessions, queryArtifactCatalog } from './repo/artifact-catalog.js';
import { ArtifactCatalogError } from './library/errors.js';
import { artifactView } from './library/paths.js';
export { ArtifactCatalogError } from './library/errors.js';
function parseLimit(value) {
    if (value === undefined)
        return 50;
    if (Number.isInteger(value) && value >= 1 && value <= 200)
        return value;
    throw new ArtifactCatalogError('Invalid artifact limit');
}
function parseInput(input) {
    // Without a Session filter the scope keeps its earlier shape, so issued cursors stay valid.
    const scope = JSON.stringify(input.sessionId ? [input.spaceId ?? '', input.sessionId] : [input.spaceId ?? '']);
    return {
        spaceId: input.spaceId,
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        scope,
        limit: parseLimit(input.limit),
        before: decodeCursor(input.cursor, scope),
    };
}
export class SessionArtifactsService {
    db;
    files;
    library;
    indexing;
    failedSessions = new Set();
    closed = false;
    constructor(db, files, library) {
        this.db = db;
        this.files = files;
        this.library = library;
    }
    async list(input) {
        if (this.closed)
            throw new ArtifactCatalogError('Artifact catalog is closed');
        const query = parseInput(input);
        if (input.retryIndex && !this.indexing)
            this.failedSessions.clear();
        this.startIndexing();
        const indexing = Boolean(this.indexing);
        const { scope, limit } = query;
        const result = queryArtifactCatalog(this.db, this.library.catalogFacts(), query);
        const hasMore = result.length > limit;
        const rows = result.slice(0, limit);
        const artifacts = await Promise.all(rows.map(artifactView));
        const last = rows.at(-1);
        return {
            artifacts,
            ...this.library.summary(),
            hasMore,
            ...(hasMore && last
                ? {
                    nextCursor: Buffer.from(JSON.stringify({
                        scope,
                        time: last.deliveredAtMs,
                        session: last.sessionId,
                        key: last.assetKey,
                    })).toString('base64url'),
                }
                : {}),
            indexing,
            indexErrorCount: this.failedSessions.size,
        };
    }
    async close() {
        this.closed = true;
        await this.indexing;
    }
    startIndexing() {
        if (this.indexing)
            return;
        const pending = new Set(pendingArtifactSessions(this.db, this.library.catalogVisibility()));
        for (const id of this.failedSessions) {
            if (!pending.has(id))
                this.failedSessions.delete(id);
        }
        const ids = [...pending].filter((id) => !this.failedSessions.has(id));
        if (ids.length === 0)
            return;
        this.indexing = this.indexSessions(ids);
    }
    async indexSessions(ids) {
        try {
            for (const id of ids) {
                await setImmediate();
                if (this.closed)
                    return;
                try {
                    await this.files.ensureSessionFilesReady(id);
                }
                catch {
                    this.failedSessions.add(id);
                }
            }
        }
        finally {
            this.indexing = undefined;
        }
    }
}
function decodeCursor(cursor, scope) {
    if (!cursor)
        return undefined;
    try {
        const value = JSON.parse(Buffer.from(cursor, 'base64url').toString());
        if (isArtifactCursor(value, scope))
            return { time: value.time, session: value.session, key: value.key };
    }
    catch {
        /* Invalid cursors never restart pagination silently. */
    }
    throw new ArtifactCatalogError('Invalid artifact cursor');
}
function isArtifactCursor(value, scope) {
    if (!value || typeof value !== 'object')
        return false;
    const row = value;
    return (row.scope === scope &&
        Number.isSafeInteger(row.time) &&
        typeof row.session === 'string' &&
        typeof row.key === 'string' &&
        row.key.length > 0);
}
//# sourceMappingURL=artifacts-service.js.map