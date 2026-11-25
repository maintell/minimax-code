import { getConfig } from '@mavis/config';
import { isLocalChildWorkerSession, } from '../../service/session-system/index.js';
import { WorktreeCleanupRecordStore } from '../../service/workspace/index.js';
import { ownsElectronRuntimeCapabilities } from '../agent/runtime-browser-use-composition.js';
import { ACTIVE_TASK_STATUSES, CONTINUING_GOAL_STATUSES, TERMINAL_TASK_STATUSES, } from './activity-application.js';
import { WorktreeCleanupService } from './worktree-cleanup.js';
/** Child workers never get a delivery Turn, so their undelivered results do not count. */
function listUndeliveredTasks(sources, session) {
    if (isLocalChildWorkerSession(session))
        return undefined;
    return sources.backgroundTasks?.list({
        ownerSessionId: session.sessionId,
        statuses: [...TERMINAL_TASK_STATUSES],
        limit: 1,
        undeliveredOnly: true,
    });
}
/**
 * True while background tasks or their undelivered results, queued messages, a
 * continuing Goal or a Cron wake still use the Session. Child workers never get a
 * delivery Turn, so their undelivered results are skipped as in the activity reader.
 *
 * @internal Exported for tests.
 */
export async function hasWorktreePendingWork(sources, session) {
    const { sessionId } = session;
    if ((sources.cron?.listSessionWakes(sessionId).length ?? 0) > 0)
        return true;
    const [active, undelivered, queue, goal] = await Promise.all([
        sources.backgroundTasks?.list({
            ownerSessionId: sessionId,
            statuses: [...ACTIVE_TASK_STATUSES],
            limit: 1,
        }),
        listUndeliveredTasks(sources, session),
        sources.queue?.snapshot(sessionId),
        sources.goals?.getBySession(sessionId),
    ]);
    return ((active?.items.length ?? 0) > 0 ||
        (undelivered?.items.length ?? 0) > 0 ||
        (queue?.pendingCount ?? 0) > 0 ||
        (goal !== undefined && CONTINUING_GOAL_STATUSES[goal.status] === true));
}
/** Builds the background worktree cleanup owner and subscribes it to committed Session facts. */
function composeWorktreeCleanup(input) {
    if (!input.enabled)
        return undefined;
    const pendingWork = input.pendingWork ?? {};
    const sessions = input.sessionSystem.repositories.sessions;
    const service = new WorktreeCleanupService({
        sessions: {
            list: () => sessions.list({}),
            get: (sessionId) => sessions.get(sessionId),
            setRunLocation: async (sessionId, runLocation, updatedAtMs) => {
                await sessions.update(sessionId, { runLocation, updatedAtMs });
            },
        },
        records: input.records,
        config: () => {
            const config = input.config();
            return { enabled: config.worktreeAutoCleanupEnabled, keepCount: config.worktreeKeepCount };
        },
        isPinned: (sessionId) => input.pinService.isSessionPinned(sessionId),
        hasActiveTurn: (sessionId) => input.turnSystem.inspection?.activeTurnId(sessionId) !== undefined,
        ...(input.pendingWork
            ? { hasPendingWork: (session) => hasWorktreePendingWork(pendingWork, session) }
            : {}),
        nowMs: input.nowMs,
        ...(input.logger ? { logger: input.logger } : {}),
        ...(input.subscribeConfigChanges
            ? { subscribeConfigChanges: input.subscribeConfigChanges }
            : {}),
    });
    input.bindSessionFactObserver((fact) => service.observe(fact));
    return service;
}
/** Enables cleanup only for the local Desktop runtime that recovers persisted state. */
export function composeRuntimeWorktreeCleanup(options, composition, owners) {
    const backgroundTasks = options.prepared?.backgroundTasks?.service;
    const cron = owners.cron?.service;
    return composeWorktreeCleanup({
        enabled: ownsElectronRuntimeCapabilities(options.runtimeOwnerKind) &&
            options.recoverPersistedState !== false,
        records: new WorktreeCleanupRecordStore(options.db),
        sessionSystem: composition.sessionSystem,
        pinService: composition.pinService,
        turnSystem: owners.turnSystem,
        pendingWork: {
            goals: composition.goalPort,
            queue: composition.sessionSystem.queue.committed,
            ...(backgroundTasks ? { backgroundTasks } : {}),
            ...(cron ? { cron } : {}),
        },
        config: getConfig,
        nowMs: options.nowMs ?? Date.now,
        ...(options.logger ? { logger: options.logger } : {}),
        bindSessionFactObserver: composition.facts.bindSessionObserver,
        ...(options.subscribeConfigChanges
            ? { subscribeConfigChanges: options.subscribeConfigChanges }
            : {}),
    });
}
//# sourceMappingURL=worktree-cleanup-composition.js.map