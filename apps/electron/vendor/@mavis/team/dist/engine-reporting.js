/**
 * EngineReporting — owner communication and reporting for the CycleEngine.
 *
 * Handles: decision queue, report sending, memory triggers, session archival.
 */
import { backgroundCtx, logger } from './host-utils.js';
import { createEngineMessenger, sendError, sendFailed, } from './engine-communication.js';
const DEFAULT_ENGINE_OWNER_MESSAGE_TYPE = 'team-engine-notice';
function describeEngineSignal(type) {
    switch (type) {
        case 'team-heartbeat':
        case 'team-board-status':
        case 'team-engine-notice':
            return 'progress signal — heartbeat, board update, or worker lifecycle';
        case 'cycle-report':
            return 'cycle report — tasks awaiting your accept/retry decision';
        case 'arbitration-request':
            return 'arbitration request — verifier rejected; you pick override_accept or manual_retry';
        case 'arbitration-timeout':
            return 'arbitration timeout — engine already auto-retried; informational';
    }
}
function planCompletionOwnerReminder(type) {
    return [
        `This message is from the Team Engine (${describeEngineSignal(type)}).`,
        '',
        'Final completion checkpoint: all known tasks are done.',
        'Do not treat this as routine progress/noise.',
        'Follow the requested output/decision format in the engine message.',
        'Report to the user in language they can understand, without engine internals, raw payloads, ids, commands, or XML.',
    ].join('\n');
}
function engineOwnerReminder(type, context = 'default') {
    if (context === 'plan-completion-ready')
        return planCompletionOwnerReminder(type);
    return [
        `This message is from the Team Engine (${describeEngineSignal(type)}).`,
        '',
        'You are the team lead the user hired. They want clear, human progress updates at meaningful checkpoints — not a play-by-play of internal team mechanics.',
        '',
        'If the engine message asks for an action (for example a decision, retry, cancel, or timeout extension), perform that action first with the appropriate tool. Then, if you need to say anything to the user, use the lowest suitable communication channel below.',
        '',
        'Communication channel guide:',
        '  (a) one user-facing alert — ONLY for an important milestone, a clear conclusion, or a decision the user must make. This is the loudest channel: it shows in the chat panel AND lights up the sidebar unread badge so the user looks. Bar is HIGH. Lead with what shipped, say what is next. Short.',
        '  (b) one <mavis-progress>...</mavis-progress> block — for meaningful intermediate progress the user can SEE if they look but should NOT be alerted on. Examples: a sub-module finishing, tests starting, ETA estimate. Visible in the chat panel, NO unread badge. Lower bar than (a) — use this freely instead of staying silent for 30 minutes. This is the channel you reach for when there is real movement worth showing but it is not yet a milestone the user must drop everything for.',
        '  (c) one <mavis-thinking>...</mavis-thinking> block — for process noise (heartbeats, repeated board status, worker still running, last update already covered it) AND owner-internal decisions (accepting/retrying a task, picking override_accept vs manual_retry, arbitration timeouts, sending a nudge, deciding to wait another tick). Folded in the UI: NOT shown as a chat message, NEVER alerts. Safe default for anything truly internal.',
        '',
        'Pick the LOWEST channel that still does the job:',
        '  - alert (a) only when the user must look NOW',
        '  - progress (b) when there is real movement worth showing but no decision needed',
        '  - thinking (c) when nothing has actually changed for the user',
        '',
        'These channels govern HOW you speak to the user, not whether you should perform required engine actions. Engine messages arrive as user prompts; the model must respond, and tool calls are allowed when the engine message requires work. (b) and (c) are both "no alert" channels — pick (b) when there is something to show, (c) when there is nothing.',
        '',
        'Nothing else: no quoted engine payload, no other tags. Only <mavis-thinking> and <mavis-progress> are recognized by the UI.',
        '',
        'Tag content rules (apply to BOTH <mavis-thinking> and <mavis-progress>):',
        "  - One or two short sentences in plain language, written from the user's perspective.",
        '  - This is a public UI note, NOT chain-of-thought, NOT a status dump.',
        '  - No plan ids, session ids, raw payloads, internal commands, or XML.',
        '  - <mavis-progress> content IS visible to the user (only the tag name is stripped on render); write it as if the user will read it.',
        '',
        'User-facing alert (a) bar is HIGH — most engine signals do NOT meet it; when in doubt prefer (b) progress or (c) thinking:',
        '  - Language: match the language the user is using in this session.',
        '  - Voice: speak as the team lead, briefing the user as a peer. Warm, direct, human. Lead with the conclusion, then say what you are doing next. Skip filler like "I have completed", "Here is the detailed explanation", "确保质量", "问题都已修复". Short is better than thorough.',
        '  - Translate ALL internal mechanics into business language. The user does not know — and should not need to know — these internal terms. Do NOT use any of them in user-facing text: producer, verifier, code-reviewer, tester, reviewer agent, round-N, attempt-N, cycle-N, PASS, FAIL, accept, retry, override, override_accept, manual_retry, next_cycle, deliverable, engine, board, heartbeat, nudge, standby, "撤了", "撤", agent role names like daemon-cli/ui/integration-and-docs. Map them to what the user actually cares about: which module, what got done, what comes next.',
        '  - Bad → "UI code-reviewer round-2 PASS, 等 tester round-2"',
        '    Good → "UI 模块的代码审查过了，问题修好，进测试。"',
        '  - Bad → "Daemon producer touch deliverable 撤了，等 engine 复核"',
        '    Good → (use (c) <mavis-thinking> — pure internal owner mechanics, not for the user)',
        '  - Bad → "UI 任务已完成提交，进入 verifier 阶段；daemon 还在补集成测试。"  (alert)',
        '    Good → "<mavis-progress>UI 模块开发完成，我接下来安排 Code Review 和测试。</mavis-progress>"  (intermediate — show but do not alert; daemon is still in flight)',
        '  - Do not list test counts, file paths, commit hashes, attempt numbers, branch names, or other engineering minutiae unless the user explicitly asked for them.',
        '  - Do NOT repeat. If you already told the user the same milestone in the last few minutes, use (c) <mavis-thinking>. Two near-identical user-facing alerts within a single milestone is a bug.',
        '  - Never expose plan ids, session ids, raw payloads, internal commands, or XML tags.',
        '',
        'Examples (中文):',
        '  process noise / owner-only → <mavis-thinking>心跳，进度正常，没有需要你决策的事。</mavis-thinking>',
        '  owner-only decision → <mavis-thinking>评审打回了 X 任务，我让开发那边重做，先不打扰你。</mavis-thinking>',
        '  intermediate progress → <mavis-progress>UI 模块开发完成，进 Code Review 和测试。</mavis-progress>',
        '  intermediate progress → <mavis-progress>测试在跑，预计 5 分钟出结果。</mavis-progress>',
        '  real milestone alert → 整个任务做完了：UI、daemon、测试都过。MR 已合入 dev，你可以接着安排下一件事。',
        '  real conclusion alert → 测试发现一个真问题：UI 漏传了 isBuiltin 字段。我已经让开发那边修，会盯到合入，你先忙别的。',
        '',
        'Examples (English):',
        '  process noise → <mavis-thinking>Heartbeat noted. Nothing for you to do.</mavis-thinking>',
        "  owner-only decision → <mavis-thinking>Reviewer pushed X back. I'm sending it to the dev to redo — no need to bug you yet.</mavis-thinking>",
        '  intermediate progress → <mavis-progress>UI is done. Sending it to Code Review and tests next.</mavis-progress>',
        '  intermediate progress → <mavis-progress>Tests are running — about 5 minutes to results.</mavis-progress>',
        '  real milestone alert → All three modules are done — UI, daemon, tests pass. MR is merged into dev. You can pick the next thing.',
        "  real conclusion alert → Tests caught a real bug: UI was dropping isBuiltin. Sent it back to dev and I'll see it through. You don't need to track this one.",
        '',
        'Use the dedicated `team` tool when you need the plan/decision schema or team commands.',
    ].join('\n');
}
export class EngineReporting {
    sessionService;
    communication;
    store;
    workspace;
    pendingDecisions = new Map();
    constructor(sessionService, communication, store, workspace) {
        this.sessionService = sessionService;
        this.communication = communication;
        this.store = store;
        this.workspace = workspace;
    }
    /**
     * Send CycleReport to owner and wait for owner to submit a Decision via CLI.
     * Retries up to 3 times with 5-minute intervals.
     * Returns null if owner never responds (triggers pause).
     */
    async sendReportAndWaitForDecision(state, reportText, options = {}) {
        const ctx = backgroundCtx();
        const maxRetries = 3;
        const waitMs = 5 * 60 * 1000; // 5 minutes per attempt
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            // Send (or re-send) report to owner
            try {
                const content = attempt === 1
                    ? reportText
                    : `[REMINDER ${attempt}/${maxRetries}] Still waiting for your decision.\n\n${reportText}`;
                const result = await this.sendWrappedOwnerPrompt(state, content, {
                    ...options,
                    type: 'cycle-report',
                });
                if (sendFailed(result)) {
                    logger.error(ctx, `[team-engine] Failed to send report to owner: err=${sendError(result)} attempt=${attempt}`);
                }
            }
            catch (err) {
                logger.error(ctx, `[team-engine] Failed to send report to owner: err=${String(err)} attempt=${attempt}`);
            }
            // Poll for decision (owner submits via CLI → stored in pendingDecisions)
            const deadline = Date.now() + waitMs;
            while (Date.now() < deadline) {
                // Check if plan status changed (cancel/pause/complete) — exit immediately
                const currentState = this.store.getState(state.plan_id);
                if (!currentState || currentState.status !== 'running') {
                    logger.info(ctx, `[team-engine] Plan status changed during decision wait — exiting: planId=${state.plan_id} status=${currentState?.status ?? 'deleted'}`);
                    return null;
                }
                const decision = this.pendingDecisions.get(state.plan_id);
                if (decision) {
                    this.pendingDecisions.delete(state.plan_id);
                    logger.info(ctx, `[team-engine] Owner decision received: planId=${state.plan_id} attempt=${attempt}`);
                    return decision;
                }
                await sleep(3000); // poll every 3 seconds
            }
            logger.warn(ctx, `[team-engine] Owner did not respond, retrying: planId=${state.plan_id} attempt=${attempt} maxRetries=${maxRetries}`);
        }
        // 3 attempts exhausted — owner truly unresponsive, return null to trigger pause
        logger.warn(ctx, `[team-engine] Owner unresponsive after 3 attempts: planId=${state.plan_id}`);
        return null;
    }
    /**
     * Consume a pending decision that was queued while the engine was paused.
     * Returns the decision and removes it from the queue, or null if none.
     */
    consumePendingDecision(planId) {
        const decision = this.pendingDecisions.get(planId);
        if (decision) {
            this.pendingDecisions.delete(planId);
            return decision;
        }
        return null;
    }
    /**
     * Called by API when owner submits a decision via `mavis team decision`.
     * Stores it for the polling loop in sendReportAndWaitForDecision.
     */
    submitDecision(planId, decision, activeEngines) {
        const ctx = backgroundCtx();
        this.pendingDecisions.set(planId, decision);
        // Check if any active engine loop is polling for this plan's decisions
        const state = this.store.getState(planId);
        const hasActiveLoop = state && activeEngines.has(planId);
        if (!hasActiveLoop) {
            logger.warn(ctx, `[team-engine] Decision queued but no active engine loop — will be consumed on resume: planId=${planId} status=${state?.status}`);
        }
        else {
            logger.info(ctx, `[team-engine] Decision queued from owner: planId=${planId}`);
        }
    }
    /**
     * Send arbitration request to owner when verifier(s) reject, then wait 90s.
     * Returns a Decision with either override_accept or manual_retry per task.
     * On timeout, auto-generates manual_retry for all failed tasks and notifies owner.
     */
    async sendArbitrationRequest(state, failedTasks) {
        const ctx = backgroundCtx();
        const arbitrationWaitMs = 90_000; // 90 seconds
        // Build arbitration request message
        const lines = [
            '## Arbitration Required — Verifier Rejected',
            '',
            'The following task(s) were rejected by verifier(s). Please judge whether the reviewer is wrong (override) or the producer needs to fix:',
            '',
        ];
        for (const task of failedTasks) {
            const failedVerifiers = task.verifier_results.filter((v) => !v.passed);
            lines.push(`### ${task.title} (${task.task_id})`);
            lines.push('');
            lines.push('**Reject reasons:**');
            for (const v of failedVerifiers) {
                lines.push(`- ${v.agent}: ${v.summary.slice(0, 300)}`);
            }
            if (task.deliverable) {
                lines.push('');
                lines.push(`**Deliverable summary:** ${task.deliverable.slice(0, 300)}${task.deliverable.length > 300 ? '...' : ''}`);
            }
            lines.push('');
        }
        lines.push('---', '', 'Submit a decision within 90 seconds:', `- Use \`override_accept\` if the reviewer is wrong (task is fine)`, `- Use \`manual_retry\` if the producer needs to fix (include correction instructions in reason)`, '', `If no response in 90s, engine will auto-retry all failed tasks.`);
        const arbitrationText = lines.join('\n');
        // Send arbitration request
        try {
            const result = await this.sendWrappedOwnerPrompt(state, arbitrationText, {
                type: 'arbitration-request',
            });
            if (sendFailed(result)) {
                logger.error(ctx, `[team-engine] Failed to send arbitration request: err=${sendError(result)} planId=${state.plan_id}`);
            }
        }
        catch (err) {
            logger.error(ctx, `[team-engine] Failed to send arbitration request: err=${String(err)} planId=${state.plan_id}`);
        }
        // Poll for decision with 90s timeout
        const deadline = Date.now() + arbitrationWaitMs;
        while (Date.now() < deadline) {
            const currentState = this.store.getState(state.plan_id);
            if (!currentState || currentState.status !== 'running') {
                // Plan paused/cancelled — return manual_retry as safe default
                break;
            }
            const decision = this.pendingDecisions.get(state.plan_id);
            if (decision) {
                this.pendingDecisions.delete(state.plan_id);
                logger.info(ctx, `[team-engine] Arbitration decision received: planId=${state.plan_id}`);
                return decision;
            }
            await sleep(3000);
        }
        // Timeout — auto manual_retry all failed tasks
        logger.warn(ctx, `[team-engine] Arbitration timed out (90s) — auto manual_retry: planId=${state.plan_id} taskCount=${failedTasks.length}`);
        // Notify owner about the auto-retry
        try {
            await this.sendToOwner(state, `## Arbitration Timed Out (90s)\n\n` +
                `No decision received within 90 seconds. ` +
                `Auto-retrying ${failedTasks.length} rejected task(s): ${failedTasks.map((t) => t.title).join(', ')}.\n\n` +
                `Submit a decision next cycle if you want to override.`, { type: 'arbitration-timeout' });
        }
        catch {
            /* best effort notification */
        }
        return {
            last_cycle: failedTasks.map((t) => ({
                task_id: t.task_id,
                verdict: 'manual_retry',
                reason: 'Arbitration timed out (90s) — auto manual_retry.',
            })),
            next_cycle: [],
            plan_complete: false,
        };
    }
    /** Build a CycleReport from current plan state. */
    buildCycleReport(planId, plan, state) {
        const allTasks = this.store.getAllTasks(planId);
        const findTask = (id) => allTasks.find((t) => t.id === id);
        return {
            plan_id: planId,
            plan_name: plan.plan.name,
            cycle: state.cycle,
            // Tasks already done (from previous cycles)
            done: state.results
                .filter((r) => r.status === 'done')
                .map((r) => ({
                task_id: r.task_id,
                title: findTask(r.task_id)?.title ?? r.task_id,
                producer_agent: r.producer_agent ?? 'unknown',
                verdict_summary: r.verdict_summary,
            })),
            // Tasks awaiting owner verdict (verifier ran, owner needs to accept/reject)
            awaiting_verdict: state.results
                .filter((r) => r.status === 'verifying')
                .map((r) => ({
                task_id: r.task_id,
                title: findTask(r.task_id)?.title ?? r.task_id,
                producer_agent: r.producer_agent ?? 'unknown',
                attempt: r.attempt,
                verifier_results: r.verifier_results.map((v) => ({
                    agent: v.agent,
                    passed: v.passed,
                    summary: v.summary,
                })),
                deliverable: this.readDeliverable(planId, r.task_id),
            })),
            blocked: state.results
                .filter((r) => r.status === 'blocked')
                .map((r) => ({
                task_id: r.task_id,
                title: findTask(r.task_id)?.title ?? r.task_id,
                waiting_on: findTask(r.task_id)?.depends_on ?? [],
            })),
            newly_ready: state.results
                .filter((r) => r.status === 'ready' && r.attempt === 0)
                .map((r) => ({
                task_id: r.task_id,
                title: findTask(r.task_id)?.title ?? r.task_id,
            })),
            // Tasks that bounced from producing back to ready (timeout / no deliverable)
            failed_production: state.results
                .filter((r) => r.status === 'ready' && r.attempt > 0)
                .map((r) => ({
                task_id: r.task_id,
                title: findTask(r.task_id)?.title ?? r.task_id,
                producer_agent: r.producer_agent ?? 'unknown',
                attempt: r.attempt,
                reason: r.verdict_summary,
            })),
            board_blockers: [], // populated async by collectBoardBlockers()
            total_tasks: state.results.length,
            tasks_done: state.results.filter((r) => r.status === 'done').length,
            tasks_remaining: state.results.filter((r) => r.status !== 'done').length,
        };
    }
    /**
     * Collect blocker entries from the plan board file.
     * Parses board.md for entries with 'blocked' status and returns them
     * so the owner can see blockers in CycleReports.
     */
    async collectBoardBlockers(state) {
        const allTasks = this.store.getAllTasks(state.plan_id);
        const blockers = [];
        try {
            const content = this.workspace.readBoard(state.plan_id);
            if (!content)
                return blockers;
            if (!content.trim())
                return blockers;
            // Parse board entries (separated by ---)
            const entries = content.split(/^---$/m).filter((e) => e.trim());
            // Find entries with 'blocked' status
            for (const entry of entries) {
                const headerMatch = entry.match(/\[[\d-]+\s+[\d:]+\]\s+(\S+)\s*\|\s*(\S+)\s*\|\s*blocked/i);
                if (!headerMatch)
                    continue;
                const taskId = headerMatch[2];
                const task = allTasks.find((t) => t.id === taskId);
                const existing = blockers.find((b) => b.task_id === taskId);
                if (existing) {
                    existing.entries.push({ filename: 'board.md', content: entry.trim().slice(0, 500) });
                }
                else {
                    blockers.push({
                        task_id: taskId,
                        title: task?.title ?? taskId,
                        entries: [{ filename: 'board.md', content: entry.trim().slice(0, 500) }],
                    });
                }
            }
        }
        catch {
            /* board.md may not exist yet */
        }
        return blockers;
    }
    /** Send a message to the owner session, wrapped in typed engine-message tags. */
    async sendToOwner(state, content, options = {}) {
        const ctx = backgroundCtx();
        try {
            const result = await this.sendWrappedOwnerPrompt(state, content, options);
            if (sendFailed(result)) {
                logger.error(ctx, `[team-engine] Failed to send to owner: err=${sendError(result)}`);
            }
        }
        catch (err) {
            logger.error(ctx, `[team-engine] Failed to send to owner: err=${String(err)}`);
        }
    }
    /** Trigger memory write for a completed task's producer session. */
    async triggerMemoryWrite(planId, taskId) {
        const state = this.store.getState(planId);
        const result = state?.results.find((r) => r.task_id === taskId);
        if (!result?.producer_session_id || !state)
            return;
        try {
            const sendResult = await this.createMessenger(state).sendPrompt(result.producer_session_id, 'Task verified and passed. Write to your memory: key decisions, problems, patterns discovered.');
            if (sendFailed(sendResult)) {
                logger.warn(backgroundCtx(), `[team-engine] Best-effort memory write prompt failed: planId=${planId} taskId=${taskId} sessionId=${result.producer_session_id} err=${sendError(sendResult)}`);
            }
        }
        catch (err) {
            logger.warn(backgroundCtx(), `[team-engine] Best-effort memory write prompt failed: planId=${planId} taskId=${taskId} sessionId=${result.producer_session_id} err=${String(err)}`);
        }
    }
    /**
     * Archive all sessions spawned by the engine for a plan.
     * Compressed sessions are hidden from peer lists and agent session listings.
     */
    async archiveEngineSessions(planId) {
        const ctx = backgroundCtx();
        const state = this.store.getState(planId);
        if (!state)
            return;
        const sessionIds = Object.keys(state.engine_sessions);
        for (const sid of sessionIds) {
            try {
                await this.sessionService.setSessionArchived(sid, true);
            }
            catch (err) {
                logger.warn(ctx, `[team-engine] Failed to archive session: planId=${planId} sessionId=${sid} err=${String(err)}`);
            }
        }
        if (sessionIds.length > 0) {
            logger.info(ctx, `[team-engine] Archived engine sessions: planId=${planId} count=${sessionIds.length}`);
        }
    }
    /** Read a task's deliverable content (for verifier context / cycle report). */
    readDeliverable(planId, taskId) {
        return this.workspace.readDeliverable(planId, taskId);
    }
    createMessenger(state) {
        return createEngineMessenger(this.communication, state.owner_session_id, state.owner_agent_name);
    }
    async sendWrappedOwnerPrompt(state, content, options = {}) {
        return this.createMessenger(state).sendOwnerPrompt(wrapEngineOwnerMessage(state, content, options));
    }
}
// ─── Utility ────────────────────────────────────────────────────────
function wrapEngineOwnerMessage(state, content, options) {
    const type = options.type ?? DEFAULT_ENGINE_OWNER_MESSAGE_TYPE;
    return (`<engine-message source="team-engine" type="${escapeXmlAttr(type)}" plan="${escapeXmlAttr(state.plan_id)}">\n` +
        `${content}\n` +
        `</engine-message>\n` +
        `<system-reminder>${engineOwnerReminder(type, options.promptContext)}</system-reminder>`);
}
function escapeXmlAttr(value) {
    return value
        .replaceAll('&', '&amp;')
        .replaceAll('"', '&quot;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;');
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
//# sourceMappingURL=engine-reporting.js.map