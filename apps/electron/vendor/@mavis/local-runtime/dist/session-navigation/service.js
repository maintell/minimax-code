import { SqliteSessionAssetStore } from '../session-assets/session-asset-store.js';
import { toSessionAssetDriveNode } from '../session-assets/session-files-service.js';
import { SqliteSessionInputSummaryStore, } from './store.js';
export const DEFAULT_SESSION_INPUT_SUMMARY_LIMIT = 100;
export const MAX_SESSION_INPUT_SUMMARY_LIMIT = 100;
export class SessionInputSummaryValidationError extends Error {
    constructor(message) {
        super(message);
        this.name = 'SessionInputSummaryValidationError';
    }
}
export class SessionInputSummaryNotFoundError extends Error {
    sessionId;
    constructor(sessionId) {
        super(`Session not found: ${sessionId}`);
        this.sessionId = sessionId;
        this.name = 'SessionInputSummaryNotFoundError';
    }
}
export class LocalSessionInputSummaryService {
    deps;
    assetStore;
    summaryReader;
    nowMs;
    constructor(deps) {
        this.deps = deps;
        this.assetStore = deps.sessionAssetStore ?? new SqliteSessionAssetStore(deps.dataDir);
        this.summaryReader = deps.summaryReader ?? new SqliteSessionInputSummaryStore(deps.dataDir);
        this.nowMs = deps.nowMs ?? Date.now;
    }
    async list(sessionId, options = {}) {
        const startedAt = this.nowMs();
        let status = 'error';
        try {
            const pagination = normalizePagination(options);
            const beforeRowId = pagination.before
                ? decodeCursor(sessionId, pagination.before)
                : undefined;
            await this.deps.ensureLegacyMessagesMigrated(sessionId);
            await this.assetStore.ensureIndexed(sessionId);
            const page = await this.summaryReader.list(sessionId, {
                limit: pagination.limit,
                ...(beforeRowId !== undefined ? { beforeRowId } : {}),
            });
            if (!page)
                throw new SessionInputSummaryNotFoundError(sessionId);
            this.deps.metricsClient?.counter('session_input_navigation_request_total', 1, {
                status: 'ok',
            });
            this.deps.metricsClient?.histogram('session_input_navigation_scanned_rows', page.scannedRows);
            this.deps.metricsClient?.histogram('session_input_navigation_data_json_bytes', page.dataJsonBytes);
            status = 'ok';
            return {
                summaries: page.summaries.map((summary) => this.mapSummary(sessionId, summary)),
                total: page.total,
                hasMore: page.hasMore,
                ...(page.nextBeforeRowId !== undefined
                    ? { nextCursor: encodeCursor(sessionId, page.nextBeforeRowId) }
                    : {}),
            };
        }
        catch (error) {
            this.deps.metricsClient?.counter('session_input_navigation_request_total', 1, {
                status: 'error',
            });
            throw error;
        }
        finally {
            this.deps.metricsClient?.histogram('session_input_navigation_duration_ms', this.nowMs() - startedAt, { status });
        }
    }
    mapSummary(sessionId, summary) {
        const artifacts = summary.artifacts.map((artifact) => toSessionAssetDriveNode({
            sessionId,
            path: artifact.path,
            name: artifact.name,
            assetType: artifact.assetType,
            driveNodeId: artifact.driveNodeId,
            createdAtMs: artifact.messageCreatedAtMs,
        }));
        return {
            userInput: toMessageHeadView(summary.userInput),
            ...(summary.assistantResponse
                ? { assistantResponse: toMessageHeadView(summary.assistantResponse) }
                : {}),
            ...(artifacts.length > 0 ? { artifacts } : {}),
            fileChangeCount: summary.fileChangeCount,
        };
    }
}
function normalizePagination(options) {
    const requestedLimit = options.limit ?? DEFAULT_SESSION_INPUT_SUMMARY_LIMIT;
    const normalizedLimit = Math.floor(requestedLimit);
    if (!Number.isFinite(requestedLimit) || normalizedLimit <= 0) {
        throw new SessionInputSummaryValidationError('limit must be greater than 0');
    }
    if (options.before !== undefined && options.before.length === 0) {
        throw new SessionInputSummaryValidationError('before cursor must not be empty');
    }
    return {
        limit: Math.min(normalizedLimit, MAX_SESSION_INPUT_SUMMARY_LIMIT),
        ...(options.before !== undefined ? { before: options.before } : {}),
    };
}
function toMessageHeadView(head) {
    return {
        msgId: head.msgId,
        timestamp: head.timestamp,
        ...(head.contentHead ? { contentHead: head.contentHead } : {}),
    };
}
function encodeCursor(sessionId, beforeRowId) {
    return Buffer.from(JSON.stringify({ version: 1, sessionId, beforeRowId }), 'utf8').toString('base64url');
}
function decodeCursor(sessionId, cursor) {
    try {
        const payload = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
        if (payload === null ||
            typeof payload !== 'object' ||
            !('version' in payload) ||
            !('sessionId' in payload) ||
            !('beforeRowId' in payload) ||
            payload.version !== 1 ||
            payload.sessionId !== sessionId ||
            !Number.isSafeInteger(payload.beforeRowId) ||
            typeof payload.beforeRowId !== 'number' ||
            payload.beforeRowId <= 0) {
            throw new Error('invalid payload');
        }
        return payload.beforeRowId;
    }
    catch {
        throw new SessionInputSummaryValidationError('invalid before cursor');
    }
}
let currentSessionInputSummaryService;
export function initSessionInputSummaryService(deps) {
    currentSessionInputSummaryService = new LocalSessionInputSummaryService(deps);
    return currentSessionInputSummaryService;
}
export function getSessionInputSummaryService() {
    if (!currentSessionInputSummaryService) {
        throw new Error('Local session-input-summary service is not initialized');
    }
    return currentSessionInputSummaryService;
}
//# sourceMappingURL=service.js.map