/**
 * CycleEngine — produce-verify cycle state machine.
 *
 * Drives the team execution model:
 *   1. Determine batch (ready tasks with satisfied dependencies)
 *   2. Produce (spawn sessions, agents deliver)
 *   3. Verify (spawn verifier sessions, check outputs)
 *   4. Evaluate (notify owner, owner decides next steps)
 *   5. Loop back to step 1
 *
 * Task state machine: blocked → ready → producing → verifying → done
 *   - Retry: verifying → ready (verification failed)
 *   - No "failed/skipped/rejected" states. Those are scheduling decisions, not states.
 *
 * The engine is keyed by plan_id, allowing multiple concurrent plans per owner.
 * Multiple engine instances can run concurrently, fully isolated.
 *
 * Implementation split across focused modules:
 *   - engine-session.ts    — session lifecycle, completion handles
 *   - engine-reporting.ts  — owner communication, decision queue, reports
 *   - engine-production.ts — production phase execution
 *   - engine-verification.ts — verification phase execution
 */
import { backgroundCtx, getMetricsReporter, logger } from './host-utils.js';
import { Role } from '@mavis/agent-core/protocol/agent-message';
import { assertValidTaskTransition, } from './types.js';
import { formatCycleReport } from './prompt-builder.js';
import { EngineSessionManager } from './engine-session.js';
import { EngineReporting } from './engine-reporting.js';
import { runProductionPhase } from './engine-production.js';
import { runVerificationPhase } from './engine-verification.js';
import { isVerifySkippedTaskAutoContinuable } from './engine-floor-validator.js';
// ─── Engine ─────────────────────────────────────────────────────────
const failClosedGateRunner = {
    async run() {
        return {
            exitCode: 1,
            stderr: 'Team objective gate runner is not configured.',
        };
    },
};
export class CycleEngine {
    agentManager;
    sessionService;
    bridge;
    communication;
    store;
    workspace;
    nudgeRegistry;
    gateRunner;
    activeEngines = new Set();
    /** Tracks running cycle loops so cancel() can await graceful shutdown. */
    loopPromises = new Map();
    // ── Extracted modules ───────────────────────────────────────────
    sessions;
    reporting;
    constructor(agentManager, sessionService, bridge, communication, store, workspace, nudgeRegistry, gateRunner = failClosedGateRunner) {
        this.agentManager = agentManager;
        this.sessionService = sessionService;
        this.bridge = bridge;
        this.communication = communication;
        this.store = store;
        this.workspace = workspace;
        this.nudgeRegistry = nudgeRegistry;
        this.gateRunner = gateRunner;
        this.sessions = new EngineSessionManager(agentManager, sessionService, bridge, communication, store);
        this.reporting = new EngineReporting(sessionService, communication, store, workspace);
    }
    // ─── Public API ────────────────────────────────────────────────────
    async start(planId) {
        const ctx = backgroundCtx();
        const state = this.store.getState(planId);
        if (!state)
            throw new Error(`Plan not found: ${planId}`);
        if (state.status !== 'approved' && state.status !== 'paused') {
            throw new Error(`Plan ${planId} cannot be started (status: ${state.status})`);
        }
        if (this.activeEngines.has(planId)) {
            throw new Error(`Engine already running for plan ${planId}`);
        }
        this.store.updateState(planId, (s) => ({ ...s, status: 'running' }));
        this.resolveTaskReadiness(ctx, planId);
        getMetricsReporter().incr('team_plan_started_total');
        const loopDone = this.cycleLoop(planId)
            .catch(async (err) => {
            logger.error(ctx, `[team-engine] Cycle loop crashed: planId=${planId} err=${String(err)}`);
            getMetricsReporter().incr('team_cycle_crash_total', { phase: 'cycle_loop' });
            // Notify the owner BEFORE flipping to 'failed'. Without this the owner
            // sees `plan-started` then SSE goes silent — only `mavis team plan
            // status` exposes the failure. Sending an explicit notice keeps the
            // owner in the loop even when the cycle loop dies on an unhandled
            // throw (spawn / acquire / transport error during dispatch).
            const crashState = this.store.getState(planId);
            if (crashState) {
                try {
                    await this.reporting.sendToOwner(crashState, `## Engine Crashed\n\n` +
                        `Plan \`${planId}\` aborted in phase \`${crashState.phase}\` (cycle ${crashState.cycle}).\n\n` +
                        `Error: ${String(err)}\n\n` +
                        `The plan has been marked \`failed\`. Use \`mavis team plan status ${planId}\` ` +
                        `for the latest task state, or recreate the plan after addressing the cause.`);
                }
                catch (notifyErr) {
                    logger.warn(ctx, `[team-engine] Failed to notify owner of cycle crash: planId=${planId} err=${String(notifyErr)}`);
                }
            }
            try {
                this.store.updateState(planId, (s) => ({ ...s, status: 'failed' }));
            }
            catch {
                /* plan may already be cancelled/removed */
            }
        })
            .finally(() => {
            this.activeEngines.delete(planId);
            this.loopPromises.delete(planId);
        });
        this.loopPromises.set(planId, loopDone);
    }
    async pause(ctx, planId) {
        const state = this.store.getState(planId);
        if (!state || state.status !== 'running')
            return;
        this.store.updateState(planId, (s) => ({ ...s, status: 'paused' }));
        this.sessions.cancelHandles(planId);
        // Wait for cycle loop to finish before reconciling
        const loop = this.loopPromises.get(planId);
        if (loop)
            await loop;
        // Reconcile task states — engine stopped monitoring, states should reflect disk reality.
        this.reconcileInflightTasks(ctx, planId);
        logger.info(ctx, `[team-engine] Plan paused: planId=${planId}`);
    }
    /** Pause from inside cycleLoop without awaiting the loop's own promise. */
    pauseFromLoop(ctx, planId, reason) {
        const state = this.store.getState(planId);
        if (!state || state.status !== 'running')
            return;
        this.store.updateState(planId, (s) => ({ ...s, status: 'paused' }));
        this.sessions.cancelHandles(planId);
        this.reconcileInflightTasks(ctx, planId);
        logger.info(ctx, `[team-engine] Plan paused from cycle loop: planId=${planId} reason=${reason}`);
    }
    async resume(ctx, planId) {
        const state = this.store.getState(planId);
        if (!state || state.status !== 'paused')
            return;
        // Reconcile task states with on-disk deliverables before restarting
        this.reconcileInflightTasks(ctx, planId);
        // Check for a decision that was queued while the engine was paused.
        // This handles the race where pauseFromLoop() exits the loop before the
        // owner submits a decision — without this, the decision would either be
        // lost or consumed in the wrong cycle after restart.
        const queued = this.reporting.consumePendingDecision(planId);
        if (queued) {
            logger.info(ctx, `[team-engine] Applying queued decision on resume: planId=${planId}`);
            await this.applyDecision(ctx, planId, queued);
            if (queued.plan_complete) {
                logger.info(ctx, `[team-engine] Queued decision declared plan complete — not restarting loop: planId=${planId}`);
                return;
            }
        }
        await this.start(planId);
    }
    async cancel(ctx, planId) {
        // Signal the loop to stop: set status + cancel handles.
        // Idempotent — if the plan is already in a terminal state (cancelled /
        // completed / failed), still cancel running handles (defensive — sessions
        // may be in-flight even when the status flag has been flipped) but skip
        // the status write to avoid clobbering completed/failed terminals.
        const state = this.store.getState(planId);
        if (state && !this.store.isTerminal(state)) {
            this.store.updateState(planId, (s) => ({ ...s, status: 'cancelled' }));
        }
        this.sessions.cancelHandles(planId);
        // Wait for cycle loop to finish, but with timeout to avoid indefinite blocking
        const loop = this.loopPromises.get(planId);
        if (loop) {
            const timeout = new Promise((resolve) => {
                const timer = setTimeout(resolve, 10_000);
                if (typeof timer.unref === 'function')
                    timer.unref();
            });
            await Promise.race([loop, timeout]);
        }
        await this.reporting.archiveEngineSessions(planId);
        this.sessions.clearSessionCache(planId);
        logger.info(ctx, `[team-engine] Plan cancelled: planId=${planId}`);
    }
    extendTaskTimeout(ctx, planId, taskId, extraMs) {
        const handles = this.sessions.getActiveHandles(planId);
        const handle = handles?.get(taskId);
        if (!handle) {
            throw new Error(`Task ${taskId} is not currently running in plan ${planId}`);
        }
        const deadlineAtMs = handle.deadlineAtMs() + extraMs;
        const result = this.store.extendTaskTimeout(planId, taskId, extraMs, deadlineAtMs);
        handle.extendTimeout(extraMs);
        logger.info(ctx, `[team-engine] Task timeout extended: planId=${planId} taskId=${taskId} extraMs=${extraMs}`);
        return result;
    }
    async applyDecision(ctx, planId, decision) {
        const state = this.store.getState(planId);
        if (!state)
            return;
        // 1. Apply last_cycle verdicts
        for (const item of decision.last_cycle) {
            const result = state.results.find((r) => r.task_id === item.task_id);
            if (!result)
                continue;
            if (item.verdict === 'accept' || item.verdict === 'override_accept') {
                if (result.status === 'verifying') {
                    this.transitionTask(ctx, planId, item.task_id, 'done');
                }
                const reason = item.verdict === 'override_accept' ? `[OVERRIDE] ${item.reason}` : item.reason;
                this.store.updateTaskResult(planId, item.task_id, { verdict_summary: reason });
                logger.info(ctx, `[team-engine] Owner accepted task: planId=${planId} taskId=${item.task_id} verdict=${item.verdict}`);
            }
            else if (item.verdict === 'reject' || item.verdict === 'manual_retry') {
                if (result.status === 'verifying') {
                    this.transitionTask(ctx, planId, item.task_id, 'ready');
                }
                const reason = item.verdict === 'manual_retry' ? `[MANUAL RETRY] ${item.reason}` : item.reason;
                this.store.updateTaskResult(planId, item.task_id, {
                    verdict_summary: reason,
                    attempt: (result.attempt ?? 0) + 1,
                });
                logger.info(ctx, `[team-engine] Owner rejected task: planId=${planId} taskId=${item.task_id} reason=${item.reason} verdict=${item.verdict}`);
            }
        }
        // 2. Stage next_cycle tasks — add any new task IDs to plan + results
        const allTasks = this.store.getAllTasks(planId);
        const existingIds = new Set(allTasks.map((t) => t.id));
        for (const next of decision.next_cycle) {
            if (!existingIds.has(next.task_id)) {
                // New task from owner — add to dynamic_tasks
                this.store.addTasks(planId, [
                    {
                        id: next.task_id,
                        title: next.title,
                        prompt: next.prompt,
                        assigned_to: next.assigned_to,
                        verified_by: next.verified_by,
                        verify_skip_reason: next.verify_skip_reason,
                        role: next.role ?? 'produce',
                        depends_on: [],
                        gates: [],
                        max_retries: 2,
                        timeout_ms: next.timeout_ms ?? 15 * 60 * 1000,
                        added_in_cycle: state.cycle,
                    },
                ], state.cycle);
            }
            else {
                // Existing task — update prompt/assignment for this cycle
                // (Owner may have rewritten the prompt based on last cycle's feedback)
                this.store.updateState(planId, (s) => {
                    const dynTask = s.dynamic_tasks.find((t) => t.id === next.task_id);
                    const planTask = this.store.getPlan(planId)?.tasks.find((t) => t.id === next.task_id);
                    const target = dynTask ?? planTask;
                    if (target) {
                        target.prompt = next.prompt;
                        target.assigned_to = next.assigned_to;
                        if (dynTask) {
                            if (next.verified_by !== undefined)
                                dynTask.verified_by = next.verified_by;
                            else
                                delete dynTask.verified_by;
                            if (next.verify_skip_reason !== undefined)
                                dynTask.verify_skip_reason = next.verify_skip_reason;
                            else
                                delete dynTask.verify_skip_reason;
                            dynTask.role = next.role ?? 'produce';
                        }
                        else if (planTask) {
                            const current = s.task_overrides[planTask.id] ?? {};
                            current.verified_by = next.verified_by ?? null;
                            current.verify_skip_reason = next.verify_skip_reason ?? null;
                            current.role = next.role ?? 'produce';
                            s.task_overrides[planTask.id] = current;
                        }
                    }
                    return s;
                });
            }
            // Ensure task is in ready state for next cycle
            const result = this.store.getState(planId)?.results.find((r) => r.task_id === next.task_id);
            if (result && result.status === 'blocked') {
                this.store.updateTaskResult(planId, next.task_id, { status: 'ready' });
            }
        }
        // 3. Relay message to user
        if (decision.message_to_user) {
            await this.reporting.sendToOwner(state, decision.message_to_user);
        }
        // 4. Plan complete
        if (decision.plan_complete) {
            this.store.updateState(planId, (s) => ({ ...s, status: 'completed' }));
            await this.reporting.archiveEngineSessions(planId);
            logger.info(ctx, `[team-engine] Owner declared plan complete: planId=${planId}`);
            getMetricsReporter().incr('team_cycle_completed_total', { result: 'completed' });
        }
    }
    /**
     * Steer all active worker sessions in a plan.
     *
     * 1. Find all sessions tracked in engine_sessions
     * 2. Filter to those currently active (status = 'started')
     * 3. Abort each session (best-effort)
     * 4. Brief delay for abort propagation
     * 5. Send the steering message to each session
     *
     * Returns lists of steered and failed session IDs.
     */
    async steer(ctx, planId, message) {
        const state = this.store.getState(planId);
        if (!state)
            throw new Error(`Plan not found: ${planId}`);
        if (state.status !== 'running') {
            throw new Error(`Plan ${planId} cannot be steered (status: ${state.status}). Only running plans can be steered.`);
        }
        const wrappedMessage = `<user-steering>\n${message}\n</user-steering>\n\n` +
            `The plan owner has changed direction. Stop what you were doing and follow the new instructions above.`;
        const engineSessions = Object.entries(state.engine_sessions);
        if (engineSessions.length === 0) {
            return { steered_sessions: [], failed_sessions: [] };
        }
        // Filter to active sessions
        const activeSessions = [];
        for (const [sessionId, info] of engineSessions) {
            const session = await this.sessionService.getSession(sessionId);
            if (session?.status?.type === 'started') {
                activeSessions.push({ sessionId, agentName: info.agent_name });
            }
        }
        const steered = [];
        const failed = [];
        // Abort all active sessions (best-effort, parallel)
        await Promise.allSettled(activeSessions.map(async ({ sessionId, agentName }) => {
            try {
                await this.sessionService.abortSession(agentName, sessionId);
            }
            catch (err) {
                logger.warn(ctx, `[team-engine] Steer: abort failed (continuing): planId=${planId} sessionId=${sessionId} err=${String(err)}`);
            }
        }));
        // Brief delay for abort propagation
        await new Promise((r) => setTimeout(r, 500));
        // Send steering message to each session
        for (const { sessionId, agentName } of activeSessions) {
            try {
                await this.bridge.sendMessage({ ...ctx, callerSession: state.owner_session_id }, agentName, sessionId, {
                    content: wrappedMessage,
                    fromRole: Role.User,
                    source: 'system',
                });
                steered.push(sessionId);
                logger.info(ctx, `[team-engine] Steer: message sent: planId=${planId} sessionId=${sessionId}`);
            }
            catch (err) {
                logger.warn(ctx, `[team-engine] Steer: send failed: planId=${planId} sessionId=${sessionId} err=${String(err)}`);
                failed.push(sessionId);
            }
        }
        logger.info(ctx, `[team-engine] Steer completed: planId=${planId} steered=${steered.length} failed=${failed.length}`);
        return { steered_sessions: steered, failed_sessions: failed };
    }
    async recoverOnStartup() {
        const ctx = backgroundCtx();
        const toResume = [];
        for (const state of this.store.listAll()) {
            if (state.status === 'running') {
                // Crash recovery: was running when daemon died
                this.store.updateState(state.plan_id, (s) => ({ ...s, status: 'paused' }));
                this.reconcileInflightTasks(ctx, state.plan_id);
                toResume.push(state.plan_id);
                logger.info(ctx, `[team-engine] Recovered: running → paused: planId=${state.plan_id}`);
            }
            else if (state.status === 'paused') {
                // Check for plans left paused by a previous crash recovery that never auto-resumed.
                // Signal: paused plan with tasks still in producing/verifying = interrupted work.
                const hasInflight = state.results.some((r) => r.status === 'producing' || r.status === 'verifying');
                if (hasInflight) {
                    this.reconcileInflightTasks(ctx, state.plan_id);
                    toResume.push(state.plan_id);
                    logger.info(ctx, `[team-engine] Recovered interrupted paused plan: planId=${state.plan_id}`);
                }
            }
        }
        // Auto-resume: recovered plans continue running after daemon restart
        for (const planId of toResume) {
            logger.info(ctx, `[team-engine] Auto-resuming recovered plan: planId=${planId}`);
            this.start(planId).catch((err) => {
                logger.error(ctx, `[team-engine] Failed to auto-resume plan: planId=${planId} err=${String(err)}`);
            });
        }
    }
    /**
     * Reconcile in-flight task states with on-disk deliverables.
     *
     * Principle: all in-memory state must be recoverable from the plan folder.
     * The deliverable.md file is the ground-truth completion signal for production.
     * verifier_results in state.json is the ground-truth for verification.
     *
     * Called by both recoverOnStartup (daemon restart) and resume (user action).
     */
    reconcileInflightTasks(ctx, planId) {
        const state = this.store.getState(planId);
        if (!state)
            return;
        // Check deliverables BEFORE entering updateState (filesystem I/O outside lock)
        // Use mtime comparison with started_at to detect stale deliverables from rejected attempts
        const currentDeliverables = new Map();
        for (const r of state.results) {
            if (r.status === 'producing' || r.status === 'verifying') {
                currentDeliverables.set(r.task_id, this.workspace.hasCurrentDeliverable(planId, r.task_id, r.started_at));
            }
        }
        this.store.updateState(planId, (s) => {
            for (const r of s.results) {
                if (r.status === 'producing') {
                    if (currentDeliverables.get(r.task_id)) {
                        // Current-attempt deliverable exists — production complete
                        // runVerificationPhase will pick this up
                        if (!r.finished_at)
                            r.finished_at = Date.now();
                    }
                    else {
                        // No deliverable (or stale from previous attempt) — reset for retry
                        r.status = 'ready';
                    }
                }
                else if (r.status === 'verifying') {
                    if (r.verifier_results.length > 0) {
                        // Verification complete — keep (awaiting owner verdict)
                    }
                    else if (currentDeliverables.get(r.task_id)) {
                        // Has current deliverable but no verification — redo verification only
                        r.status = 'producing';
                        if (!r.finished_at)
                            r.finished_at = Date.now();
                    }
                    else {
                        // No current deliverable AND no verification — redo everything
                        r.status = 'ready';
                    }
                }
            }
            return s;
        });
        logger.info(ctx, `[team-engine] Reconciled in-flight tasks with deliverables: planId=${planId}`);
    }
    async shutdown() {
        const ctx = backgroundCtx();
        for (const state of this.store.listAll()) {
            if (state.status === 'running')
                await this.pause(ctx, state.plan_id);
        }
    }
    /**
     * Check if a session is managed by any active team plan (running or paused).
     * Used to skip duplicate notifications — the engine already handles worker completion.
     */
    isEngineSession(sessionId) {
        for (const state of this.store.listAll()) {
            if (state.status !== 'running' && state.status !== 'paused')
                continue;
            if (sessionId in state.engine_sessions)
                return true;
        }
        return false;
    }
    /**
     * Called by API when owner submits a decision via `mavis team decision`.
     * Delegates to EngineReporting but passes activeEngines for loop detection.
     * If the plan is paused and no active engine loop exists, auto-resumes the plan
     * so the queued decision is applied immediately.
     */
    submitDecision(planId, decision) {
        this.reporting.submitDecision(planId, decision, this.activeEngines);
        // Auto-resume: if the engine loop is not active (plan was paused), resume
        // so the queued decision gets consumed and applied immediately.
        if (!this.activeEngines.has(planId)) {
            const state = this.store.getState(planId);
            if (state?.status === 'paused') {
                const ctx = backgroundCtx();
                logger.info(ctx, `[team-engine] Auto-resuming paused plan after decision submission: planId=${planId}`);
                // Fire-and-forget — resume will consume the queued decision
                this.resume(ctx, planId).catch((err) => {
                    logger.error(ctx, `[team-engine] Auto-resume failed: planId=${planId} err=${String(err)}`);
                });
            }
        }
    }
    // ─── Core Cycle Loop ──────────────────────────────────────────────
    async cycleLoop(planId) {
        const ctx = backgroundCtx();
        this.activeEngines.add(planId);
        logger.info(ctx, `[team-engine] Cycle loop started: planId=${planId}`);
        try {
            const initState = this.store.getState(planId);
            const initPlan = this.store.getPlan(planId);
            // ── Notify owner session that engine is starting ────────────────
            const taskSummary = initPlan.tasks
                .map((t) => `- ${t.title} (${t.assigned_to ?? 'unassigned'} → ${t.verified_by})`)
                .join('\n');
            await this.reporting.sendToOwner(initState, `## Plan "${initPlan.plan.name}" engine started\n\n` +
                `Plan ID: ${planId}\n` +
                `Total tasks: ${initPlan.tasks.length}\n` +
                `Max concurrency: ${initPlan.plan.max_concurrency}\n\n` +
                `### Task list\n${taskSummary}\n\n` +
                `Engine will schedule by dependency order. A progress report is emitted at the end of every cycle.`);
            // First cycle: batch from plan's ready tasks
            let nextBatchTasks = null;
            while (true) {
                const state = this.store.getState(planId);
                if (!state || state.status !== 'running')
                    break;
                const plan = this.store.getPlan(planId);
                if (!plan)
                    break;
                if (state.cycle >= plan.plan.max_cycles) {
                    this.pauseFromLoop(ctx, planId, 'max cycles reached');
                    await this.reporting.sendToOwner(state, 'Engine auto-paused: max cycles reached.');
                    break;
                }
                // ── Phase 1: Determine batch ────────────────────────────────
                this.store.updateState(planId, (s) => ({ ...s, phase: 'determining' }));
                let batch;
                if (nextBatchTasks) {
                    // Cycle 2+: owner told us exactly what to run
                    batch = nextBatchTasks;
                    nextBatchTasks = null;
                }
                else {
                    // Cycle 1: derive from plan
                    this.resolveTaskReadiness(ctx, planId);
                    batch = this.determineBatch(planId, plan);
                }
                if (batch.length === 0) {
                    const cur = this.store.getState(planId);
                    const allDone = cur.results.every((r) => r.status === 'done');
                    if (allDone) {
                        // All tasks accepted — send final report and wait for owner to declare plan_complete
                        const report = this.reporting.buildCycleReport(planId, plan, cur);
                        report.board_blockers = await this.reporting.collectBoardBlockers(cur);
                        const reportText = formatCycleReport(report, true);
                        const decision = await this.reporting.sendReportAndWaitForDecision(cur, reportText, {
                            promptContext: 'plan-completion-ready',
                        });
                        if (decision) {
                            await this.applyDecision(ctx, planId, decision);
                            if (decision.plan_complete)
                                break;
                            // Owner added next_cycle tasks — continue the loop to schedule them
                            if (decision.next_cycle.length > 0) {
                                const allTasks = this.store.getAllTasks(planId);
                                nextBatchTasks = decision.next_cycle.map((nc) => {
                                    const existing = allTasks.find((t) => t.id === nc.task_id);
                                    return (existing ?? {
                                        id: nc.task_id,
                                        title: nc.title,
                                        prompt: nc.prompt,
                                        assigned_to: nc.assigned_to,
                                        verified_by: nc.verified_by,
                                        verify_skip_reason: nc.verify_skip_reason,
                                        role: nc.role ?? 'produce',
                                        depends_on: [],
                                        gates: [],
                                        max_retries: 2,
                                        timeout_ms: nc.timeout_ms ?? 15 * 60 * 1000,
                                    });
                                });
                                continue;
                            }
                            // Empty decision — loop back to re-send the final report and wait for a proper decision.
                            continue;
                        }
                        else {
                            // null return — check if plan status changed (cancel/pause) vs true timeout
                            const currentState = this.store.getState(planId);
                            if (currentState && currentState.status !== 'running') {
                                logger.info(ctx, `[team-engine] Plan status changed during final report wait — exiting: planId=${planId} status=${currentState.status}`);
                                break;
                            }
                            // Owner truly unresponsive on final report — auto-complete
                            this.store.updateState(planId, (s) => ({ ...s, status: 'completed' }));
                            await this.reporting.archiveEngineSessions(planId);
                            logger.info(ctx, `[team-engine] All tasks done, owner unresponsive — auto-completed: planId=${planId}`);
                            break;
                        }
                    }
                    // Check for completed work that needs processing (verification or owner verdict)
                    const hasFinishedProduction = cur.results.some((r) => r.status === 'producing' && r.finished_at);
                    const hasPendingVerdict = cur.results.some((r) => r.status === 'verifying');
                    if (!hasFinishedProduction && !hasPendingVerdict) {
                        const hasActive = cur.results.some((r) => r.status === 'producing' || r.status === 'verifying');
                        if (!hasActive) {
                            await this.reporting.sendToOwner(cur, 'DEADLOCK: No tasks to execute. Submit a decision with next_cycle tasks.');
                            this.pauseFromLoop(ctx, planId, 'deadlock no executable tasks');
                            break;
                        }
                        // Active tasks running but no new batch — wait before checking again
                        await new Promise((r) => setTimeout(r, 10_000));
                        continue;
                    }
                    // Fall through to process completed work (Phase 3/4)
                }
                // ── Phase 2: Produce ────────────────────────────────────────
                let cycleStartedAt = Date.now();
                if (batch.length > 0) {
                    // Only increment cycle when we actually have work to do
                    this.store.updateState(planId, (s) => ({ ...s, cycle: s.cycle + 1, phase: 'producing' }));
                    cycleStartedAt = Date.now();
                    await runProductionPhase(planId, batch, plan, {
                        store: this.store,
                        communication: this.communication,
                        sessions: this.sessions,
                        reporting: this.reporting,
                        workspace: this.workspace,
                        transitionTask: this.transitionTask.bind(this),
                        sessionService: this.sessionService,
                        nudgeRegistry: this.nudgeRegistry,
                    });
                    if (this.store.getState(planId)?.status !== 'running')
                        break;
                }
                // ── Phase 3: Verify ─────────────────────────────────────────
                this.store.updateState(planId, (s) => ({ ...s, phase: 'verifying' }));
                await runVerificationPhase(planId, plan, {
                    store: this.store,
                    communication: this.communication,
                    // sessionLifecycle is REQUIRED — verifier completion needs the
                    // archon-server `GetSessionMessages` fallback to survive cross-pod
                    // sandbox topologies where `InProcessSessionBridge` cannot reach
                    // the worker. See VerificationDeps doc + engine-verification.ts
                    // `waitForVerdictViaPolling`.
                    sessionLifecycle: this.sessionService,
                    sessions: this.sessions,
                    reporting: this.reporting,
                    workspace: this.workspace,
                    gateRunner: this.gateRunner,
                    transitionTask: this.transitionTask.bind(this),
                });
                // ── Phase 4: Evaluate — send report, WAIT for owner decision ──
                this.store.updateState(planId, (s) => ({ ...s, phase: 'evaluating' }));
                const finalState = this.store.getState(planId);
                const report = this.reporting.buildCycleReport(planId, plan, finalState);
                // Collect blocker entries from plan board
                report.board_blockers = await this.reporting.collectBoardBlockers(finalState);
                // Consecutive failure tracking — only count cycles where verifiers actually rejected tasks.
                const newlyVerified = report.awaiting_verdict.length;
                const anyVerifierFailed = report.awaiting_verdict.some((t) => t.verifier_results.some((v) => !v.passed));
                if (report.done.length === 0 && newlyVerified > 0 && anyVerifierFailed) {
                    const n = finalState.consecutive_failures + 1;
                    this.store.updateState(planId, (s) => ({ ...s, consecutive_failures: n }));
                    if (n >= plan.plan.max_consecutive_failures) {
                        this.pauseFromLoop(ctx, planId, 'max consecutive verifier failures');
                        await this.reporting.sendToOwner(finalState, `AUTO-PAUSED: ${n} cycles with zero passes.`);
                        break;
                    }
                }
                else if (report.done.length > 0 || (newlyVerified > 0 && !anyVerifierFailed)) {
                    // Reset when tasks completed or when all verified tasks passed
                    this.store.updateState(planId, (s) => ({ ...s, consecutive_failures: 0 }));
                }
                // Memory write for done tasks
                for (const d of report.done) {
                    await this.reporting.triggerMemoryWrite(planId, d.task_id);
                }
                // Send report to owner and BLOCK until owner submits decision via CLI
                const reportText = formatCycleReport(report, false);
                // ── auto_accept: skip owner wait when all verifiers pass, or when
                //    this cycle only completed explicitly verify-skipped tasks.
                const allVerifiersPassed = report.awaiting_verdict.length > 0 &&
                    report.awaiting_verdict.every((t) => t.verifier_results.length > 0 && t.verifier_results.every((v) => v.passed));
                const hasPendingOwnerVerdicts = report.awaiting_verdict.length > 0;
                const completedThisCycle = report.done.filter((d) => {
                    const r = finalState.results.find((item) => item.task_id === d.task_id);
                    return r?.finished_at !== undefined && r.finished_at >= cycleStartedAt;
                });
                const autoContinuableSkippedTasks = completedThisCycle.filter((d) => {
                    const r = finalState.results.find((item) => item.task_id === d.task_id);
                    return r ? isVerifySkippedTaskAutoContinuable(r) : false;
                });
                const allCompletedThisCycleAutoContinuable = completedThisCycle.length > 0 &&
                    autoContinuableSkippedTasks.length === completedThisCycle.length &&
                    !hasPendingOwnerVerdicts;
                // ── Detect verifier failures for arbitration ──
                const failedTasks = report.awaiting_verdict.filter((t) => t.verifier_results.some((v) => !v.passed));
                const hasVerifierFailures = failedTasks.length > 0;
                // ── auto_reject_retries: split failures by retry budget ──
                const autoRejectThreshold = plan.plan.auto_reject_retries ?? 0;
                const failedUnderThreshold = failedTasks.filter((t) => t.attempt <= autoRejectThreshold);
                const failedOverThreshold = failedTasks.filter((t) => t.attempt > autoRejectThreshold);
                const passedTasks = report.awaiting_verdict.filter((t) => t.verifier_results.length > 0 && t.verifier_results.every((v) => v.passed));
                const allFailuresAutoRejectable = autoRejectThreshold > 0 && hasVerifierFailures && failedOverThreshold.length === 0;
                const allPassedAutoAcceptable = passedTasks.length === 0 || plan.plan.auto_accept;
                let decision;
                if (allFailuresAutoRejectable &&
                    allPassedAutoAcceptable &&
                    report.awaiting_verdict.length > 0) {
                    logger.info(ctx, `[team-engine] auto_reject_retries: cycle fully auto-decided, skipping owner: planId=${planId} cycle=${finalState.cycle} autoRejected=${failedUnderThreshold.length} autoAccepted=${passedTasks.length} threshold=${autoRejectThreshold}`);
                    const autoRejectDecisions = failedUnderThreshold.map((t) => ({
                        task_id: t.task_id,
                        verdict: 'reject',
                        reason: this.buildAutoRejectReason(t.task_id, planId, t.attempt, autoRejectThreshold, t.verifier_results),
                    }));
                    const autoAcceptDecisions = passedTasks.map((t) => ({
                        task_id: t.task_id,
                        verdict: 'accept',
                        reason: 'Auto-accepted: all verifiers passed.',
                    }));
                    // Notify owner (fire-and-forget, non-blocking)
                    this.reporting
                        .sendToOwner(finalState, `[AUTO-REJECT] Cycle ${finalState.cycle}: ${failedUnderThreshold.length} task(s) failed verification (attempt ≤ ${autoRejectThreshold}), auto-rejected back to producer.${passedTasks.length > 0 ? ` ${passedTasks.length} task(s) auto-accepted.` : ''}\n${reportText}`)
                        .catch(() => {
                        /* non-critical */
                    });
                    decision = {
                        last_cycle: [...autoAcceptDecisions, ...autoRejectDecisions],
                        next_cycle: [],
                        plan_complete: false,
                    };
                }
                else if (plan.plan.auto_accept && allCompletedThisCycleAutoContinuable) {
                    logger.info(ctx, `[team-engine] auto_accept: verify-skipped task(s) completed, continuing without owner: planId=${planId} cycle=${finalState.cycle} count=${autoContinuableSkippedTasks.length}`);
                    decision = {
                        last_cycle: [],
                        next_cycle: [],
                        plan_complete: false,
                    };
                    this.reporting
                        .sendToOwner(finalState, `[AUTO-CONTINUE] Cycle ${finalState.cycle}: ${autoContinuableSkippedTasks.length} verify-skipped task(s) completed; continuing to dependent tasks.\n${reportText}`)
                        .catch(() => {
                        /* non-critical */
                    });
                }
                else if (plan.plan.auto_accept && allVerifiersPassed) {
                    logger.info(ctx, `[team-engine] auto_accept: all verifiers passed, accepting without owner: planId=${planId} cycle=${finalState.cycle}`);
                    // Check if accepting these tasks would complete the plan
                    const acceptedIds = new Set(report.awaiting_verdict.map((t) => t.task_id));
                    const postAcceptState = this.store.getState(planId);
                    const allDone = postAcceptState.results.every((r) => r.status === 'done' || acceptedIds.has(r.task_id));
                    decision = {
                        last_cycle: report.awaiting_verdict.map((t) => ({
                            task_id: t.task_id,
                            verdict: 'accept',
                            reason: 'Auto-accepted: all verifiers passed.',
                        })),
                        next_cycle: [],
                        plan_complete: allDone,
                    };
                    // Notify owner (fire-and-forget, non-blocking)
                    this.reporting
                        .sendToOwner(finalState, `[AUTO-ACCEPT] Cycle ${finalState.cycle}:\n${reportText}`, allDone ? { promptContext: 'plan-completion-ready' } : undefined)
                        .catch(() => {
                        /* non-critical */
                    });
                }
                else if (plan.plan.auto_accept && hasVerifierFailures) {
                    // ── Arbitration: verifier rejected, ask owner for 90s ──
                    const arbitrationTargets = autoRejectThreshold > 0 ? failedOverThreshold : failedTasks;
                    logger.info(ctx, `[team-engine] Verifier reject detected — triggering arbitration: planId=${planId} cycle=${finalState.cycle} failedCount=${failedTasks.length} arbitrationCount=${arbitrationTargets.length} autoRejectCount=${failedUnderThreshold.length} threshold=${autoRejectThreshold}`);
                    const autoAcceptDecisions = passedTasks.map((t) => ({
                        task_id: t.task_id,
                        verdict: 'accept',
                        reason: 'Auto-accepted: all verifiers passed.',
                    }));
                    const autoRejectDecisions = autoRejectThreshold > 0
                        ? failedUnderThreshold.map((t) => ({
                            task_id: t.task_id,
                            verdict: 'reject',
                            reason: this.buildAutoRejectReason(t.task_id, planId, t.attempt, autoRejectThreshold, t.verifier_results),
                        }))
                        : [];
                    let arbitrationDecision;
                    if (arbitrationTargets.length > 0) {
                        arbitrationDecision = await this.reporting.sendArbitrationRequest(finalState, arbitrationTargets);
                    }
                    else {
                        arbitrationDecision = { last_cycle: [], next_cycle: [], plan_complete: false };
                    }
                    // Merge: auto-accept passed + auto-reject under-threshold + arbitration result for over-threshold
                    decision = {
                        last_cycle: [
                            ...autoAcceptDecisions,
                            ...autoRejectDecisions,
                            ...arbitrationDecision.last_cycle,
                        ],
                        next_cycle: arbitrationDecision.next_cycle,
                        plan_complete: arbitrationDecision.plan_complete,
                    };
                    // Notify owner about the auto-handled portions
                    const notes = [];
                    if (passedTasks.length > 0) {
                        notes.push(`${passedTasks.length} task(s) passed verification and were auto-accepted.`);
                    }
                    if (autoRejectDecisions.length > 0) {
                        notes.push(`${autoRejectDecisions.length} task(s) failed verification (attempt ≤ ${autoRejectThreshold}) and were auto-rejected back to producer.`);
                    }
                    if (notes.length > 0) {
                        this.reporting.sendToOwner(finalState, `[AUTO] ${notes.join(' ')}`).catch(() => {
                            /* non-critical */
                        });
                    }
                }
                else {
                    decision = await this.reporting.sendReportAndWaitForDecision(finalState, reportText);
                }
                if (!decision) {
                    // null return — check if plan status changed (cancel/pause) vs true timeout
                    const currentState = this.store.getState(planId);
                    if (currentState && currentState.status !== 'running') {
                        logger.info(ctx, `[team-engine] Plan status changed during decision wait — exiting: planId=${planId} status=${currentState.status}`);
                        break;
                    }
                    logger.warn(ctx, `[team-engine] Owner did not respond, pausing: planId=${planId}`);
                    this.pauseFromLoop(ctx, planId, 'owner unresponsive');
                    await this.reporting.sendToOwner(finalState, 'Plan paused: owner unresponsive.');
                    break;
                }
                // Apply decision (verdicts + stage next tasks)
                await this.applyDecision(ctx, planId, decision);
                if (decision.plan_complete)
                    break;
                // Owner's next_cycle becomes the batch for next iteration
                if (decision.next_cycle.length > 0) {
                    const allTasks = this.store.getAllTasks(planId);
                    nextBatchTasks = decision.next_cycle.map((nc) => {
                        const existing = allTasks.find((t) => t.id === nc.task_id);
                        return (existing ?? {
                            id: nc.task_id,
                            title: nc.title,
                            prompt: nc.prompt,
                            assigned_to: nc.assigned_to,
                            verified_by: nc.verified_by,
                            verify_skip_reason: nc.verify_skip_reason,
                            role: nc.role ?? 'produce',
                            depends_on: [],
                            gates: [],
                            max_retries: 2,
                            timeout_ms: nc.timeout_ms ?? 15 * 60 * 1000,
                        });
                    });
                }
            }
        }
        finally {
            // Safety net: if loop exits while status is still 'running', transition to 'paused'
            // to prevent zombie state (running status with no active loop).
            const exitState = this.store.getState(planId);
            if (exitState?.status === 'running') {
                this.store.updateState(planId, (s) => ({ ...s, status: 'paused' }));
                logger.warn(ctx, `[team-engine] Cycle loop exited while status was running — auto-paused to prevent zombie state: planId=${planId}`);
            }
            this.activeEngines.delete(planId);
            logger.info(ctx, `[team-engine] Cycle loop ended: planId=${planId}`);
        }
    }
    // ─── Task Scheduling ──────────────────────────────────────────────
    resolveTaskReadiness(ctx, planId) {
        void ctx; // keeps RequestContext import semantically explicit
        this.store.updateState(planId, (state) => {
            const allTasks = [...(this.store.getPlan(planId)?.tasks ?? []), ...state.dynamic_tasks];
            for (const result of state.results) {
                if (result.status !== 'blocked')
                    continue;
                const task = allTasks.find((t) => t.id === result.task_id);
                if (!task)
                    continue;
                const depsOk = task.depends_on.length === 0 ||
                    task.depends_on.every((depId) => {
                        const dep = state.results.find((r) => r.task_id === depId);
                        return dep?.status === 'done';
                    });
                if (depsOk)
                    result.status = 'ready';
            }
            return state;
        });
    }
    determineBatch(planId, plan) {
        const state = this.store.getState(planId);
        if (!state)
            return [];
        const allTasks = this.store.getAllTasks(planId);
        const readyIds = state.results.filter((r) => r.status === 'ready').map((r) => r.task_id);
        const activeCount = state.results.filter((r) => r.status === 'producing' || r.status === 'verifying').length;
        const slots = plan.plan.max_concurrency - activeCount;
        if (slots <= 0)
            return [];
        const batch = [];
        for (const id of readyIds) {
            if (batch.length >= slots)
                break;
            const task = allTasks.find((t) => t.id === id);
            if (task && task.assigned_to)
                batch.push(task);
        }
        return batch;
    }
    transitionTask(ctx, planId, taskId, to) {
        void ctx;
        const state = this.store.getState(planId);
        if (!state)
            return;
        const result = state.results.find((r) => r.task_id === taskId);
        if (!result)
            return;
        assertValidTaskTransition(result.status, to, taskId);
        this.store.updateTaskResult(planId, taskId, { status: to });
    }
    // ─── Auto-reject reason builder ───────────────────────────────────
    /**
     * Build the `reason` string for an auto-reject decision.
     *
     * Policy:
     *   - Full verifier feedback (no truncation) is always included.
     *   - If the full feedback exceeds 10 KB, it is written to a per-attempt
     *     file under the task's output directory and the reason instructs the
     *     producer to read that file instead of inlining the content.
     *
     * File path (when offloaded):
     *   <plansDir>/<planId>/outputs/<taskId>/verifier-feedback-attempt-<N>.md
     */
    buildAutoRejectReason(taskId, planId, attempt, autoRejectThreshold, verifierResults) {
        const prefix = `[AUTO-REJECT attempt ${attempt}/${autoRejectThreshold}]`;
        const fullFeedback = verifierResults
            .filter((v) => !v.passed)
            .map((v) => `### ${v.agent}\n\n${v.summary}`)
            .join('\n\n---\n\n');
        const OFFLOAD_THRESHOLD = 10 * 1024; // 10 KB
        if (Buffer.byteLength(fullFeedback, 'utf8') > OFFLOAD_THRESHOLD) {
            const feedbackFile = this.workspace.writeVerifierFeedback(planId, taskId, attempt, `# Verifier Feedback — Attempt ${attempt}\n\nTask: ${taskId}\n\n---\n\n${fullFeedback}`);
            return (`${prefix} Verifier feedback exceeds 10 KB and has been written to a file.\n` +
                `Read this file for the full feedback before retrying:\n  ${feedbackFile}`);
        }
        // Inline: single-line per verifier for compact verdict_summary
        const inlineFeedback = verifierResults
            .filter((v) => !v.passed)
            .map((v) => `${v.agent}: ${v.summary}`)
            .join(' | ');
        return `${prefix} ${inlineFeedback}`;
    }
}
//# sourceMappingURL=engine.js.map