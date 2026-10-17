/**
 * EngineProduction — production phase execution for the CycleEngine.
 *
 * Handles: dispatching tasks to agents, timeout enforcement, status sync to owner.
 */
import { backgroundCtx, logger } from './host-utils.js';
import { buildTaskPrompt } from './prompt-builder.js';
import { BoardWatcher, ACTIVITY_RECENCY_THRESHOLD_MS, } from './board-watcher.js';
import { Role, ToolCallStatus, MsgType, } from '@mavis/agent-core/protocol/agent-message';
import { createEngineMessenger, sendError, sendFailed } from './engine-communication.js';
// ─── Constants ──────────────────────────────────────────────────────
export const MAX_TASK_RUNTIME_MS = 30 * 60 * 1000; // 30 minutes
export const STATUS_SYNC_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
export const HEARTBEAT_SUMMARY_DEPTH = 3;
export const HEARTBEAT_SCAN_LIMIT = 10;
/** Max in-cycle retries when a task completes with no deliverable (stale end / agent didn't write). */
export const MAX_NO_DELIVERABLE_RETRIES = 2;
/** Poll interval for the durable deliverable completion signal. */
export const DELIVERABLE_WATCH_INTERVAL_MS = 1_000;
/** Number of identical stat snapshots required before accepting a deliverable as complete. */
export const DELIVERABLE_STABLE_SAMPLES_REQUIRED = 2;
// ─── Production Phase ───────────────────────────────────────────────
export async function runProductionPhase(planId, batch, _plan, deps) {
    const ctx = backgroundCtx();
    const { store, communication, sessions, reporting, workspace } = deps;
    // Resolve owner identity from plan state (set at plan creation time)
    const ownerState = store.getState(planId);
    const ownerSessionId = ownerState?.owner_session_id ?? planId;
    const ownerAgentName = ownerState?.owner_agent_name ?? 'engine';
    const messenger = createEngineMessenger(communication, ownerSessionId, ownerAgentName);
    const handles = new Map();
    sessions.setActiveHandles(planId, handles);
    // Track start times for timeout enforcement
    const startTimes = new Map();
    const sessionIds = new Map(); // taskId → sessionId
    const agentNames = new Map(); // taskId → agentName
    for (const task of batch) {
        const agentName = task.assigned_to;
        if (!agentName) {
            logger.warn(ctx, `[team-engine] No agent assigned: planId=${planId} taskId=${task.id}`);
            continue;
        }
        deps.transitionTask(ctx, planId, task.id, 'producing');
        workspace.ensureTaskOutputDir(planId, task.id);
        // Build paths early — ensureSession (atomic spawn path) needs them to assemble
        // initial_prompt before the spawn RPC.
        const taskPaths = workspace.getTaskPaths(planId, task.id);
        const taskPrompt = buildTaskPrompt(task, {
            outputDir: taskPaths.outputDir,
            deliverablePath: taskPaths.deliverablePath,
            workspaceDir: taskPaths.workspaceDir,
            boardPath: taskPaths.boardPath,
            taskId: task.id,
            agentName,
            lastResult: store.getState(planId)?.results.find((r) => r.task_id === task.id),
        });
        const { sessionId, isFresh } = await sessions.ensureSession(planId, agentName, task.id, 'producer', (pid, content) => {
            const state = store.getState(pid);
            if (state)
                return reporting.sendToOwner(state, content);
            return Promise.resolve();
        }, async (pid) => {
            // Pause is handled by the engine — we just need to signal it
            store.updateState(pid, (s) => ({ ...s, status: 'paused' }));
        }, 
        // initialPrompt — on the atomic-spawn path (isFresh=true), ensureSession
        // hands it to Communicate(command='spawn', spawn_config.initial_prompt)
        // in a single RPC. On the recovery path (isFresh=false) the caller MUST
        // call sendPrompt below to deliver this task prompt.
        taskPrompt);
        const startedAtMs = Date.now();
        const effectiveTimeout = Math.min(task.timeout_ms, MAX_TASK_RUNTIME_MS);
        store.updateTaskResult(planId, task.id, {
            producer_session_id: sessionId,
            producer_agent: agentName,
            started_at: startedAtMs,
            finished_at: undefined,
            timeout_extended_ms: 0,
            timeout_deadline_at: startedAtMs + effectiveTimeout,
        });
        startTimes.set(task.id, startedAtMs);
        sessionIds.set(task.id, sessionId);
        agentNames.set(task.id, agentName);
        // Use the smaller of task.timeout_ms and hard 30min base cap. Owners may extend active tasks.
        const handle = sessions.createCompletionHandle(sessionId, effectiveTimeout);
        handles.set(task.id, handle);
        if (isFresh) {
            // Atomic-spawn path: Communicate(command='spawn') already delivered taskPrompt
            // as the child session's first user_message. No follow-up sendPrompt needed —
            // a second send would race the in-flight first turn and trigger
            // "session has active turn".
            handle.activate();
            logger.info(ctx, `[team-engine] Task dispatched (atomic spawn): planId=${planId} taskId=${task.id} agentName=${agentName} sessionId=${sessionId}`);
        }
        else {
            // Recovery path: session was reused (pause→resume / daemon restart / cache hit).
            // Previous turn already ended; send taskPrompt as a fresh user_message.
            const sendResult = await messenger.sendPrompt(sessionId, taskPrompt);
            if (sendFailed(sendResult)) {
                const error = sendError(sendResult);
                logger.error(ctx, `[team-engine] Task dispatch failed: planId=${planId} taskId=${task.id} agentName=${agentName} sessionId=${sessionId} err=${error}`);
                // Mark task as ready for retry and notify owner immediately
                store.updateTaskResult(planId, task.id, {
                    status: 'ready',
                    verdict_summary: `Dispatch failed: ${error}`,
                    attempt: (store.getState(planId)?.results.find((r) => r.task_id === task.id)?.attempt ?? 0) + 1,
                });
                handles.delete(task.id);
                // Attach a no-op rejection handler BEFORE cancel() — once we drop the
                // handle from `handles`, nothing downstream awaits its promise, so the
                // `Cancelled` rejection raised by handle.cancel() would otherwise bubble
                // up to process.on('unhandledRejection') and kill the daemon
                // (see daemon/src/index.ts). Dispatch failure is a recoverable, expected
                // path — the task is already marked 'ready' for retry above — so silently
                // absorb the cancellation here.
                handle.promise.catch(() => {
                    /* dispatch already failed — cancellation is the expected wake-up */
                });
                handle.cancel();
                const state = store.getState(planId);
                if (state) {
                    await reporting.sendToOwner(state, `## Task Dispatch Failed: ${task.id}\n\nAgent: ${agentName}\nSession: ${sessionId}\nError: ${error}\n\nTask has been returned to ready state for retry.`);
                }
                continue;
            }
            // Activate AFTER send — stale end events from previous turns are now safely drained
            handle.activate();
            logger.info(ctx, `[team-engine] Task dispatched (recovered session): planId=${planId} taskId=${task.id} agentName=${agentName} sessionId=${sessionId}`);
        }
    }
    // ── Start BoardWatcher — parallel monitoring of board.md ──────────
    // NudgeRegistry: if provided, nudges are injected via system-reminder;
    // otherwise a no-op registry is used (nudges are silently dropped).
    const { NudgeRegistry: NR } = await import('./nudge-registry.js');
    const effectiveNudgeRegistry = deps.nudgeRegistry ?? new NR();
    const boardWatcher = new BoardWatcher(planId, {
        store,
        nudgeRegistry: effectiveNudgeRegistry,
        reporting,
        workspace,
        isSessionFinished: deps.sessionService
            ? async (sid) => {
                try {
                    const info = await deps.sessionService.getSession(sid);
                    const t = info?.status?.type;
                    return t === 'finished' || t === 'aborted' || t === 'error';
                }
                catch {
                    return false;
                }
            }
            : undefined,
        getLastActivityTime: deps.sessionService
            ? async (sid) => {
                try {
                    const info = await deps.sessionService.getSession(sid);
                    if (!info?.updatedAt)
                        return null;
                    const ms = typeof info.updatedAt === 'number'
                        ? info.updatedAt
                        : new Date(info.updatedAt).getTime();
                    return Number.isFinite(ms) ? ms : null;
                }
                catch {
                    return null;
                }
            }
            : undefined,
    });
    const sessionMap = new Map();
    for (const [taskId, sid] of sessionIds) {
        sessionMap.set(sid, {
            agentName: agentNames.get(taskId) ?? 'unknown',
            taskId,
        });
    }
    boardWatcher.start(sessionMap);
    try {
        // ── Immediate status sync — owner sees sessions right after dispatch ──
        {
            const state = store.getState(planId);
            if (state) {
                const lines = await buildRunningStatusLines(startTimes, sessionIds, agentNames, planId, workspace, store, deps.sessionService, boardWatcher);
                if (lines.length > 0) {
                    await reporting.sendToOwner(state, `## Tasks Dispatched\n\n${lines.join('\n')}\n\n` +
                        `To send a message to a running session: use the \`communicate\` tool with to_session=<session-id>.\n` +
                        `To extend a task before timeout: \`team({ command: "extend-timeout", args: { plan_id: "${planId}", task_id: "<task-id>", extra_minutes: 15 } })\`\n` +
                        `To stop the plan: \`team({ command: "cancel", args: { plan_id: "${planId}" } })\``, { type: 'team-heartbeat' });
                }
            }
        }
        // ── Periodic status sync to owner while tasks are running ────────
        const syncInterval = setInterval(async () => {
            const state = store.getState(planId);
            if (!state || state.status !== 'running')
                return;
            const lines = await buildRunningStatusLines(startTimes, sessionIds, agentNames, planId, workspace, store, deps.sessionService, boardWatcher);
            if (lines.length > 0) {
                await reporting.sendToOwner(state, `## Running Tasks Status\n\n${lines.join('\n')}\n\n` +
                    `Tasks can be extended with \`team({ command: "extend-timeout", args: { plan_id: "${planId}", task_id: "<task-id>", extra_minutes: 15 } })\`; use \`team({ command: "cancel", args: { plan_id: "${planId}" } })\` to intervene.`, { type: 'team-heartbeat' });
            }
        }, STATUS_SYNC_INTERVAL_MS);
        if (typeof syncInterval.unref === 'function')
            syncInterval.unref();
        // ── Wait for all tasks to complete or timeout (with in-cycle retry) ──
        const results = await Promise.allSettled(Array.from(handles.entries()).map(async ([taskId, handle]) => {
            const sessionId = sessionIds.get(taskId);
            let currentHandle = handle;
            let retries = 0;
            // eslint-disable-next-line no-constant-condition
            while (true) {
                const result = await waitForProductionCompletion({
                    handle: currentHandle,
                    workspace,
                    planId,
                    taskId,
                    getStartedAt: () => store.getState(planId)?.results.find((r) => r.task_id === taskId)?.started_at,
                });
                if (!result.completed) {
                    // Timeout — no retry, will be handled below
                    return { taskId, result };
                }
                // Check for deliverable
                if (workspace.hasCurrentDeliverable(planId, taskId, store.getState(planId)?.results.find((r) => r.task_id === taskId)?.started_at)) {
                    // Success — has deliverable
                    return { taskId, result };
                }
                // No deliverable — retry within the same cycle if under limit
                retries++;
                if (retries > MAX_NO_DELIVERABLE_RETRIES) {
                    return { taskId, result };
                }
                logger.info(ctx, `[team-engine] No deliverable after completion — in-cycle retry: planId=${planId} taskId=${taskId} retry=${retries} maxRetries=${MAX_NO_DELIVERABLE_RETRIES}`);
                // Create a new handle + re-send prompt
                const agentName = agentNames.get(taskId) ?? 'unknown';
                const effectiveTimeout = Math.min(store.getAllTasks(planId).find((t) => t.id === taskId)?.timeout_ms ??
                    MAX_TASK_RUNTIME_MS, MAX_TASK_RUNTIME_MS);
                currentHandle = sessions.createCompletionHandle(sessionId, effectiveTimeout);
                handles.set(taskId, currentHandle);
                const retryStartedAtMs = Date.now();
                store.updateTaskResult(planId, taskId, {
                    started_at: retryStartedAtMs,
                    finished_at: undefined,
                    timeout_extended_ms: 0,
                    timeout_deadline_at: retryStartedAtMs + effectiveTimeout,
                });
                workspace.ensureTaskOutputDir(planId, taskId);
                const taskPaths = workspace.getTaskPaths(planId, taskId);
                const task = store.getAllTasks(planId).find((t) => t.id === taskId);
                const retrySendResult = await messenger.sendPrompt(sessionId, task
                    ? buildTaskPrompt(task, {
                        outputDir: taskPaths.outputDir,
                        deliverablePath: taskPaths.deliverablePath,
                        workspaceDir: taskPaths.workspaceDir,
                        boardPath: taskPaths.boardPath,
                        taskId: task.id,
                        agentName: agentNames.get(taskId),
                        lastResult: store.getState(planId)?.results.find((r) => r.task_id === task.id),
                    })
                    : `Your previous attempt did not produce a deliverable. Please write your output to ${taskPaths.deliverablePath} and try again.`);
                if (sendFailed(retrySendResult)) {
                    logger.error(ctx, `[team-engine] In-cycle retry send failed: planId=${planId} taskId=${taskId} sessionId=${sessionId} retry=${retries} err=${sendError(retrySendResult)}`);
                    // Treat failed send as exhausted retries — return current result
                    return { taskId, result };
                }
                // Activate after send
                currentHandle.activate();
                logger.info(ctx, `[team-engine] In-cycle retry dispatched: planId=${planId} taskId=${taskId} agentName=${agentName} sessionId=${sessionId} retry=${retries}`);
            }
        }));
        clearInterval(syncInterval);
        boardWatcher.stop();
        // ── Process results ─────────────────────────────────────────────
        for (const settled of results) {
            if (settled.status === 'fulfilled') {
                const { taskId, result } = settled.value;
                const sessionId = sessionIds.get(taskId);
                const agentName = agentNames.get(taskId) ?? 'unknown';
                store.updateTaskResult(planId, taskId, {
                    finished_at: Date.now(),
                });
                if (!result.completed) {
                    // ── TIMEOUT: force-kill ─────────────────────────────────
                    const elapsed = startTimes.has(taskId)
                        ? Math.round((Date.now() - startTimes.get(taskId)) / 1000 / 60)
                        : 0;
                    const extendedMs = store.getState(planId)?.results.find((r) => r.task_id === taskId)
                        ?.timeout_extended_ms ?? 0;
                    const deathReason = `Task killed: exceeded ${elapsed}min runtime ` +
                        `(base max 30min${extendedMs > 0 ? ` + ${formatDuration(extendedMs)} owner extension` : ''})`;
                    // 1. Abort the session
                    if (sessionId) {
                        const abortResult = await messenger.sendAbort(sessionId);
                        if (sendFailed(abortResult)) {
                            logger.warn(ctx, `[team-engine] Best-effort abort send failed: planId=${planId} taskId=${taskId} sessionId=${sessionId} err=${sendError(abortResult)}`);
                        }
                    }
                    // 2. Force the killed agent to write memory about what happened
                    // Worker memory prompts stay in English. Worker agents are not
                    // user-facing — their job is to record diagnostic context, and
                    // mixing CN/EN strings here forced English-speaking workers to
                    // translate before writing. See fix/permission-title-locale.
                    if (sessionId) {
                        const memoryResult = await messenger.sendPrompt(sessionId, `Your task was killed by the engine. Reason: ${deathReason}\n\n` +
                            'Please immediately write the following to your memory:\n' +
                            '1. What you were doing and how far you got\n' +
                            '2. What blockers caused the timeout\n' +
                            '3. What to watch out for on the next retry\n\n' +
                            'This memory will help you (or another agent) finish the task faster on retry.');
                        if (sendFailed(memoryResult)) {
                            logger.warn(ctx, `[team-engine] Best-effort timeout memory prompt failed: planId=${planId} taskId=${taskId} sessionId=${sessionId} err=${sendError(memoryResult)}`);
                        }
                    }
                    // 3. Notify owner
                    const state = store.getState(planId);
                    await reporting.sendToOwner(state, `## Task Killed: ${taskId}\n\n` +
                        `Agent: ${agentName}\n` +
                        `Reason: ${deathReason}\n` +
                        `Session: ${sessionId ?? 'unknown'}\n\n` +
                        'Agent has been asked to write memory about the failure.');
                    // 4. Update state — back to ready for retry
                    store.updateTaskResult(planId, taskId, {
                        status: 'ready',
                        verdict_summary: deathReason,
                        attempt: (store.getState(planId)?.results.find((r) => r.task_id === taskId)?.attempt ?? 0) + 1,
                    });
                    logger.warn(ctx, `[team-engine] Task killed due to timeout: planId=${planId} taskId=${taskId} agentName=${agentName} elapsed=${elapsed}`);
                }
                else if (!workspace.hasCurrentDeliverable(planId, taskId, store.getState(planId)?.results.find((r) => r.task_id === taskId)?.started_at)) {
                    // Session idle but no deliverable.md (exhausted in-cycle retries)
                    store.updateTaskResult(planId, taskId, {
                        status: 'ready',
                        verdict_summary: `No deliverable.md after ${MAX_NO_DELIVERABLE_RETRIES} in-cycle retries — agent did not complete delivery`,
                        attempt: (store.getState(planId)?.results.find((r) => r.task_id === taskId)?.attempt ?? 0) + 1,
                    });
                    logger.warn(ctx, `[team-engine] Session idle but no deliverable.md (retries exhausted): planId=${planId} taskId=${taskId}`);
                }
                // else: completed + has deliverable → stays in 'producing', will move to verifying
            }
        }
        sessions.deleteActiveHandles(planId);
    }
    finally {
        boardWatcher.stop();
    }
}
// ─── Helpers ────────────────────────────────────────────────────────
/**
 * Threshold (ms-from-timeout) at which the heartbeat starts hinting that the
 * owner may need to intervene. Stays well clear of suggesting "abort" — the
 * heartbeat narrates state, the timeout logic does the actual killing.
 */
const TIMEOUT_PROXIMITY_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes
/** Build status lines for running tasks (used in owner status updates). */
async function buildRunningStatusLines(startTimes, sessionIds, agentNames, planId, workspace, store, sessionService, boardWatcher) {
    const lines = [];
    const boardHealth = boardWatcher?.getBoardHealth() ?? new Map();
    for (const [taskId, startTime] of startTimes) {
        const elapsed = Math.round((Date.now() - startTime) / 1000 / 60);
        const taskResult = store.getState(planId)?.results.find((r) => r.task_id === taskId);
        const extendedMs = taskResult?.timeout_extended_ms ?? 0;
        const deadlineAtMs = taskResult?.timeout_deadline_at
            ? taskResult.timeout_deadline_at
            : startTime + MAX_TASK_RUNTIME_MS + extendedMs;
        const remainingMs = deadlineAtMs - Date.now();
        const remaining = Math.round(remainingMs / 1000 / 60);
        const agent = agentNames.get(taskId) ?? 'unknown';
        const sid = sessionIds.get(taskId) ?? 'unknown';
        const hasOutput = workspace.hasCurrentDeliverable(planId, taskId, startTime);
        const activity = await summarizeSessionActivity(sessionService, sid);
        const recentlyActive = await isSessionRecentlyActive(sessionService, sid);
        const health = boardHealth.get(sid);
        const boardStatus = renderBoardHealthStatus({
            health,
            hasDeliverable: hasOutput,
            recentlyActive,
            remainingMs,
            planId,
            taskId,
            sessionId: sid,
        });
        lines.push(`- **${taskId}** (${agent}, session: ${sid}): ${elapsed}min elapsed, ${remaining}min remaining` +
            `${extendedMs > 0 ? ` (${formatDuration(extendedMs)} extended)` : ''}` +
            `${hasOutput ? ' ✓ deliverable found' : ''}` +
            `${boardStatus ? ` — ${boardStatus}` : ''}` +
            `${activity ? ` — ${activity}` : ''}`);
    }
    return lines;
}
/**
 * Render the board-health portion of a heartbeat line.
 *
 * Layered interpretation, in order:
 *   1. deliverable.md present  → `deliverable found, awaiting completion` —
 *      stale board is just "wrapping up" noise, never an abort hint.
 *   2. fresh board entry       → `board fresh` (only show when there's
 *      something interesting to say; otherwise omit the segment).
 *   3. board stale + worker still active recently OR escalated but session
 *      moving                  → `WATCH: board stale, session active` — no
 *      abort suggestion.
 *   4. board stale + escalated + no recent activity + no deliverable
 *      + far from timeout      → `WARN: board stale, session quiet, needs
 *      attention` — still no abort suggestion (timeout enforcement owns the
 *      kill decision).
 *   5. board stale + escalated + close to timeout
 *                              → `WARN: board stale, session quiet, approaching
 *      timeout` — surfaces urgency without instructing the owner to abort.
 */
function renderBoardHealthStatus(args) {
    const { health, hasDeliverable, recentlyActive, remainingMs, planId, taskId, sessionId } = args;
    if (hasDeliverable) {
        // Deliverable wins — stale board is just "wrapping up", not a problem.
        return 'deliverable found, awaiting completion';
    }
    if (!health)
        return '';
    const ageDesc = formatBoardAge(health.msSinceLastBoardUpdate);
    if (!health.stale) {
        // Fresh enough — only worth surfacing if we just nudged this round.
        if (health.nudgeCount > 0) {
            return `board fresh (${ageDesc})`;
        }
        return '';
    }
    // Stale path — interpret based on session activity + timeout proximity.
    if (recentlyActive) {
        return `WATCH: board stale ${ageDesc}, session active. Inspect if needed via the \`mavis\` tool: \`mavis({ command: "session messages", args: { session_id: "${sessionId}", limit: 5 } })\`.`;
    }
    // Stale and quiet.
    const closeToTimeout = remainingMs <= TIMEOUT_PROXIMITY_THRESHOLD_MS;
    if (health.escalated && closeToTimeout) {
        const remainingDesc = formatDuration(remainingMs);
        return (`WARN: board stale ${ageDesc}, session quiet, ${remainingDesc} until timeout. ` +
            `Owner should inspect via \`mavis({ command: "session messages", args: { session_id: "${sessionId}", limit: 5 } })\`; ` +
            `if it is still making progress, run \`team({ command: "extend-timeout", args: { plan_id: "${planId}", task_id: "${taskId}", extra_minutes: 15 } })\`; ` +
            `if it is stuck or going in the wrong direction, run \`team({ command: "steer", args: { plan_id: "${planId}", message: "..." } })\` or \`team({ command: "cancel", args: { plan_id: "${planId}" } })\`.`);
    }
    if (health.escalated) {
        return (`WARN: board stale ${ageDesc}, session quiet, needs attention. ` +
            `Owner should inspect via \`mavis({ command: "session messages", args: { session_id: "${sessionId}", limit: 5 } })\`; ` +
            `if the worker is blocked or drifting, run \`team({ command: "steer", args: { plan_id: "${planId}", message: "..." } })\`; ` +
            `if you need to stop and decide manually, run \`team({ command: "cancel", args: { plan_id: "${planId}" } })\`.`);
    }
    return `WATCH: board stale ${ageDesc}. Inspect if needed via the \`mavis\` tool: \`mavis({ command: "session messages", args: { session_id: "${sessionId}", limit: 5 } })\`.`;
}
function formatBoardAge(ms) {
    if (ms === null)
        return 'no entries yet';
    const minutes = Math.floor(ms / 60_000);
    const seconds = Math.floor((ms % 60_000) / 1000);
    if (minutes === 0)
        return `${seconds}s`;
    return seconds === 0 ? `${minutes}m` : `${minutes}m${seconds}s`;
}
function formatDuration(ms) {
    const safeMs = Math.max(0, ms);
    const minutes = Math.floor(safeMs / 60_000);
    const seconds = Math.floor((safeMs % 60_000) / 1000);
    if (minutes === 0)
        return `${seconds}s`;
    return seconds === 0 ? `${minutes}m` : `${minutes}m${seconds}s`;
}
/** True if the worker session had any tool/message activity within the recency window. */
async function isSessionRecentlyActive(sessionService, sessionId) {
    if (!sessionService || sessionId === 'unknown')
        return false;
    try {
        const info = await sessionService.getSession(sessionId);
        if (!info?.updatedAt)
            return false;
        const last = typeof info.updatedAt === 'number' ? info.updatedAt : new Date(info.updatedAt).getTime();
        return Number.isFinite(last) && Date.now() - last < ACTIVITY_RECENCY_THRESHOLD_MS;
    }
    catch (err) {
        logger.warn(backgroundCtx(), `[team-engine] Session recency check unavailable: sessionId=${sessionId} err=${String(err)}`);
        return false;
    }
}
/**
 * Best-effort activity summary for heartbeat/status messages.
 * Board entries are richer, but workers do not always update the board; this fallback
 * keeps owner heartbeats useful by peeking at the worker session's latest messages.
 */
async function summarizeSessionActivity(sessionService, sessionId) {
    if (!sessionService || sessionId === 'unknown')
        return 'no recent session activity available';
    try {
        const messages = await sessionService.getRecentMessages(sessionId, HEARTBEAT_SCAN_LIMIT);
        const summaries = [];
        for (let i = messages.length - 1; i >= 0; i--) {
            const message = messages[i];
            if (!message)
                continue;
            const summary = summarizeMessage(message);
            if (!summary)
                continue;
            summaries.push({ text: summary, timestamp: message.timestamp });
            if (summaries.length >= HEARTBEAT_SUMMARY_DEPTH)
                return renderActivitySummaries(summaries);
        }
        if (summaries.length > 0)
            return renderActivitySummaries(summaries);
        return 'no recent session activity yet';
    }
    catch (err) {
        logger.warn(backgroundCtx(), `[team-engine] Session activity summary unavailable: sessionId=${sessionId} err=${String(err)}`);
        return 'recent session activity unavailable';
    }
}
function renderActivitySummaries(summaries) {
    const rendered = summaries.map(renderActivitySummary).join(' | ');
    const latest = summaries[0];
    const lastTs = normalizeTimestamp(latest?.timestamp);
    if (lastTs !== null && Date.now() - lastTs > ACTIVITY_RECENCY_THRESHOLD_MS) {
        return `${rendered} | Consider checking the session (last activity ${formatActivityAge(Date.now() - lastTs)} ago)`;
    }
    return rendered;
}
function renderActivitySummary(summary) {
    const ts = normalizeTimestamp(summary.timestamp);
    if (ts === null)
        return summary.text;
    return `[${formatActivityTime(ts)}, ${formatActivityAge(Date.now() - ts)} ago] ${summary.text}`;
}
function normalizeTimestamp(ts) {
    if (!Number.isFinite(ts))
        return null;
    const value = ts;
    // Agent messages normally store epoch-ms; tolerate epoch-seconds from older tests/logs.
    return value < 10_000_000_000 ? value * 1000 : value;
}
function formatActivityTime(ts) {
    return new Date(ts).toLocaleTimeString('sv-SE', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
    });
}
function formatActivityAge(ms) {
    const safeMs = Math.max(0, ms);
    const minutes = Math.floor(safeMs / 60_000);
    const seconds = Math.floor((safeMs % 60_000) / 1000);
    if (minutes === 0)
        return `${seconds}s`;
    return seconds === 0 ? `${minutes}m` : `${minutes}m${seconds}s`;
}
function summarizeMessage(message) {
    // SystemEvent messages are daemon-injected envelopes (communication.message,
    // session.spawned, etc.) — their msg_content is a JSON event payload, not
    // worker-authored text, so they must never appear in a heartbeat preview.
    if (message.msg_type === MsgType.SystemEvent)
        return null;
    const toolCalls = message.tool_calls ?? [];
    const activeTool = [...toolCalls]
        .reverse()
        .find((tool) => tool.tool_call_status === ToolCallStatus.Start);
    if (activeTool)
        return `running tool ${activeTool.tool_name}${formatToolArgs(activeTool)}`;
    const completedTool = [...toolCalls]
        .reverse()
        .find((tool) => tool.tool_call_status === ToolCallStatus.Finished);
    if (completedTool)
        return `tool ${completedTool.tool_name} finished${formatToolArgs(completedTool)}`;
    const failedTool = [...toolCalls]
        .reverse()
        .find((tool) => tool.tool_call_status === ToolCallStatus.Failed);
    if (failedTool)
        return `tool ${failedTool.tool_name} failed${formatToolArgs(failedTool)}`;
    const content = compactText(message.msg_content, MESSAGE_PREVIEW_CHARS);
    if (content) {
        const role = message.role === Role.User ? 'user message' : 'assistant update';
        return `${role}: ${content}`;
    }
    return null;
}
/**
 * Render a compact preview of a tool call's arguments. Each arg is truncated to
 * keep the heartbeat line readable when the agent is invoking tools with large
 * payloads (e.g. write/edit with full file content).
 */
function formatToolArgs(tool) {
    if (!tool.tool_call_args)
        return '';
    let parsed;
    try {
        parsed = JSON.parse(tool.tool_call_args);
    }
    catch {
        const raw = compactText(tool.tool_call_args, TOOL_ARG_PREVIEW_CHARS);
        return raw ? ` (${raw})` : '';
    }
    if (!parsed || typeof parsed !== 'object') {
        const raw = compactText(String(parsed ?? ''), TOOL_ARG_PREVIEW_CHARS);
        return raw ? ` (${raw})` : '';
    }
    const args = parsed;
    const entries = selectToolArgEntries(tool.tool_name, args);
    if (entries.length === 0)
        return '';
    const rendered = entries
        .map(([key, value]) => {
        const str = typeof value === 'string' ? value : JSON.stringify(value);
        return `${key}=${compactText(str, TOOL_ARG_PREVIEW_CHARS)}`;
    })
        .join(', ');
    return rendered ? ` (${rendered})` : '';
}
const TOOL_PRIMARY_ARG_KEYS = {
    bash: ['command'],
    read: ['filePath'],
    write: ['filePath'],
    edit: ['filePath'],
    grep: ['pattern', 'path'],
    glob: ['pattern'],
};
function selectToolArgEntries(toolName, args) {
    const entries = Object.entries(args);
    const primaryKeys = TOOL_PRIMARY_ARG_KEYS[toolName];
    if (!primaryKeys)
        return entries;
    const primaryEntries = primaryKeys
        .filter((key) => Object.prototype.hasOwnProperty.call(args, key))
        .map((key) => [key, args[key]]);
    return primaryEntries.length > 0 ? primaryEntries : entries;
}
const MESSAGE_PREVIEW_CHARS = 500;
const TOOL_ARG_PREVIEW_CHARS = 200;
function compactText(value, limit) {
    return (value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);
}
async function waitForProductionCompletion(args) {
    const { handle, workspace, planId, taskId, getStartedAt } = args;
    const controller = new AbortController();
    const deliverablePromise = waitForCurrentDeliverable({
        workspace,
        planId,
        taskId,
        getStartedAt,
        signal: controller.signal,
    });
    const result = await Promise.race([handle.promise, deliverablePromise]);
    controller.abort();
    if (result.completed) {
        handle.cancel();
    }
    return result;
}
async function waitForCurrentDeliverable(args) {
    const { workspace, planId, taskId, getStartedAt, signal } = args;
    let previousSnapshot;
    let stableSamples = 0;
    while (!signal.aborted) {
        const snapshot = workspace.getCurrentDeliverableSnapshot(planId, taskId, getStartedAt());
        if (snapshot && previousSnapshot && sameDeliverableSnapshot(snapshot, previousSnapshot)) {
            stableSamples += 1;
        }
        else {
            stableSamples = snapshot ? 1 : 0;
        }
        previousSnapshot = snapshot;
        if (stableSamples >= DELIVERABLE_STABLE_SAMPLES_REQUIRED) {
            return { content: '', completed: true };
        }
        await sleep(DELIVERABLE_WATCH_INTERVAL_MS, signal);
    }
    return { content: '', completed: false };
}
function sameDeliverableSnapshot(a, b) {
    return a.size === b.size && a.mtimeMs === b.mtimeMs;
}
function sleep(ms, signal) {
    return new Promise((resolve) => {
        if (signal?.aborted) {
            resolve();
            return;
        }
        const timer = setTimeout(resolve, ms);
        if (typeof timer.unref === 'function')
            timer.unref();
        signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            resolve();
        }, { once: true });
    });
}
//# sourceMappingURL=engine-production.js.map