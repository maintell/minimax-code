/**
 * BoardWatcher — monitors plan board.md for progress updates during production.
 *
 * Runs in parallel with CompletionHandle during the production phase.
 * Provides three capabilities:
 *   1. Nudge: detect silent workers (no board update in 90s) and flag them
 *      for system-reminder injection via NudgeRegistry
 *   2. Aggregate: push new board entries to owner immediately so the owner
 *      hears about delta the moment a worker writes; still re-aggregates on a
 *      periodic timer as a safety net for the "no new entries but task still
 *      moving" case
 *   3. Expose board-health signals (per-session nudge count, escalated flag,
 *      stale state, last-board-update age) for the team heartbeat to render
 *
 * Bug-fix guards (v2):
 *   - Finished sessions are evicted before nudging so completed workers are never pestered.
 *   - If a session's last activity (tool call / message) is < 2min ago, the nudge is skipped
 *     because the worker is still actively processing.
 *
 * Nudge delivery (v3 — system-reminder injection):
 *   Instead of sending nudges as user messages via communication.send (which can't
 *   interrupt an active tool-call loop), BoardWatcher now writes nudge flags to a
 *   shared NudgeRegistry. A system-reminder provider reads and injects the nudge
 *   into the worker's next tool-result turn, where the agent naturally sees it.
 *
 * Layering (v4 — separation of concerns):
 *   - BoardWatcher only emits board-health *signals*. It no longer pushes
 *     "Worker Unresponsive / consider aborting" blocker messages directly to
 *     the owner — that interpretation is owned by the team heartbeat in
 *     engine-production, which combines board signals with session activity,
 *     deliverable presence, and timeout state to decide what (if anything) to
 *     surface to the owner.
 *   - Active-cycle detection is keyed by (agentName, taskId), not just
 *     agentName, so a single agent running multiple tasks does not have one
 *     task's board write clear another task's nudge.
 *
 * The watcher is purely observational — it does NOT affect task state transitions.
 * It uses setInterval for polling and is stopped when the production phase ends.
 */
import { backgroundCtx, logger } from './host-utils.js';
// ─── Constants ──────────────────────────────────────────────────────
export const BOARD_POLL_INTERVAL_MS = 90_000; // 90s — original value
export const BOARD_AGGREGATION_INTERVAL_MS = 180_000; // 3min
export const MAX_NUDGE_COUNT = 3;
/** Skip nudge when worker's last tool-call / message activity is within this window. */
export const ACTIVITY_RECENCY_THRESHOLD_MS = 120_000; // 2min
/** A session is considered "board stale" after this many ms without a board entry. */
export const BOARD_STALE_THRESHOLD_MS = BOARD_POLL_INTERVAL_MS;
/**
 * Parse board.md content into structured entries.
 * Entries are separated by `---` lines.
 * Header format: `[YYYY-MM-DD HH:mm:ss] agent-name | task-id | status`
 */
export function parseBoardEntries(content) {
    if (!content.trim())
        return [];
    const entries = [];
    const rawEntries = content.split(/^---$/m).filter((e) => e.trim());
    for (const raw of rawEntries) {
        const lines = raw.trim().split('\n');
        const headerMatch = lines[0]?.match(/^\[(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})\]\s+(\S+)\s*\|\s*(\S+)\s*\|\s*(\S+)/);
        if (!headerMatch)
            continue;
        entries.push({
            timestamp: headerMatch[1],
            agent: headerMatch[2],
            taskId: headerMatch[3],
            status: headerMatch[4],
            body: lines.slice(1).join('\n').trim(),
        });
    }
    return entries;
}
// ─── BoardWatcher ───────────────────────────────────────────────────
export class BoardWatcher {
    planId;
    deps;
    pollTimer = null;
    aggregationTimer = null;
    /** Checkpoint: number of board entries seen so far. */
    checkpoint = 0;
    /** Per-worker nudge state, keyed by sessionId. */
    nudgeState = new Map();
    /** Session ID → agent name mapping (set during start). */
    sessionAgents = new Map();
    /** Session ID → task ID mapping (set during start). */
    sessionTasks = new Map();
    /**
     * `${agentName}::${taskId}` → sessionId reverse index. Used to match board
     * entries (which carry agent + taskId) back to a specific session, so we
     * never clear another task's nudge just because the same agent wrote to a
     * different task's board entry.
     */
    agentTaskToSession = new Map();
    /** Per-session epoch-ms of last observed board entry (null until first write). */
    lastBoardUpdateMs = new Map();
    /** Last time we sent an aggregation to owner. */
    lastAggregationTime = 0;
    /** Plan start time captured at watcher start (used as the "no board entries yet" baseline). */
    startedAtMs = Date.now();
    constructor(planId, deps) {
        this.planId = planId;
        this.deps = deps;
    }
    /**
     * Start watching the board file.
     * @param sessionMap Map of sessionId → { agentName, taskId } for active workers.
     */
    start(sessionMap) {
        const ctx = backgroundCtx();
        const state = this.deps.store.getState(this.planId);
        if (!state)
            return;
        // Initialize per-session tracking
        for (const [sessionId, info] of sessionMap) {
            this.sessionAgents.set(sessionId, info.agentName);
            this.sessionTasks.set(sessionId, info.taskId);
            this.agentTaskToSession.set(agentTaskKey(info.agentName, info.taskId), sessionId);
            this.nudgeState.set(sessionId, { nudgeCount: 0, escalated: false });
        }
        // Read initial checkpoint and seed lastBoardUpdateMs from any pre-existing entries
        const initial = this.readAllEntries();
        this.checkpoint = initial.length;
        this.startedAtMs = Date.now();
        this.lastAggregationTime = this.startedAtMs;
        for (const entry of initial) {
            this.recordBoardUpdate(entry);
        }
        // Poll timer: check for new entries / silent workers
        this.pollTimer = setInterval(() => {
            this.poll().catch((err) => {
                const cbCtx = backgroundCtx();
                logger.error(cbCtx, `[board-watcher] Poll error: planId=${this.planId} err=${String(err)}`);
            });
        }, BOARD_POLL_INTERVAL_MS);
        // Aggregation timer: periodic safety-net push to owner. Most aggregations
        // happen immediately on new entries; this timer covers the (rare) case where
        // poll() saw no new entries but the heartbeat-equivalent signal is still
        // useful to the owner.
        this.aggregationTimer = setInterval(() => {
            this.aggregate().catch((err) => {
                const cbCtx = backgroundCtx();
                logger.error(cbCtx, `[board-watcher] Aggregation error: planId=${this.planId} err=${String(err)}`);
            });
        }, BOARD_AGGREGATION_INTERVAL_MS);
        if (typeof this.pollTimer.unref === 'function')
            this.pollTimer.unref();
        if (typeof this.aggregationTimer.unref === 'function')
            this.aggregationTimer.unref();
        logger.info(ctx, `[board-watcher] Started watching board: planId=${this.planId} sessions=${sessionMap.size}`);
    }
    /** Stop the watcher. Safe to call multiple times. */
    stop() {
        const ctx = backgroundCtx();
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
        }
        if (this.aggregationTimer) {
            clearInterval(this.aggregationTimer);
            this.aggregationTimer = null;
        }
        // Clear all nudge flags for sessions this watcher was tracking
        for (const sessionId of this.sessionAgents.keys()) {
            this.deps.nudgeRegistry.clear(sessionId);
        }
        this.nudgeState.clear();
        this.sessionAgents.clear();
        this.sessionTasks.clear();
        this.agentTaskToSession.clear();
        this.lastBoardUpdateMs.clear();
        logger.info(ctx, `[board-watcher] Stopped: planId=${this.planId}`);
    }
    // ─── Public board-health surface ──────────────────────────────────
    /**
     * Snapshot per-session board-health signals for heartbeat consumption.
     *
     * Returns one entry per session this watcher is tracking. The heartbeat
     * decides how to interpret each signal (WATCH vs WARN, "abort?" vs
     * "wrapping up") by combining it with session activity and deliverable state.
     */
    getBoardHealth() {
        const out = new Map();
        const now = Date.now();
        for (const [sessionId, agentName] of this.sessionAgents) {
            const taskId = this.sessionTasks.get(sessionId) ?? 'unknown';
            const ns = this.nudgeState.get(sessionId);
            const lastUpdate = this.lastBoardUpdateMs.get(sessionId) ?? null;
            const sinceLast = lastUpdate !== null
                ? now - lastUpdate
                : // If we never saw a board entry, age is measured from watcher start.
                    now - this.startedAtMs;
            out.set(sessionId, {
                taskId,
                agentName,
                sessionId,
                nudgeCount: ns?.nudgeCount ?? 0,
                escalated: ns?.escalated ?? false,
                stale: sinceLast >= BOARD_STALE_THRESHOLD_MS,
                lastBoardUpdateMs: lastUpdate,
                msSinceLastBoardUpdate: lastUpdate !== null ? sinceLast : null,
            });
        }
        return out;
    }
    // ─── Internal ─────────────────────────────────────────────────────
    /** Read all current board entries (best-effort; returns [] on read error). */
    readAllEntries() {
        const content = this.deps.workspace.readBoard(this.planId);
        return content ? parseBoardEntries(content) : [];
    }
    /** Read new entries since checkpoint and advance the checkpoint. */
    readNewEntries() {
        const all = this.readAllEntries();
        const newEntries = all.slice(this.checkpoint);
        this.checkpoint = all.length;
        return newEntries;
    }
    /** Record a board entry's epoch-ms timestamp into the per-session lastBoardUpdateMs map. */
    recordBoardUpdate(entry) {
        const sessionId = this.agentTaskToSession.get(agentTaskKey(entry.agent, entry.taskId));
        if (!sessionId)
            return;
        // Prefer the entry's parsed timestamp; fall back to "now" if it cannot be
        // converted (we only need monotonic-enough freshness, not wall-clock fidelity).
        const ts = parseEntryTimestamp(entry.timestamp);
        this.lastBoardUpdateMs.set(sessionId, ts ?? Date.now());
    }
    /** Poll: check for new entries, nudge silent workers, push delta immediately. */
    async poll() {
        const newEntries = this.readNewEntries();
        // Update lastBoardUpdateMs and figure out which (agent, taskId) pairs
        // were active this cycle. We deliberately key on the pair, not just
        // agentName, so a single agent running two tasks does not have task A's
        // write clear task B's nudge.
        const activePairs = new Set();
        for (const entry of newEntries) {
            this.recordBoardUpdate(entry);
            activePairs.add(agentTaskKey(entry.agent, entry.taskId));
        }
        // Reset nudge counts for sessions whose (agent, taskId) wrote this cycle
        for (const [sessionId, agentName] of this.sessionAgents) {
            const taskId = this.sessionTasks.get(sessionId);
            if (!taskId)
                continue;
            const ns = this.nudgeState.get(sessionId);
            if (ns && activePairs.has(agentTaskKey(agentName, taskId))) {
                ns.nudgeCount = 0;
                // Escalation is sticky — once a worker has been flagged as escalated,
                // the heartbeat keeps surfacing that historical signal until the run
                // ends. Resetting it on a single board write would silently hide the
                // attention history from the owner.
                this.deps.nudgeRegistry.clear(sessionId);
            }
        }
        // If the owner just got new board entries, push a delta aggregation right
        // away. We no longer wait for the 3min aggregation timer or only fire on
        // blocked entries — owner should hear about deltas the moment they appear.
        if (newEntries.length > 0) {
            await this.aggregate();
        }
        // Nudge workers that did NOT update this cycle (per (agent, taskId) pair)
        await this.nudgeSilentWorkers(activePairs);
    }
    /** Flag silent workers for system-reminder injection via NudgeRegistry.
     * @param activePairs Set of `${agent}::${taskId}` that wrote entries this poll cycle — skip them.
     */
    async nudgeSilentWorkers(activePairs = new Set()) {
        const ctx = backgroundCtx();
        // ── Step 1: evict finished sessions so we never nudge them ──────
        if (this.deps.isSessionFinished) {
            const sessionIds = [...this.sessionAgents.keys()];
            for (const sid of sessionIds) {
                try {
                    if (await this.deps.isSessionFinished(sid)) {
                        const agent = this.sessionAgents.get(sid);
                        const task = this.sessionTasks.get(sid);
                        if (agent && task)
                            this.agentTaskToSession.delete(agentTaskKey(agent, task));
                        this.sessionAgents.delete(sid);
                        this.sessionTasks.delete(sid);
                        this.nudgeState.delete(sid);
                        this.lastBoardUpdateMs.delete(sid);
                        this.deps.nudgeRegistry.clear(sid);
                        logger.info(ctx, `[board-watcher] Cleaned up finished session: planId=${this.planId} sessionId=${sid}`);
                    }
                }
                catch {
                    // Best effort — don't let status-check errors block nudge logic
                }
            }
        }
        const boardPath = this.deps.store.getBoardPath(this.planId);
        for (const [sessionId, agentName] of this.sessionAgents) {
            const taskId = this.sessionTasks.get(sessionId);
            if (!taskId)
                continue;
            // Skip workers whose (agent, taskId) wrote this cycle
            if (activePairs.has(agentTaskKey(agentName, taskId)))
                continue;
            const ns = this.nudgeState.get(sessionId);
            if (!ns)
                continue;
            // Already-escalated workers no longer get nudge-registry writes. The
            // board-health signal stays "escalated=true" so heartbeat keeps surfacing
            // the historical attention flag, but we stop pestering the worker via
            // system-reminder injection.
            if (ns.escalated)
                continue;
            // ── Step 2: skip nudge when worker is recently active ─────────
            if (this.deps.getLastActivityTime) {
                try {
                    const lastActivity = await this.deps.getLastActivityTime(sessionId);
                    if (lastActivity && Date.now() - lastActivity < ACTIVITY_RECENCY_THRESHOLD_MS) {
                        logger.info(ctx, `[board-watcher] Worker recently active — skipping nudge: planId=${this.planId} sessionId=${sessionId} lastActivityAgeMs=${Date.now() - lastActivity}`);
                        continue;
                    }
                }
                catch {
                    // Best effort — continue with nudge if check fails
                }
            }
            ns.nudgeCount++;
            if (ns.nudgeCount > MAX_NUDGE_COUNT) {
                // Mark as escalated. We deliberately do NOT push a "Worker
                // Unresponsive / consider aborting" message to the owner from here:
                // that interpretation belongs to the heartbeat in engine-production,
                // which combines this signal with session activity, deliverable
                // presence, and timeout state.
                ns.escalated = true;
                logger.warn(ctx, `[board-watcher] Worker board-stale and unresponsive to nudges — escalating health signal: planId=${this.planId} sessionId=${sessionId} agentName=${agentName} taskId=${taskId} nudgeCount=${ns.nudgeCount}`);
                continue;
            }
            // Set nudge flag in the registry — system-reminder will inject it
            this.deps.nudgeRegistry.set(sessionId, {
                boardPath,
                nudgeCount: ns.nudgeCount,
                createdAt: Date.now(),
            });
            logger.info(ctx, `[board-watcher] Nudge flag set in registry: planId=${this.planId} sessionId=${sessionId} nudgeCount=${ns.nudgeCount}`);
        }
    }
    /** Aggregate current board entries and push status to owner. */
    async aggregate() {
        const ctx = backgroundCtx();
        const state = this.deps.store.getState(this.planId);
        if (!state || state.status !== 'running')
            return;
        try {
            const allEntries = this.readAllEntries();
            if (allEntries.length === 0)
                return;
            // Build latest status per task from all entries (last entry wins)
            const taskStatus = new Map();
            for (const entry of allEntries) {
                taskStatus.set(entry.taskId, entry);
            }
            // Calculate elapsed time since plan started
            const elapsed = state.created_at
                ? formatElapsed(Date.now() - new Date(state.created_at).getTime())
                : 'unknown';
            const lines = [`<engine-status plan="${this.planId}" elapsed="${elapsed}">`];
            for (const [taskId, entry] of taskStatus) {
                const bodySnippet = entry.body ? entry.body.slice(0, 200) : '';
                lines.push(`  <task id="${taskId}" agent="${entry.agent}" status="${entry.status}">`, `    ${bodySnippet}`, `  </task>`);
            }
            lines.push('</engine-status>');
            await this.deps.reporting.sendToOwner(state, lines.join('\n'), {
                type: 'team-board-status',
            });
            this.lastAggregationTime = Date.now();
        }
        catch (err) {
            logger.warn(ctx, `[board-watcher] Failed to aggregate: planId=${this.planId} err=${String(err)}`);
        }
    }
}
// ─── Utility ────────────────────────────────────────────────────────
function agentTaskKey(agentName, taskId) {
    return `${agentName}::${taskId}`;
}
/**
 * Convert a board entry's `YYYY-MM-DD HH:mm:ss` timestamp into epoch-ms.
 * Returns null if the timestamp cannot be parsed; callers fall back to Date.now().
 */
function parseEntryTimestamp(ts) {
    // Replace the space with `T` so the local-time string parses consistently
    // across platforms (the recorded timestamp is intentionally local time).
    const ms = Date.parse(ts.replace(' ', 'T'));
    return Number.isFinite(ms) ? ms : null;
}
function formatElapsed(ms) {
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (minutes === 0)
        return `${seconds}s`;
    return `${minutes}m${seconds > 0 ? `${seconds}s` : ''}`;
}
//# sourceMappingURL=board-watcher.js.map