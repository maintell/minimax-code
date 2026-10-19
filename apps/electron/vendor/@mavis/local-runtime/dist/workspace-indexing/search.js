import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { isDefaultScanNoisePath, isSensitiveSearchPath, } from '@mavis/agent-tools/desktop';
import { resolveWorkspaceCollectionPolicy, } from './collection-policy.js';
import { emitWorkspaceIndexingObservation, resolveWorkspaceIndexingObservationSink, WorkspaceIndexingMetrics, } from './metrics.js';
export class WorkspaceSemanticSearchService {
    store;
    semanticIndexStore;
    remote;
    isEnabled;
    getCollectionPolicy;
    metrics;
    createObservationSink;
    nowMs;
    constructor(options) {
        this.store = options.store;
        this.semanticIndexStore = options.semanticIndexStore;
        this.remote = options.remote;
        this.isEnabled = options.isEnabled;
        this.getCollectionPolicy = options.getCollectionPolicy;
        this.metrics = options.metrics ?? new WorkspaceIndexingMetrics();
        this.createObservationSink = options.createObservationSink;
        this.nowMs = options.nowMs ?? Date.now;
    }
    /**
     * Reports why semantic search is or is not available for this Session. The
     * observation fires at most once per adapter build (one per Turn), never
     * per search call, so the business layer sees availability rather than
     * traffic.
     */
    reportAvailability(sink, outcome) {
        this.metrics.result({ stage: 'search', outcome });
        emitWorkspaceIndexingObservation(sink, {
            stage: 'search',
            outcome,
            timestampMs: this.nowMs(),
        });
        return undefined;
    }
    async createAdapter(input) {
        // Fixed before the first lookup: this Turn's availability verdict belongs
        // to the owner the adapter is being built for.
        const sink = resolveWorkspaceIndexingObservationSink(this.createObservationSink);
        if (!(await this.isEnabled()))
            return this.reportAvailability(sink, 'disabled');
        const session = await this.store.getSession(input.sessionId);
        if (!session ||
            session.status !== 'ready' ||
            !session.latestRevisionId ||
            !session.latestRootHash) {
            return this.reportAvailability(sink, 'unavailable');
        }
        const currentWorkspacePath = await realpath(input.workspaceDir).catch(() => undefined);
        const boundWorkspacePath = await realpath(session.workspaceRealPath).catch(() => session.workspaceRealPath);
        if (!currentWorkspacePath ||
            path.resolve(currentWorkspacePath) !== path.resolve(boundWorkspacePath)) {
            return this.reportAvailability(sink, 'unavailable');
        }
        const revision = await this.store.getRevision(session.latestRevisionId);
        if (!revision ||
            revision.remoteState !== 'ready' ||
            revision.rootHash !== session.latestRootHash ||
            !revision.embeddingModel ||
            !revision.dimensions ||
            revision.normalization !== 'l2' ||
            !revision.indexSha256 ||
            !revision.indexSizeBytes) {
            return this.reportAvailability(sink, 'unavailable');
        }
        const index = await this.semanticIndexStore.loadRevisionCompatible({
            workspaceId: session.workspaceId,
            revisionId: revision.revisionId,
            rootHash: revision.rootHash,
            archiveSha256: revision.indexSha256,
            archiveSizeBytes: revision.indexSizeBytes,
            embeddingModel: revision.embeddingModel,
            dimensions: revision.dimensions,
            normalization: revision.normalization,
        });
        if (!index)
            return this.reportAvailability(sink, 'unavailable');
        const embeddingModel = revision.embeddingModel;
        const dimensions = revision.dimensions;
        const normalization = revision.normalization;
        this.reportAvailability(sink, 'success');
        return {
            search: async (ctx, toolInput, signal) => {
                const startedMs = this.nowMs();
                try {
                    if (ctx.sessionId !== input.sessionId) {
                        throw workspaceSearchError('workspace_semantic_search_session_mismatch');
                    }
                    if (!(await this.isEnabled().catch(() => false))) {
                        throw workspaceSearchError('workspace_semantic_search_disabled');
                    }
                    signal?.throwIfAborted();
                    const query = toolInput.query.trim();
                    if (!query)
                        throw workspaceSearchError('workspace_semantic_search_query_required');
                    if (!(await this.isEnabled().catch(() => false))) {
                        throw workspaceSearchError('workspace_semantic_search_disabled');
                    }
                    const vector = await this.remote.embedQuery({
                        workspaceId: session.workspaceId,
                        revisionId: revision.revisionId,
                        query,
                        embeddingModel,
                        dimensions,
                        normalization,
                        ...(signal ? { signal } : {}),
                    });
                    signal?.throwIfAborted();
                    if (vector.length !== index.dimensions ||
                        vector.some((value) => !Number.isFinite(value))) {
                        throw workspaceSearchError('workspace_semantic_search_query_vector_invalid');
                    }
                    // The installed index predates the live policy whenever a policy
                    // update lands after indexing, so newly excluded paths are dropped
                    // here rather than resurfacing in results.
                    const policy = resolveWorkspaceCollectionPolicy(this.getCollectionPolicy);
                    const results = rankChunks(index.chunks, vector, toolInput, policy.excludesWorkspacePath);
                    this.metrics.attempt({
                        stage: 'search',
                        outcome: results.length === 0 ? 'empty' : 'success',
                        durationMs: this.nowMs() - startedMs,
                    });
                    return { revisionId: revision.revisionId, results };
                }
                catch (error) {
                    this.metrics.attempt({
                        stage: 'search',
                        outcome: signal?.aborted ? 'cancelled' : 'failed',
                        durationMs: this.nowMs() - startedMs,
                    });
                    throw error;
                }
            },
        };
    }
}
function rankChunks(chunks, queryVector, input, excludesPath) {
    const topK = Math.min(20, Math.max(1, Math.floor(input.top_k ?? 8)));
    const pathPrefix = normalizePathPrefix(input.path_prefix);
    return chunks
        .filter((chunk) => isAllowedChunkPath(chunk.path, pathPrefix) && !excludesPath(chunk.path))
        .map((chunk) => ({
        path: chunk.path,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        score: cosineSimilarity(queryVector, chunk.vector),
        snippet: chunk.snippet,
    }))
        .filter((match) => Number.isFinite(match.score))
        .sort((left, right) => right.score - left.score ||
        left.path.localeCompare(right.path) ||
        left.startLine - right.startLine)
        .slice(0, topK);
}
function normalizePathPrefix(value) {
    if (value === undefined)
        return undefined;
    const normalized = path.posix.normalize(value.replaceAll('\\', '/').replace(/^\.\//u, ''));
    if (!normalized ||
        normalized === '.' ||
        path.posix.isAbsolute(normalized) ||
        normalized === '..' ||
        normalized.startsWith('../')) {
        throw workspaceSearchError('workspace_semantic_search_path_prefix_invalid');
    }
    return normalized.replace(/\/$/u, '');
}
function isAllowedChunkPath(chunkPath, prefix) {
    if (isSensitiveSearchPath(chunkPath) ||
        isDefaultScanNoisePath(chunkPath) ||
        path.posix.isAbsolute(chunkPath) ||
        chunkPath.includes('\\') ||
        path.posix.normalize(chunkPath) !== chunkPath) {
        return false;
    }
    return !prefix || chunkPath === prefix || chunkPath.startsWith(`${prefix}/`);
}
function cosineSimilarity(left, right) {
    if (left.length !== right.length || left.length === 0)
        return Number.NaN;
    let dot = 0;
    let leftNorm = 0;
    let rightNorm = 0;
    for (let index = 0; index < left.length; index += 1) {
        const l = left[index];
        const r = right[index];
        if (l === undefined || r === undefined)
            return Number.NaN;
        dot += l * r;
        leftNorm += l * l;
        rightNorm += r * r;
    }
    if (leftNorm === 0 || rightNorm === 0)
        return Number.NaN;
    return dot / Math.sqrt(leftNorm * rightNorm);
}
function workspaceSearchError(code) {
    return Object.assign(new Error(code), { code });
}
//# sourceMappingURL=search.js.map