import { isTerminalTaskStatus, readPluginSpawnOrigin, } from '@mavis/background-task/local';
import { parseSubagentConfig } from '@mavis/config';
import { INTERNAL_TREE_SESSION_KINDS, } from '../../service/session-system/index.js';
import { startBackgroundLocalTask, subagentFinalText, } from '../../service/background-bash/index.js';
import { reasonOfSpawnedTask } from '../../service/plugin-extension/index.js';
import { createPluginAgentRoster, } from '../../service/turn-system/index.js';
const ACTIVE_STATUSES = ['queued', 'running', 'stopping'];
const TASK_PAGE_SIZE = 100;
const MAX_LISTED_AGENTS = 200;
/**
 * A child's terminal frame is published before the runner gets the child's result and writes the
 * task row, and only local I/O separates them. A child still unsettled after this is reported
 * without an answer rather than holding its `turn.complete` back indefinitely.
 */
const SPAWNED_ANSWER_WAIT_MS = 10_000;
/**
 * `ctx.agent.spawn` over the background task runner. `spawnedAnswer` reads a finished child back
 * from its task row: the row says who spawned it and how it ended, its output log holds the reply.
 */
export function createPluginExtensionAgentSpawn(deps) {
    const service = () => deps.taskHost().backgroundTaskService;
    const nowMs = deps.nowMs ?? Date.now;
    const port = {
        list: async (sessionId) => {
            const pendingPermissions = await deps.permissions.listPending();
            const agents = await deps.taskHost().agentRoutes.listLocalAgents();
            const seen = new Set([sessionId]);
            let parents = [sessionId];
            const result = [];
            while (parents.length > 0 && result.length < MAX_LISTED_AGENTS) {
                const level = await listAgentLevel(deps, parents, seen, MAX_LISTED_AGENTS - result.length);
                const questionnaires = await Promise.all(level.map(({ child }) => deps.questionnaires.getPending({
                    agentName: child.agentName,
                    sessionId: child.sessionId,
                })));
                for (const [index, { parent, child, task, spawnedBy }] of level.entries()) {
                    const waiting = Boolean(questionnaires[index]) ||
                        pendingPermissions.some((request) => request.sessionId === child.sessionId);
                    const name = agents.find((agent) => agent.name === child.agentName)?.displayName;
                    result.push(agentInfo(child, task, waiting, {
                        parentId: parent === sessionId ? undefined : parent,
                        spawnedBy,
                        name,
                    }));
                }
                parents = level.map(({ child }) => child.sessionId);
            }
            return result;
        },
        start: async ({ sessionId, spawnedBy, turnId, taskInput }) => {
            const host = deps.taskHost();
            const parentSession = await host.getSessionById(sessionId);
            if (!parentSession) {
                return { status: 'failed', errorMessage: `Session ${sessionId} is not available` };
            }
            return startBackgroundLocalTask({
                host,
                parentSession,
                toolCtx: {
                    sessionId,
                    turnId,
                    pluginAgents: createPluginAgentRoster(deps.pluginAgents(sessionId)),
                },
                taskInput,
                spawnedBy,
            });
        },
        countActive: async (sessionId, pluginId) => {
            let active = 0;
            for await (const task of subagentRows(service(), sessionId, ACTIVE_STATUSES)) {
                if (readPluginSpawnOrigin(task)?.pluginId === pluginId)
                    active += 1;
            }
            return active;
        },
        get limit() {
            return parseSubagentConfig({
                maxConcurrentPerSession: deps.config().subagent?.maxConcurrentPerSession,
            }).maxConcurrentPerSession;
        },
        resolvedModel: async (subSessionId) => {
            const child = await deps.sessions.get(subSessionId);
            if (child?.effectiveModel)
                return child.effectiveModel;
            const parent = child?.parentSessionId
                ? await deps.sessions.get(child.parentSessionId)
                : undefined;
            return parent?.effectiveModel ?? deps.config().defaultModel;
        },
    };
    const spawnedAnswer = async (childSessionId, spawnerObserves) => {
        const owner = (await deps.sessions.get(childSessionId))?.parentSessionId;
        if (!owner)
            return undefined;
        const task = await taskOfChild(service(), owner, childSessionId);
        const origin = task && readPluginSpawnOrigin(task);
        if (!origin || !spawnerObserves(origin.pluginId))
            return undefined;
        const settled = await settledTask(service(), task.taskId, nowMs() + SPAWNED_ANSWER_WAIT_MS, nowMs);
        if (!settled)
            return { pluginId: origin.pluginId };
        const answer = await finalAnswer(service(), settled);
        return {
            pluginId: origin.pluginId,
            ...(answer === undefined ? {} : { answer }),
            reason: reasonOfSpawnedTask(settled, answer),
        };
    };
    return { port, spawnedAnswer };
}
async function listAgentLevel(deps, parents, seen, remaining) {
    const level = [];
    for (const parent of parents) {
        const { tasks, origins } = await childTasks(deps.taskHost().backgroundTaskService, parent);
        for (const child of await deps.sessions.listChildren(parent)) {
            if (INTERNAL_TREE_SESSION_KINDS.some((kind) => kind === child.sessionKind))
                continue;
            if (seen.has(child.sessionId))
                continue;
            seen.add(child.sessionId);
            level.push({
                parent,
                child,
                task: tasks.get(child.sessionId),
                spawnedBy: origins.get(child.sessionId),
            });
            if (level.length >= remaining)
                return level;
        }
    }
    return level;
}
async function childTasks(service, parent) {
    const tasks = new Map();
    const origins = new Map();
    for await (const task of subagentRows(service, parent)) {
        const childId = task.metadata?.['childSessionId'];
        if (typeof childId !== 'string')
            continue;
        if (!tasks.has(childId))
            tasks.set(childId, task);
        const origin = readPluginSpawnOrigin(task);
        if (origin)
            origins.set(childId, origin.pluginId);
    }
    return { tasks, origins };
}
function agentInfo(child, task, waiting, optional) {
    return {
        id: child.sessionId,
        description: task?.description ?? child.title ?? '',
        type: child.agentName,
        status: agentListStatus(child.status, task?.status, waiting),
        ...(optional.parentId ? { parentId: optional.parentId } : {}),
        ...(optional.spawnedBy ? { spawnedBy: optional.spawnedBy } : {}),
        ...(optional.name ? { name: optional.name } : {}),
    };
}
const TASK_AGENT_STATUS = {
    queued: 'pending',
    running: 'running',
    stopping: 'running',
    canceled: 'killed',
    lost: 'killed',
    succeeded: 'completed',
    failed: 'failed',
};
// Session error -> failed; aborted/interrupted -> killed; started -> running.
// Task queued -> pending; running/stopping -> running; canceled/lost -> killed;
// succeeded -> completed; failed -> failed. User/permission waits -> waiting before
// active work; idle without a terminal task -> idle (a finished turn is not a closed session).
function agentListStatus(session, task, waiting) {
    if (session === 'error')
        return 'failed';
    if (session === 'aborted' || session === 'interrupted')
        return 'killed';
    if (task === 'canceled' || task === 'lost')
        return 'killed';
    if (waiting)
        return 'waiting';
    if (session === 'started')
        return 'running';
    return task === undefined ? 'idle' : TASK_AGENT_STATUS[task];
}
async function* subagentRows(service, ownerSessionId, statuses) {
    let cursor;
    do {
        const page = await service.list({
            ownerSessionId,
            kinds: ['subagent'],
            limit: TASK_PAGE_SIZE,
            ...(statuses ? { statuses } : {}),
            ...(cursor ? { cursor } : {}),
        });
        yield* page.items;
        cursor = page.nextCursor;
    } while (cursor);
}
/** Newest first: a later `task_append` round on the same child is the main Agent's, not the plugin's. */
async function taskOfChild(service, ownerSessionId, childSessionId) {
    for await (const task of subagentRows(service, ownerSessionId)) {
        if (task.metadata?.['childSessionId'] === childSessionId)
            return task;
    }
    return undefined;
}
/** The task row once terminal, waking on its changes; `undefined` past the deadline. */
async function settledTask(service, taskId, deadlineMs, nowMs) {
    let offset;
    for (;;) {
        const remainingMs = deadlineMs - nowMs();
        const read = await service.readOutput(taskId, {
            waitMs: Math.max(0, remainingMs),
            ...(offset === undefined ? {} : { offset }),
        });
        if (read.task && isTerminalTaskStatus(read.task.status))
            return read.task;
        if (remainingMs <= 0 || read.timedOut === true || !read.task)
            return undefined;
        offset = read.nextOffset ?? offset;
    }
}
/**
 * The runner appends the output before it writes the terminal status, so a settled row normally
 * has it. A `task_stop` can settle the row first; such a row has no answer to give yet, and the
 * event goes out without one.
 */
async function finalAnswer(service, task) {
    const read = await service.readOutput(task.taskId, { offset: 0 });
    const current = read.task ?? task;
    return current.outputRef ? subagentFinalText(current, read.content) : undefined;
}
//# sourceMappingURL=plugin-extension-agent-spawn.js.map