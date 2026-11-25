import { settleInBackground } from '../../infra/async/settle.js';
import { createCliExec } from './code-host/cli-runner.js';
import { CodeHostGateway } from './code-host/gateway.js';
import { SessionMergeRequestLinkStore } from './link-store.js';
import { LocalBranches } from './local-git/branch-info.js';
import { WorktreeCleanup } from './local-git/worktree-cleanup.js';
import { MergeRequestActionsService } from './merge-request-actions.service.js';
import { MergeRequestService } from './merge-request.service.js';
import { readWorkspaceRemote } from './workspace-repo.js';
/**
 * The panel's read service and the actions on it. Both go through one gateway,
 * so they share each host's queue and hourly budget.
 */
export function initializeMergeRequestOwner(options) {
    const gateway = createGateway(options);
    const links = new SessionMergeRequestLinkStore(options.db);
    const service = createService(options, gateway, links);
    const actions = new MergeRequestActionsService({
        reads: service,
        gateway,
        links,
        worktrees: new WorktreeCleanup({
            git: options.runGit,
            sessionsWithin: options.sessionsWithin,
            nowMs: options.nowMs,
        }),
        branches: new LocalBranches(options.runGit),
        preferences: options.preferences,
        onBackgroundError: options.onBackgroundError,
    });
    return { service, actions };
}
/**
 * The read service alone, for the tests that drive it through a fake CLI.
 * @internal Production composes initializeMergeRequestOwner.
 */
export function initializeMergeRequestService(options) {
    return createService(options, createGateway(options), new SessionMergeRequestLinkStore(options.db));
}
function createGateway(options) {
    return new CodeHostGateway({
        exec: options.exec ?? createCliExec(),
        nowMs: options.nowMs,
        limits: options.limits,
        ...(options.metrics ? { metrics: options.metrics } : {}),
    });
}
function createService(options, gateway, links) {
    return new MergeRequestService({
        nowMs: options.nowMs,
        gateway,
        links,
        getSession: options.getSession,
        readWorkspace: (workspaceDir) => readWorkspaceRemote(workspaceDir, options.runGit),
        limits: options.limits,
        publish: options.publish,
        ...(options.cache ? { cache: options.cache } : {}),
        ...(options.metrics ? { metrics: options.metrics } : {}),
    });
}
/**
 * Reads the current branch's merge request when a Turn ends, for the TUI status
 * line and the panel, and forgets deleted Sessions. A Turn end links nothing:
 * the branch a directory is on is not the Session's own, since several Sessions
 * may share it.
 */
export function bindMergeRequestEvents(service, events, onError) {
    return events.subscribe({
        next: (event) => {
            if (event.type === 'session.finish') {
                settleInBackground(readTurnEnd(service, event.payload.sessionId, onError));
            }
            else if (event.type === 'session.deleted') {
                service.forgetSession(event.payload.sessionId);
            }
        },
    });
}
async function readTurnEnd(service, sessionId, onError) {
    try {
        await service.readCurrentBranch(sessionId);
    }
    catch (error) {
        onError(error, sessionId);
    }
}
//# sourceMappingURL=initialize.js.map