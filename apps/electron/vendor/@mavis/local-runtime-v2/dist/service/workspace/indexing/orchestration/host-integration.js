import { isSensitiveSearchRoot } from '@mavis/agent-tools/desktop';
import { logger } from '../../../../infra/logging/logger.js';
import { emitWorkspaceIndexingObservation, resolveWorkspaceIndexingObservationSink, WorkspaceIndexingMetrics, } from '../scan/metrics.js';
import { isWorkspaceIndexingSessionEligible } from '../scan/preference.js';
import { LocalWorkspaceIndexingRemoteClient } from '../capture/remote-client.js';
import { WorkspaceIndexingRemoteWorker, } from '../revision/remote-worker.js';
import { WorkspaceSemanticSearchService } from './semantic-search.js';
import { detachWorkspacePreparation } from './service-helpers.js';
import { WorkspaceSemanticIndexStore } from '../../../../infra/legacy-db/workspace-indexing-semantic-index-store.js';
import { WorkspaceIndexingService, } from './service.js';
import { SqliteWorkspaceIndexingStore, } from '../../../../infra/legacy-db/workspace-indexing-store.js';
export function createWorkspaceIndexingHostSubsystem(options) {
    const metrics = new WorkspaceIndexingMetrics(options.metricsClient);
    const store = options.workspaceIndexingStore ?? new SqliteWorkspaceIndexingStore(options.dataDir);
    const semanticIndexStore = options.workspaceSemanticIndexStore ??
        new WorkspaceSemanticIndexStore({ dataDir: options.dataDir, nowMs: options.nowMs });
    const remoteClient = options.workspaceIndexingRemoteClient ??
        new LocalWorkspaceIndexingRemoteClient({
            authContextGetter: options.authContextGetter,
            routingContextGetter: options.routingContextGetter,
            fetchImpl: options.fetchImpl,
        });
    const remoteWorker = options.workspaceIndexingRemoteWorker ??
        new WorkspaceIndexingRemoteWorker({
            store,
            remote: remoteClient,
            semanticIndexStore,
            isEnabled: options.isEnabled,
            nowMs: options.nowMs,
            getCollectionPolicy: options.getCollectionPolicy,
            metrics,
            createObservationSink: options.createWorkspaceIndexingObservationSink,
            onError: (event) => logger.warn(event, 'Workspace indexing remote work failed and will retry'),
        });
    const semanticSearchService = options.workspaceSemanticSearchService ??
        new WorkspaceSemanticSearchService({
            store,
            semanticIndexStore,
            remote: remoteClient,
            isEnabled: options.isEnabled,
            nowMs: options.nowMs,
            getCollectionPolicy: options.getCollectionPolicy,
            metrics,
            createObservationSink: options.createWorkspaceIndexingObservationSink,
        });
    const service = options.workspaceIndexingService ??
        new WorkspaceIndexingService({
            dataDir: options.dataDir,
            store,
            isEnabled: options.isEnabled,
            scanOptions: {
                getCollectionPolicy: options.getCollectionPolicy,
                onWarning: (event) => logger.warn({ code: event.code, message: event.message }, 'Workspace indexing scan degraded'),
            },
            semanticIndexStore,
            metrics,
            createObservationSink: options.createWorkspaceIndexingObservationSink,
            enqueueRemote: (revisionId) => remoteWorker.enqueue(revisionId),
            cancelRemote: (sessionId) => remoteWorker.cancelSession(sessionId),
            resumeRemote: (sessionId) => remoteWorker.resumeSession(sessionId),
            onWeakDependencyError: (event) => logger.warn(event, 'Workspace indexing weak dependency failed'),
        });
    return { store, service, remoteClient, remoteWorker, semanticIndexStore, semanticSearchService };
}
function workspaceIndexingErrorCode(error, fallback) {
    if (error &&
        typeof error === 'object' &&
        typeof error.code === 'string') {
        return error.code;
    }
    return error instanceof Error && error.name ? error.name : fallback;
}
export async function hostPrepareWorkspaceIndexingForSessionStart(host, sessionId) {
    // One Session start is one logical preparation, so its eligibility verdict
    // and the preparation outcome that follows share a single sink.
    const sink = resolveWorkspaceIndexingObservationSink(host.createWorkspaceIndexingObservationSink);
    try {
        return await host.workspaceIndexingService.prepareSessionStartForSession(sessionId, async () => {
            const current = await host.getSessionById(sessionId);
            // Eligibility is decided here, so it is observed here — one signal per
            // Session start, carrying no identifier or path.
            const eligible = Boolean(current && isWorkspaceIndexingSessionEligible(current));
            emitWorkspaceIndexingObservation(sink, {
                stage: 'eligibility',
                outcome: eligible ? 'eligible' : 'ineligible',
                timestampMs: Date.now(),
            });
            if (!current)
                return { status: 'no_session' };
            if (!eligible)
                return { status: 'no_workspace' };
            return { sessionId, workspaceDir: current.workspaceDir };
        });
    }
    catch (error) {
        const code = workspaceIndexingErrorCode(error, 'workspace_initial_snapshot_failed');
        const cause = error instanceof Error ? error.cause : undefined;
        logger.warn({
            sessionId,
            code,
            ...(cause === undefined ? {} : { causeCode: workspaceIndexingErrorCode(cause, code) }),
        }, 'Workspace Initial Snapshot failed without blocking the Agent');
        return { status: 'degraded', code };
    }
}
/** Starts Workspace preparation without delaying the renderer selection path. */
export function hostPrewarmWorkspaceIndexingForWorkspace(host, workspaceDir) {
    queueMicrotask(() => {
        detachWorkspacePreparation(prewarmWorkspaceIndexing(host, workspaceDir));
    });
}
async function prewarmWorkspaceIndexing(host, workspaceDir) {
    try {
        await host.workspaceIndexingService.prewarmWorkspace(workspaceDir);
    }
    catch (error) {
        logger.warn({
            code: workspaceIndexingErrorCode(error, 'workspace_selection_prewarm_failed'),
        }, 'Workspace Initial Snapshot prewarm failed; the Agent start gate will retry');
    }
}
export async function hostCaptureWorkspaceRevisionAfterTurn(host, sessionId) {
    try {
        const session = await host.getSessionById(sessionId);
        if (!session || !isWorkspaceIndexingSessionEligible(session))
            return;
        await host.workspaceIndexingService.captureRevisionIfChanged({
            sessionId,
            workspaceDir: session.workspaceDir,
        });
    }
    catch (error) {
        logWorkspaceRevisionFailure(sessionId, error);
    }
}
/**
 * Writes the Session's Workspace snapshot for a feedback upload into a
 * caller-owned directory. Eligibility matches indexing (a user-selected,
 * non-default Workspace); the indexing preference is not consulted because the
 * caller already decided a snapshot may be taken. Failures propagate.
 *
 * Secret-path rules only see Workspace-relative paths, so a secret tree chosen
 * as the root itself (~/.aws, ~/.kube, also via symlink) would ship its
 * credentials; such a Workspace is skipped without scanning.
 */
export async function hostCaptureWorkspaceFeedbackSnapshot(host, sessionId, outputDir) {
    const session = await host.getSessionById(sessionId);
    if (!session)
        return { status: 'no_session' };
    if (!isWorkspaceIndexingSessionEligible(session))
        return { status: 'no_workspace' };
    if (await isSensitiveSearchRoot(session.workspaceDir))
        return { status: 'sensitive_workspace' };
    return host.workspaceIndexingService.captureFeedbackSnapshot({
        sessionId,
        workspaceDir: session.workspaceDir,
        outputDir,
    });
}
export function hostLogWorkspaceSemanticSearchUnavailable(sessionId, error) {
    logger.warn({
        sessionId,
        code: workspaceIndexingErrorCode(error, 'workspace_semantic_search_unavailable'),
    }, 'Workspace semantic search is unavailable for this turn');
}
function logWorkspaceRevisionFailure(sessionId, error) {
    logger.warn({ sessionId, code: workspaceIndexingErrorCode(error, 'workspace_revision_capture_failed') }, 'Workspace revision capture failed without blocking the Agent');
}
//# sourceMappingURL=host-integration.js.map