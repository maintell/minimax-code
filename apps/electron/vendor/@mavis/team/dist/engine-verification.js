/**
 * EngineVerification — verification phase execution for the CycleEngine.
 *
 * Handles: verification phase orchestration, objective gates, single verifier runs.
 */
import { backgroundCtx, getMetricsReporter, logger } from './host-utils.js';
import { Role } from '@mavis/agent-core/protocol/agent-message';
import { buildVerificationPrompt } from './prompt-builder.js';
import { parseVerifierResponse } from './structured-response.js';
import { createEngineMessenger, sendError, sendFailed, } from './engine-communication.js';
// ─── Verification Phase ─────────────────────────────────────────────
export async function runVerificationPhase(planId, _plan, deps) {
    const ctx = backgroundCtx();
    const { store, communication } = deps;
    const state = store.getState(planId);
    if (!state)
        return;
    // Resolve owner identity from plan state (set at plan creation time)
    const messenger = createEngineMessenger(communication, state.owner_session_id, state.owner_agent_name);
    // Tasks that completed production (still 'producing' with finished_at)
    const toVerify = state.results.filter((r) => r.status === 'producing' && r.finished_at);
    if (toVerify.length === 0)
        return;
    const allTasks = store.getAllTasks(planId);
    // Transition all to verifying first (before spawning any verifier sessions)
    for (const result of toVerify) {
        deps.transitionTask(ctx, planId, result.task_id, 'verifying');
    }
    // Run all task verifications in parallel
    await Promise.allSettled(toVerify.map(async (result) => {
        const task = allTasks.find((t) => t.id === result.task_id);
        if (!task)
            return;
        const verifiers = normalizeVerifiers(task.verified_by);
        if (verifiers.length === 0) {
            const skipReason = task.verify_skip_reason ?? '<no reason recorded>';
            logger.info(ctx, `[team-engine] verify skipped, reason: ${skipReason} (planId=${planId} taskId=${task.id} role=${task.role ?? 'produce'})`);
            getMetricsReporter().incr('team_task_verification_total', { result: 'skipped' });
            store.updateTaskResult(planId, result.task_id, {
                verifier_results: [],
                verdict_summary: `Skipped (verify off, reason: ${skipReason})`,
                attempt: (result.attempt ?? 0) + 1,
            });
            deps.transitionTask(ctx, planId, result.task_id, 'done');
            return;
        }
        // Run objective gates first (if any)
        const gatesPassed = await runObjectiveGates(planId, task, store, deps.gateRunner);
        if (!gatesPassed) {
            const gateFailureResult = {
                agent: 'objective-gate',
                passed: false,
                summary: 'Objective gate failed',
            };
            store.updateTaskResult(planId, result.task_id, {
                verdict_summary: 'Some failed (objective-gate: FAIL)',
                verifier_results: [gateFailureResult],
                attempt: (result.attempt ?? 0) + 1,
            });
            return;
        }
        // Agent verification — run ALL verifiers for this task in parallel, collect results
        const verifierResults = await runVerifiersInParallel(verifiers, (verifierAgent) => runSingleVerifier(planId, task, result, verifierAgent, _plan, deps, messenger));
        const allPassed = verifierResults.every((v) => v.passed);
        const summaryParts = verifierResults
            .map((v) => `${v.agent}: ${v.passed ? 'PASS' : 'FAIL'}`)
            .join(', ');
        // Phase 2 metric — verification outcome (counter; latency wraps the await above is
        // non-trivial because verifiers run in parallel, so we report a per-result-counter only)
        getMetricsReporter().incr('team_task_verification_total', {
            result: allPassed ? 'pass' : 'fail',
        });
        store.updateTaskResult(planId, result.task_id, {
            verifier_results: verifierResults,
            verdict_summary: `${allPassed ? 'All passed' : 'Some failed'} (${summaryParts})`,
            attempt: (result.attempt ?? 0) + 1,
        });
    }));
}
export function normalizeVerifiers(verifiedBy) {
    if (verifiedBy == null)
        return [];
    if (Array.isArray(verifiedBy))
        return verifiedBy.filter((v) => typeof v === 'string' && v.length > 0);
    if (typeof verifiedBy === 'string' && verifiedBy.length > 0)
        return [verifiedBy];
    return [];
}
// ─── Objective Gates ────────────────────────────────────────────────
async function runObjectiveGates(planId, task, store, gateRunner) {
    const ctx = backgroundCtx();
    if (task.gates.length === 0)
        return true;
    for (const gate of task.gates) {
        try {
            const result = await gateRunner.run({
                command: gate.command,
                timeoutMs: gate.timeout_ms,
                workingDir: gate.working_dir,
            });
            const passed = result.exitCode === 0;
            store.updateState(planId, (s) => {
                const tr = s.results.find((r) => r.task_id === task.id);
                tr?.gate_results.push({
                    name: gate.name,
                    passed,
                    exit_code: result.exitCode,
                    stdout: result.stdout?.slice(-5000),
                    stderr: result.stderr?.slice(-5000),
                    duration_ms: 0,
                });
                return s;
            });
            if (!passed)
                return false;
        }
        catch (err) {
            logger.error(ctx, `[team-engine] Gate error: planId=${planId} taskId=${task.id} gate=${gate.name} err=${String(err)}`);
            return false;
        }
    }
    return true;
}
// ─── Parallel Verifier Dispatch ─────────────────────────────────────
/**
 * Run all verifiers for a task in parallel via Promise.allSettled — no fail-fast.
 *
 * Result order matches the input `verifiers` order (index-aligned).
 * If a verifier promise rejects, its slot becomes a synthetic FAIL result with
 * the crash reason — `runSingleVerifier` normally swallows verdict errors itself,
 * so this allSettled wrapper is just defense-in-depth against unexpected throws.
 *
 * Exported for unit testing.
 */
export async function runVerifiersInParallel(verifiers, runOne) {
    const settled = await Promise.allSettled(verifiers.map((v) => runOne(v)));
    return verifiers.map((agent, i) => {
        const outcome = settled[i];
        if (outcome?.status === 'fulfilled')
            return outcome.value;
        const reason = outcome?.status === 'rejected' ? String(outcome.reason) : 'no result';
        return { agent, passed: false, summary: `Verifier crashed: ${reason}` };
    });
}
// ─── Single Verifier ────────────────────────────────────────────────
async function runSingleVerifier(planId, task, result, verifierAgent, _plan, deps, messenger) {
    const ctx = backgroundCtx();
    const { store, sessions, reporting, workspace } = deps;
    // Build verification prompt early — ensureSession (atomic spawn path) needs it
    // to assemble Communicate(spawn).spawn_config.initial_prompt before the RPC.
    const taskPaths = workspace.getTaskPaths(planId, task.id);
    const deliverable = workspace.readDeliverable(planId, task.id);
    const verificationPrompt = buildVerificationPrompt(task, verifierAgent, {
        outputDir: taskPaths.outputDir,
        workspaceDir: taskPaths.workspaceDir,
        deliverable,
    });
    const { sessionId, isFresh } = await sessions.ensureSession(planId, verifierAgent, task.id, 'verifier', (pid, content) => {
        const state = store.getState(pid);
        if (state)
            return reporting.sendToOwner(state, content);
        return Promise.resolve();
    }, async (pid) => {
        store.updateState(pid, (s) => ({ ...s, status: 'paused' }));
    }, 
    // initialPrompt — on the atomic-spawn path (isFresh=true) ensureSession
    // hands it to Communicate(command='spawn', spawn_config.initial_prompt)
    // in a single RPC. On the recovery path (isFresh=false) this function
    // calls sendPrompt below.
    verificationPrompt);
    if (!isFresh) {
        // Recovery path: session was reused; previous turn already ended; send a fresh
        // verification prompt as a new user_message.
        const sendResult = await messenger.sendPrompt(sessionId, verificationPrompt);
        if (sendFailed(sendResult)) {
            const error = sendError(sendResult);
            logger.error(ctx, `[team-engine] Verifier dispatch failed: planId=${planId} taskId=${task.id} verifier=${verifierAgent} sessionId=${sessionId} err=${error}`);
            return {
                agent: verifierAgent,
                session_id: sessionId,
                passed: false,
                summary: `Verifier dispatch failed: ${error}`,
            };
        }
    }
    // isFresh=true: prompt already delivered atomically inside Communicate(spawn);
    // a second sendPrompt would race the in-flight first turn.
    // Wait for verdict via archon-server polling. The historical bridge.onResponse
    // race was removed: cloud child sessions are always cross-pod from the owner
    // (archon-server `AcquireHarnessSandboxForChildSession` invariant), so the
    // in-process bridge cannot reach the verifier — the race always lost to
    // polling and only added a 30s stale-end-event grace window. See doc on
    // `VerificationDeps.sessionLifecycle`.
    const verdictResult = await waitForVerdictViaPolling({
        sessionLifecycle: deps.sessionLifecycle,
        sessionId,
        timeoutMs: task.timeout_ms,
    });
    // Sub-label so dashboards can distinguish steady-state cross-pod completion
    // (`terminal`) from genuine bug signals (`timeout` = task.timeout_ms hit;
    // `hang` = content unchanged across consecutive hang-checks).
    getMetricsReporter().incr('team_verifier_exit_total', { source: verdictResult.resolvedVia });
    const completion = {
        content: verdictResult.content,
        completed: verdictResult.completed,
    };
    const verdict = parseVerifierResponse(completion.content);
    logger.info(ctx, `[team-engine] Verifier verdict parsed: planId=${planId} taskId=${task.id} verifier=${verifierAgent} parseMethod=${verdict.parseMethod} passed=${verdict.passed} resolvedVia=${verdictResult.resolvedVia} hasSeenActivity=${verdictResult.hasSeenActivity} contentLen=${completion.content.length}`);
    return {
        agent: verifierAgent,
        session_id: sessionId,
        passed: verdict.passed,
        summary: verdict.summary,
    };
}
// ─── Verdict Polling ───────────────────────────────────────────────
/** Default poll cadence — every N ms we fetch session status + a small
 *  message window. */
const DEFAULT_VERDICT_POLL_INTERVAL_MS = 5_000;
/**
 * Hang-check cadence — every N elapsed ms we evaluate whether assistant
 * content has advanced since the previous hang-check. Empty content
 * counts as "no progress" too, so a verifier that never starts producing
 * any message still trips hang detection (e.g. spawn / sandbox
 * provisioning never finishes the first turn).
 *
 * Defaults: interval=10 min, threshold=1 →
 *   - hang-check #1 at  t≈10 min   primes lastSeenContent (no decision)
 *   - hang-check #2 at  t≈20 min   trips hang if content unchanged
 *
 * → ~20 min of total wall-clock inactivity before bailing out, matching
 * the user-stated "10/20 min" robustness intent. Bumping `threshold`
 * extends the wall-time linearly.
 */
const DEFAULT_HANG_CHECK_INTERVAL_MS = 600_000; // 10 min
const DEFAULT_HANG_THRESHOLD = 1;
/** Soft-cap on the small message fetch issued every poll tick. */
const POLL_FETCH_LIMIT = 5;
/** Soft-cap on the bigger message fetch when transitioning to a terminal state. */
const FINAL_FETCH_LIMIT = 20;
/** Statuses returned by `getSession` that mean the verifier session has stopped. */
const VERDICT_TERMINAL_STATUSES = new Set(['finished', 'idle', 'aborted', 'error', 'interrupted']);
/**
 * Poll archon-server to decide verifier completion. The state machine
 * gates `'terminal'` exit on having observed activity at least once,
 * which avoids the pre-turn `Idle` trap: `SessionLifecycleStatus.Idle = 0`
 * is the DDL default for a freshly-created session row AND the post-turn
 * resting state, so `mapSessionStatus(0) → 'finished'` cannot disambiguate
 * the two on its own. Activity = `status` was `'started'` at some tick,
 * OR persisted assistant content was non-empty.
 *
 * State machine:
 *
 * ```
 *   loop {
 *     elapsed ≥ timeoutMs? → final fetch → resolve('timeout')
 *     await sleep(pollIntervalMs)
 *     [status, msgs] = await Promise.all([getSession, getRecentMessages(5)])
 *     current = joinAssistantText(msgs)
 *     if status==='started' OR current!=='':
 *       hasSeenActivity = true
 *     if hasSeenActivity AND status ∈ terminal:
 *       final = getRecentMessages(20)  // wider window for the tail
 *       → resolve('terminal')
 *     if elapsed - lastHangCheck ≥ hangCheckIntervalMs:
 *       if current === lastSeenContent:
 *         consecutiveNoChange++
 *         if ≥ threshold: → resolve('hang')
 *       else:
 *         reset; lastSeenContent = current
 *   }
 * ```
 *
 * archon-server `routeTurnTerminal` persists message rows BEFORE flipping
 * `sessions.status` (`event_router.go:817-925`), so when we observe a
 * terminal status the assistant tail is already on disk and a single
 * final fetch (limit=20) is enough.
 *
 * Exported for unit testing.
 */
export async function waitForVerdictViaPolling(args) {
    const { sessionLifecycle, sessionId, timeoutMs, pollIntervalMs = DEFAULT_VERDICT_POLL_INTERVAL_MS, hangCheckIntervalMs = DEFAULT_HANG_CHECK_INTERVAL_MS, hangThreshold = DEFAULT_HANG_THRESHOLD, } = args;
    const startedAt = Date.now();
    let hasSeenActivity = false;
    let lastSeenContent = '';
    let consecutiveNoChange = 0;
    let lastHangCheckElapsed = 0;
    while (true) {
        const elapsed = Date.now() - startedAt;
        // Exit — total budget exhausted. Final fetch anyway so callers get the
        // persisted tail (if any) instead of an empty string after burning the
        // full timeout. Robust fallback for status-flip drops or activity that
        // arrived between our last poll and the deadline.
        if (elapsed >= timeoutMs) {
            const finalContent = await fetchAssistantTextSafe(sessionLifecycle, sessionId, FINAL_FETCH_LIMIT, lastSeenContent);
            return {
                content: finalContent,
                completed: false,
                resolvedVia: 'timeout',
                hasSeenActivity,
            };
        }
        const remaining = timeoutMs - elapsed;
        const waitMs = Math.min(pollIntervalMs, remaining);
        await sleep(waitMs);
        // Per-poll: cheap status + small message fetch. The message fetch is
        // small (limit=5) so spend stays bounded, but it's necessary on every
        // tick because:
        //   (a) `Idle (=0)` is the DDL default for not-yet-started sessions
        //       AND the post-turn idle state — we cannot distinguish them
        //       from the status alone, so we use "has the verifier produced
        //       any persisted assistant content?" as the activity signal.
        //   (b) short-running verifiers may spawn → start → idle within a
        //       single poll interval, so without the message fetch the
        //       activity gate would never trip and we'd wait out the full
        //       timeout.
        let sessionInfo;
        let messages = [];
        try {
            [sessionInfo, messages] = await Promise.all([
                sessionLifecycle.getSession(sessionId),
                sessionLifecycle.getRecentMessages(sessionId, POLL_FETCH_LIMIT),
            ]);
        }
        catch {
            // Transient archon-server hiccup — retry next tick. Don't forfeit
            // the only completion signal on a single RPC throw.
            continue;
        }
        const status = sessionInfo?.status?.type;
        const current = joinAssistantText(messages);
        // Activity gate — track ANY signal that the verifier session got past
        // the pre-turn `Idle` init state.
        if (status === 'started' || current !== '') {
            hasSeenActivity = true;
        }
        // Exit — genuine terminal. Pull a wider message window once for the
        // final content (small fetch above might have missed the very last
        // message if it landed between the two parallel RPCs).
        if (hasSeenActivity && status && VERDICT_TERMINAL_STATUSES.has(status)) {
            const finalContent = await fetchAssistantTextSafe(sessionLifecycle, sessionId, FINAL_FETCH_LIMIT, current || lastSeenContent);
            return {
                content: finalContent,
                completed: true,
                resolvedVia: 'terminal',
                hasSeenActivity,
            };
        }
        // Periodic hang-check. Note: empty content === lastSeenContent (also
        // empty) IS a hang signal — covers the "spawn never produced any
        // message" failure mode where activity gate also stays false. The
        // first hang-check primes `lastSeenContent`, subsequent checks
        // increment `consecutiveNoChange` whenever content has not advanced.
        const elapsedNow = Date.now() - startedAt;
        if (elapsedNow - lastHangCheckElapsed >= hangCheckIntervalMs) {
            if (lastHangCheckElapsed === 0) {
                // First hang-check: prime baseline, no decision.
                lastSeenContent = current;
                lastHangCheckElapsed = elapsedNow;
            }
            else {
                if (current === lastSeenContent) {
                    consecutiveNoChange++;
                    if (consecutiveNoChange >= hangThreshold) {
                        return {
                            content: lastSeenContent,
                            completed: false,
                            resolvedVia: 'hang',
                            hasSeenActivity,
                        };
                    }
                }
                else {
                    consecutiveNoChange = 0;
                    lastSeenContent = current;
                }
                lastHangCheckElapsed = elapsedNow;
            }
        }
    }
}
/**
 * Fetch the assistant tail and join it; return `fallback` on RPC failure or
 * empty join. Keeps `waitForVerdictViaPolling` exits robust — never hands
 * back an empty string when we have a previously seen snapshot.
 */
async function fetchAssistantTextSafe(port, sessionId, limit, fallback) {
    try {
        const messages = await port.getRecentMessages(sessionId, limit);
        const text = joinAssistantText(messages);
        return text !== '' ? text : fallback;
    }
    catch {
        return fallback;
    }
}
/** Plain async sleep — no signal handling needed since the polling loop
 *  has no external aborter (the historical bridge race was removed). */
function sleep(ms) {
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        if (typeof timer.unref === 'function')
            timer.unref();
    });
}
/**
 * Join the `msg_content` of assistant-role messages in chronological order.
 * Tolerates the `role` field being either the string `'assistant'` (current
 * archon-server / daemon wire) or the legacy `Role.Assistant` constant.
 * Tool-call / system / user messages are skipped.
 */
function joinAssistantText(messages) {
    if (!Array.isArray(messages) || messages.length === 0)
        return '';
    // Defensive copy so a polling cycle's slice cannot reorder the caller's array.
    const ordered = [...messages];
    const parts = [];
    for (const m of ordered) {
        if (!m || typeof m !== 'object')
            continue;
        const role = m.role;
        if (role !== 'assistant' && role !== Role.Assistant)
            continue;
        const content = m.msg_content;
        if (typeof content === 'string' && content.length > 0)
            parts.push(content);
    }
    return parts.join('\n');
}
//# sourceMappingURL=engine-verification.js.map