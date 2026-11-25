import { join } from 'node:path';
import { MERGE_REQUESTS_DEFAULTS, currentBetaResolutionContext, resolveBetaFeature, } from '@mavis/config';
import { bindMergeRequestEvents, fileMergeRequestCache, initializeMergeRequestOwner, } from '../../service/merge-request/index.js';
import { git as runWorkspaceGit } from '../../service/workspace/index.js';
import { resolvePluginServiceLogger } from './plugin-service-logger.js';
/** More Sessions than anyone keeps in one worktree; the cleanup check only counts them. */
const SESSIONS_IN_DIRECTORY_LIMIT = 200;
/**
 * The merge request panel exists only while the reviewStatus beta flag is on;
 * without it the routes stay unmounted and no glab / gh process ever starts.
 */
export function composeMergeRequestServices(input) {
    const { options, productionSessionComposition: composition } = input;
    const readConfig = () => composition.product.preparation.configBuilder.config();
    const betaContext = currentBetaResolutionContext();
    if (!resolveBetaFeature('reviewStatus', readConfig().beta?.reviewStatus, betaContext)) {
        return {};
    }
    const logger = resolvePluginServiceLogger(options.logger);
    const sessions = composition.sessionSystem.sessions.repository;
    const settings = () => readConfig().mergeRequests ?? MERGE_REQUESTS_DEFAULTS;
    const { service, actions } = initializeMergeRequestOwner({
        db: options.db,
        nowMs: input.nowMs,
        ...(options.metrics ? { metrics: options.metrics } : {}),
        cache: fileMergeRequestCache(join(options.dataDir, 'cache', 'merge-requests.json')),
        runGit: (args, cwd, gitOptions) => runWorkspaceGit(args, cwd, gitOptions),
        limits: settings,
        preferences: () => {
            const { createAsDraft, githubMergeMethod } = settings();
            return { createAsDraft, githubMergeMethod };
        },
        getSession: async (sessionId) => {
            const record = await sessions.get(sessionId);
            if (!record)
                return undefined;
            return {
                workspaceDir: record.workspaceDir,
                updatedAtMs: record.updatedAtMs,
                ...(record.parentSessionId ? { parentSessionId: record.parentSessionId } : {}),
            };
        },
        sessionsWithin: cleanupSessionsWithin(sessions),
        publish: (sessionId, reason) => {
            try {
                input.writeGlobalEvent({ type: 'merge_request.updated', payload: { sessionId, reason } });
            }
            catch (error) {
                logger.warn({ error, sessionId }, 'Merge request update event was not published');
            }
        },
        onBackgroundError: (error, ref) => logger.warn({ error, ref }, 'Reading a merge request again after a change failed'),
    });
    bindMergeRequestEvents(service, options.eventBus, (error, sessionId) => logger.warn({ error, sessionId }, 'Reading the branch merge request at Turn end failed'));
    options.compatibility.mergeRequests.bind(service);
    return { mergeRequest: service, mergeRequestActions: actions };
}
/**
 * The Sessions the worktree cleanup check counts: every non-archived one
 * working in a worktree root or in any directory inside it.
 * @internal Exported only for focused tests.
 */
export function cleanupSessionsWithin(sessions) {
    return async (roots) => (await sessions.list({
        workspaceRoots: roots,
        archived: false,
        limit: SESSIONS_IN_DIRECTORY_LIMIT,
    })).map((record) => ({
        sessionId: record.sessionId,
        ...(record.parentSessionId ? { parentSessionId: record.parentSessionId } : {}),
        ...(record.sideChatOrigin ? { sideChatOf: record.sideChatOrigin.mainSessionId } : {}),
        running: record.status === 'started',
    }));
}
//# sourceMappingURL=merge-request-composition.js.map