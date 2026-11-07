import { SessionActivityKind, SessionActivityState, } from '@mavis/thrift-gen/generated/desktop-service/types';
import { isSelfReminderId } from '@mavis/shared/cron-purpose';
import { AppError } from '../errors.js';
import { isLocalChildWorkerSession } from '../../service/session-system/index.js';
/**
 * Upper bound on sessions inspected per request; a larger tree is reported as truncated.
 * Finished subagent and verifier sessions stay in the tree for good, so the bound covers a
 * session's whole history, not just its live work. Each session costs several reads per
 * poll (including a Queue write transaction) and automation clients poll once a second,
 * so the bound also caps the per-poll load one status query puts on the runtime.
 */
const SESSION_ACTIVITY_MAX_SESSIONS = 64;
const ACTIVE_TASK_STATUSES = [
    'queued',
    'running',
    'stopping',
];
const TERMINAL_TASK_STATUSES = [
    'succeeded',
    'failed',
    'canceled',
    'lost',
];
/** The process-local task list caps a page at 100 rows. */
const TASK_PAGE_LIMIT = 100;
/**
 * `refId` of the stand-in TaskNotification item reported when a session's undelivered
 * terminal Tasks fill a whole page: the rows beyond it were not read, so a pending
 * notification among them cannot be ruled out.
 */
const TASK_PAGE_FULL_REF = 'page_full';
/**
 * Thread Goal states that still schedule continuation Turns. `budget_limited` is terminal:
 * the budget wraps up inside the Goal Turn that hit it and no summary Turn follows.
 */
const CONTINUING_GOAL_STATUSES = { active: true };
/** Composes the activity reader from ready runtime owners; empty keeps the route fail-closed. */
export function sessionActivityFor(input) {
    const turns = input.owners.turnSystem.inspection;
    if (!turns)
        return {};
    const sessions = input.sessionSystem.sessions.repository;
    const { backgroundTasks, questionnaires, permissions } = input.application;
    const cron = input.owners.cron?.service;
    return {
        sessionActivity: new SessionActivityApplication({
            sessions,
            turns,
            queue: input.sessionSystem.queue.committed,
            ...(backgroundTasks ? { backgroundTasks } : {}),
            ...(questionnaires ? { questionnaires } : {}),
            ...(permissions ? { permissions } : {}),
            goals: input.goalPort,
            ...(cron ? { cron } : {}),
            nowMs: input.nowMs,
        }),
    };
}
/**
 * Answers "can this session tree still advance without new user input?".
 *
 * Covers every producer that admits a Turn after the user's own Turn ends: the active or
 * admitting Turn, auto-draining Queue items, background Tasks and their pending owner
 * notifications (Task completion steers a delivery Turn into the owner), Thread Goal
 * continuations and admitted Cron Runs. It walks descendant sessions because subagent and
 * verifier children run their own Turns. Team plans are not read: the desktop toolset has
 * no `team` tool, so no desktop session is ever owned by one, and `SessionActivityKind.TeamPlan`
 * stays an IDL value this reader never emits.
 *
 * 评测自动化（Vela/Ludus）的会话收尾判定，不是通用的"会话在干什么"接口；
 * 新增使用方要先评估 kind 覆盖、子孙遍历上限、非事务快照这三点。
 *
 * Scoped to evaluation automation (Vela/Ludus) that needs to know a session is truly
 * finished — this is not a general "what is the session doing" API. New use cases
 * building on it should re-review the semantics first: kind coverage, the descendant
 * traversal bound, and the non-transactional read.
 */
export class SessionActivityApplication {
    options;
    nowMs;
    constructor(options) {
        this.options = options;
        this.nowMs = options.nowMs ?? Date.now;
    }
    async getSessionActivity(_ctx, req) {
        const rootId = req.id.trim();
        if (!rootId)
            throw new AppError(400, 'INVALID_SESSION_ID', 'Session id is required.');
        const root = await this.options.sessions.get(rootId);
        if (!root)
            throw new AppError(404, 'SESSION_NOT_FOUND', `Session not found: ${rootId}`);
        const checkedAtMs = this.nowMs();
        const pendingPermissions = (await this.options.permissions?.listPending()) ?? [];
        let { sessions, marks, truncated } = await this.collectTree(root);
        let inspected = await Promise.all(sessions.map((session) => this.inspectSession(session, marks, pendingPermissions)));
        // A Turn that started or ended between the producer reads and the Turn read may have
        // started background work (or a child session) those reads missed. Re-walk once from
        // fresh producer facts so the work shows up instead of the tree reading as Idle.
        if (inspected.some((result) => result.turnChangedDuringRead)) {
            ({ sessions, marks, truncated } = await this.collectTree(root));
            inspected = await Promise.all(sessions.map((session) => this.inspectSession(session, marks, pendingPermissions)));
        }
        const items = inspected.flatMap((result) => result.items);
        // A full Task page cannot prove the rest of the session's Tasks are quiet; say so in
        // `truncated`, like a tree that outgrew the session bound. (taskItems already reports the
        // unread remainder as a running TaskNotification, so `state` is not Idle either.)
        truncated ||= inspected.some((result) => result.tasksTruncated);
        const childSessionOfTask = new Map(inspected.flatMap((result) => [...result.childSessionOfTask]));
        // Turns still changing on the re-walk: the session is doing work right now and this
        // snapshot cannot prove anything about what it left behind. Say Running and let the
        // next poll decide rather than publish an Idle the reads did not see.
        const unstable = inspected.some((result) => result.turnChangedDuringRead);
        const state = unstable
            ? SessionActivityState.Running
            : activityState(items, childSessionOfTask);
        return {
            state,
            items,
            sessionCount: sessions.length,
            truncated,
            checkedAtMs,
        };
    }
    /**
     * BFS over the session tree. Each session's Turn mark is taken before its children are
     * listed, so a Turn that creates a child and ends while this walk runs changes the mark
     * and the caller walks again; a child created in that gap is not silently missed.
     */
    async collectTree(root) {
        const seen = new Set([root.sessionId]);
        const order = [root];
        const marks = new Map();
        for (const parent of order) {
            marks.set(parent.sessionId, await this.turnMark(parent.sessionId));
            const children = await this.options.sessions.listChildren(parent.sessionId);
            for (const child of children) {
                if (seen.has(child.sessionId))
                    continue;
                if (order.length >= SESSION_ACTIVITY_MAX_SESSIONS) {
                    return { sessions: order, marks, truncated: true };
                }
                seen.add(child.sessionId);
                order.push(child);
            }
        }
        return { sessions: order, marks, truncated: false };
    }
    async inspectSession(session, marks, pendingPermissions) {
        const { sessionId } = session;
        const before = marks.get(sessionId) ?? (await this.turnMark(sessionId));
        // Read what can admit a Turn before the Turn itself: a hand-off (Task delivery, Queue
        // drain, Cron delivery) that lands between the reads then shows up as the new Turn
        // instead of vanishing from both sides.
        const cronWakes = this.options.cron?.listSessionWakes(sessionId) ?? [];
        const [queue, tasks, notifications, goal, questionnaire] = await Promise.all([
            this.options.queue.snapshot(sessionId),
            this.listTasks(sessionId, ACTIVE_TASK_STATUSES, false),
            // Child workers (subagent, verifier) never get a delivery Turn (the
            // scheduler skips them); their finished Tasks are read through task_output by a
            // running child Turn, if at all.
            isLocalChildWorkerSession(session)
                ? []
                : this.listTasks(sessionId, TERMINAL_TASK_STATUSES, true),
            this.options.goals?.getBySession(sessionId),
            this.options.questionnaires?.getPending({ agentName: session.agentName, sessionId }),
        ]);
        const turn = await this.options.turns.activeTurn(sessionId);
        const after = await this.turnMark(sessionId);
        // Any Turn that started or ended inside the window may have done work the producer
        // reads missed; the caller re-walks once from fresh facts.
        const turnChangedDuringRead = before !== after;
        const items = sessionItems(sessionId, {
            turn,
            queue,
            tasks,
            notifications,
            goal,
            cronWakes,
            questionnaire,
            permissions: pendingPermissions.filter((request) => request.sessionId === sessionId),
        });
        return {
            items,
            turnChangedDuringRead,
            childSessionOfTask: childSessionsOf(tasks),
            tasksTruncated: tasks.length >= TASK_PAGE_LIMIT || notifications.length >= TASK_PAGE_LIMIT,
        };
    }
    /**
     * A string identifying the session's Turn state: latest accepted Turn plus whether it is
     * done, or (when the inspection cannot say) the active Turn alone.
     */
    async turnMark(sessionId) {
        const latest = await this.options.turns.latestTurnActivity?.(sessionId);
        if (latest)
            return `${latest.turnId}:${latest.completedAtMs ?? 'running'}`;
        const active = await this.options.turns.activeTurn(sessionId);
        return active ? `${active.turnId}:running` : '';
    }
    async listTasks(sessionId, statuses, terminal) {
        const tasks = this.options.backgroundTasks;
        if (!tasks)
            return [];
        const rows = await tasks.list({
            ownerSessionId: sessionId,
            statuses,
            limit: TASK_PAGE_LIMIT,
            ...(terminal ? { undeliveredOnly: true, includeNotification: true } : {}),
        });
        // A managed foreground Bash is still owned by the active Turn, which is reported separately.
        return terminal
            ? rows
            : rows.filter((task) => !(task.kind === 'bash' && task.metadata?.executionMode === 'managed_foreground'));
    }
}
function sessionItems(sessionId, facts) {
    const items = [];
    if (facts.turn) {
        items.push({
            kind: SessionActivityKind.Turn,
            sessionId,
            refId: facts.turn.turnId,
            status: facts.turn.busyReason,
        });
    }
    items.push(...queueItems(sessionId, facts.queue));
    items.push(...taskItems(sessionId, facts.tasks, facts.notifications));
    if (facts.goal && CONTINUING_GOAL_STATUSES[facts.goal.status]) {
        items.push({
            kind: SessionActivityKind.ThreadGoal,
            sessionId,
            refId: facts.goal.goalId,
            status: facts.goal.status,
        });
    }
    items.push(...cronItems(sessionId, facts.cronWakes));
    if (facts.questionnaire) {
        items.push({
            kind: SessionActivityKind.Questionnaire,
            sessionId,
            refId: facts.questionnaire.id,
            detail: facts.questionnaire.mode,
        });
    }
    for (const request of facts.permissions) {
        items.push({ kind: SessionActivityKind.Permission, sessionId, refId: request.requestId });
    }
    return items;
}
function childSessionsOf(tasks) {
    const links = new Map();
    for (const task of tasks) {
        const child = task.metadata?.childSessionId;
        if (task.kind !== 'subagent' || typeof child !== 'string')
            continue;
        const parentTurn = task.metadata?.parentTurnId;
        const foreground = task.metadata?.executionMode === 'foreground' && typeof parentTurn === 'string';
        links.set(task.taskId, {
            childSessionId: child,
            ownerSessionId: task.ownerSessionId,
            ...(foreground ? { waitingTurnId: parentTurn } : {}),
        });
    }
    return links;
}
function queueItems(sessionId, queue) {
    if (queue.pendingCount <= 0)
        return [];
    const detail = String(queue.pendingCount);
    return [
        queue.pause
            ? {
                kind: SessionActivityKind.PausedQueue,
                sessionId,
                refId: queue.pause.triggerTurnId,
                status: queue.pause.cause,
                detail,
            }
            : { kind: SessionActivityKind.QueuedMessages, sessionId, detail },
    ];
}
function taskItems(sessionId, active, terminal) {
    const toItem = (task, kind) => {
        const mode = task.metadata?.executionMode;
        return {
            kind,
            sessionId,
            refId: task.taskId,
            status: task.status,
            detail: typeof mode === 'string' && mode ? `${task.kind}:${mode}` : task.kind,
            ...(kind === SessionActivityKind.TaskNotification && task.endedAt !== undefined
                ? { atMs: task.endedAt }
                : {}),
        };
    };
    const items = [
        ...active.map((task) => toItem(task, SessionActivityKind.BackgroundTask)),
        // Absent notification means the ledger was unreadable; readers treat it as settled.
        ...terminal
            .filter((task) => task.notification?.state === 'pending')
            .map((task) => toItem(task, SessionActivityKind.TaskNotification)),
    ];
    // `undeliveredOnly` keeps settled-but-undelivered rows (bound to a Turn, or suppressed by a
    // user stop), so a full page may hide pending notifications behind settled ones. Report
    // the unread remainder as pending work rather than publish an Idle the read cannot back.
    if (terminal.length >= TASK_PAGE_LIMIT) {
        items.push({
            kind: SessionActivityKind.TaskNotification,
            sessionId,
            refId: TASK_PAGE_FULL_REF,
            status: 'unknown',
            detail: `undelivered terminal tasks exceed the ${TASK_PAGE_LIMIT}-row read`,
        });
    }
    return items;
}
/** Self reminders are agent-set one-shot follow-ups; anything else is a user Cron. */
function cronPurpose(cronId) {
    return isSelfReminderId(cronId) ? 'self_reminder' : 'cron';
}
function cronItems(sessionId, wakes) {
    return wakes.map((entry) => {
        const detail = cronPurpose(entry.cronId);
        return entry.kind === 'run'
            ? {
                kind: SessionActivityKind.CronRun,
                sessionId,
                refId: entry.cronId,
                status: 'pending',
                detail,
            }
            : {
                kind: SessionActivityKind.CronSchedule,
                sessionId,
                refId: entry.cronId,
                detail,
                ...(entry.nextRunAtMs !== undefined ? { atMs: entry.nextRunAtMs } : {}),
            };
    });
}
/**
 * Precedence is chosen so a client polling for "nothing left to wait for" never stops early
 * and never waits on work that cannot move:
 * - a pending questionnaire or permission blocks the Turn and Goal continuation of its own
 *   session, so those items count as waiting rather than running;
 * - any other running or self-waking work keeps the tree Running;
 * - a paused Queue only resumes on a user Continue;
 * - future Cron triggers alone are Scheduled.
 */
const STATE_BY_KIND = {
    [SessionActivityKind.Turn]: SessionActivityState.Running,
    [SessionActivityKind.QueuedMessages]: SessionActivityState.Running,
    [SessionActivityKind.BackgroundTask]: SessionActivityState.Running,
    [SessionActivityKind.TaskNotification]: SessionActivityState.Running,
    [SessionActivityKind.ThreadGoal]: SessionActivityState.Running,
    // Never emitted by this reader (see the class comment); kept so the map stays total.
    [SessionActivityKind.TeamPlan]: SessionActivityState.Running,
    [SessionActivityKind.CronRun]: SessionActivityState.Running,
    [SessionActivityKind.Questionnaire]: SessionActivityState.WaitingForUser,
    [SessionActivityKind.Permission]: SessionActivityState.WaitingForUser,
    [SessionActivityKind.PausedQueue]: SessionActivityState.WaitingForUser,
    [SessionActivityKind.CronSchedule]: SessionActivityState.Scheduled,
};
function activityState(items, childSessionOfTask) {
    const blockedSessions = new Set(items
        .filter((item) => item.kind === SessionActivityKind.Questionnaire ||
        item.kind === SessionActivityKind.Permission)
        .map((item) => item.sessionId));
    // A foreground subagent run makes its parent Turn wait on the child, so a blocked child
    // blocks the parent session as a whole: its Turn, its Goal and its queue (which cannot
    // drain until that Turn ends). Blocking climbs every foreground link in turn, so a
    // chain of foreground subagents blocks all the way up. Background/append runs leave the
    // parent free.
    const foregroundLinks = [...childSessionOfTask.values()].filter((link) => link.waitingTurnId !== undefined);
    for (let grew = true; grew;) {
        grew = false;
        for (const link of foregroundLinks) {
            if (blockedSessions.has(link.childSessionId) && !blockedSessions.has(link.ownerSessionId)) {
                blockedSessions.add(link.ownerSessionId);
                grew = true;
            }
        }
    }
    const waitsOnUser = (item) => {
        // A session's own Turn/Goal cannot advance past its pending questionnaire or permission,
        // and its queue cannot drain until that Turn ends.
        if (blockedSessions.has(item.sessionId) &&
            (item.kind === SessionActivityKind.Turn ||
                item.kind === SessionActivityKind.ThreadGoal ||
                item.kind === SessionActivityKind.QueuedMessages)) {
            return true;
        }
        // A running subagent Task is only as live as the child session it runs in.
        if (item.kind === SessionActivityKind.BackgroundTask && item.refId !== undefined) {
            const link = childSessionOfTask.get(item.refId);
            return link !== undefined && blockedSessions.has(link.childSessionId);
        }
        return false;
    };
    const states = items.map((item) => waitsOnUser(item) ? SessionActivityState.WaitingForUser : STATE_BY_KIND[item.kind]);
    for (const state of [
        SessionActivityState.Running,
        SessionActivityState.WaitingForUser,
        SessionActivityState.Scheduled,
    ]) {
        if (states.includes(state))
            return state;
    }
    return SessionActivityState.Idle;
}
//# sourceMappingURL=activity-application.js.map