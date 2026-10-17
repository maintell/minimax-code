/**
 * EngineSessionManager — session lifecycle for the CycleEngine.
 *
 * Handles: session creation/reuse, completion handles, handle cancellation.
 */
import { backgroundCtx, logger } from './host-utils.js';
import { sendError, sendFailed } from './engine-communication.js';
// ─── Session Manager ────────────────────────────────────────────────
/**
 * Default grace period (ms) after `activate()` during which `end: true` events
 * are treated as stale when no content has streamed yet.
 *
 * Background: legacy local runtime emits `session.idle` (which the bridge surfaces as
 * `end: true`) between tool calls and permission waits — these are NOT real
 * task-completion signals.  Without a grace window the engine resolves the
 * completion handle the moment the agent pauses to ask for permission,
 * fires `no deliverable` retries within milliseconds, and burns the entire
 * cycle inside a single second of dispatch.  See plan_757d91a9 post-mortem.
 *
 * 30s comfortably covers agent boot (AGENTS.md read, project context load,
 * worktree probe) without delaying genuine fast tasks: a real completion
 * either streams content first (which clears the gate) or arrives after the
 * agent has actually had time to do work.
 */
export const DEFAULT_END_EVENT_GRACE_MS = 30_000;
export class EngineSessionManager {
    agentManager;
    sessionService;
    bridge;
    communication;
    store;
    sessionCache = new Map();
    activeHandles = new Map();
    endEventGracePeriodMs;
    constructor(agentManager, sessionService, bridge, communication, store, options = {}) {
        this.agentManager = agentManager;
        this.sessionService = sessionService;
        this.bridge = bridge;
        this.communication = communication;
        this.store = store;
        this.endEventGracePeriodMs = options.endEventGracePeriodMs ?? DEFAULT_END_EVENT_GRACE_MS;
    }
    /**
     * Get or spawn a session for a task.
     * Same task retry reuses the session (keeps failure context).
     * After pause→resume or daemon restart, recovers from engine_sessions state.
     *
     * Returns `{ sessionId, isFresh }`:
     *   - `isFresh=true`: fresh spawn just completed via `Communicate(command='spawn')`
     *     in one atomic RPC. The `initialPrompt` was already delivered to the child
     *     cloud-runtime as the first user_message — caller MUST NOT call
     *     `sendPrompt(sessionId, initialPrompt)` (would race the in-flight first
     *     turn and trigger "session has active turn").
     *   - `isFresh=false`: recovery path (pre-existing alive session) or cache hit.
     *     Caller MUST call `sendPrompt(sessionId, initialPrompt)` — the previous turn
     *     has already finished and the session is idle waiting for the next message.
     */
    async ensureSession(planId, agentName, taskId, role, sendToOwner, pausePlan, initialPrompt) {
        const ctx = backgroundCtx();
        let cache = this.sessionCache.get(planId);
        if (!cache) {
            cache = new Map();
            this.sessionCache.set(planId, cache);
        }
        // Each task gets its own session. Same task retry reuses the session (keeps failure context).
        const cacheKey = `${agentName}::${taskId}::${role}`;
        const cached = cache.get(cacheKey);
        if (cached)
            return { sessionId: cached, isFresh: false };
        // Try to recover session from state (e.g. after pause→resume or daemon restart).
        // If the session is still alive, reuse it instead of spawning a new one.
        const state = this.store.getState(planId);
        const engineSession = Object.entries(state.engine_sessions).find(([, info]) => info.task_id === taskId && info.role === role && info.agent_name === agentName);
        if (engineSession) {
            const [oldSessionId] = engineSession;
            const sessionInfo = await this.sessionService.getSession(oldSessionId);
            if (sessionInfo) {
                // Session still alive — reuse it
                cache.set(cacheKey, oldSessionId);
                logger.info(ctx, `[team-engine] Recovered existing session: planId=${planId} taskId=${taskId} role=${role} agentName=${agentName} sessionId=${oldSessionId}`);
                return { sessionId: oldSessionId, isFresh: false };
            }
        }
        // Check agent exists before spawning — don't auto-create empty agents
        const existingAgent = await this.agentManager.getAgent(agentName);
        if (!existingAgent) {
            await sendToOwner(planId, `## Agent Not Found\n\nAgent "${agentName}" does not exist. The engine is pausing.\nPlease create the agent first, then resume the plan:\n\n\`\`\`bash\nmavis agent new ${agentName}\nmavis team plan resume ${planId}\n\`\`\``);
            await pausePlan(planId);
            throw new Error(`Agent "${agentName}" not found — engine paused, owner notified`);
        }
        const taskTitle = this.store.getAllTasks(planId).find((t) => t.id === taskId)?.title ?? taskId;
        // Use the raw task title as the session title — the UI surfaces the agent
        // name separately, so prefixing `${agentName}:` here is noisy duplication.
        // Keeping the raw title also preserves the orchestrator's conversation
        // language (no English `agentName:` polluting an otherwise-CN title).
        const title = taskTitle;
        // **Atomic spawn** — Communicate(command='spawn') in one RPC: archon-server
        // creates child session + acquires Harness sandbox + emits SSE
        // `session.spawned` + delivers `initialPrompt` to control_harness as the
        // first user_message. Replaces the broken two-step `CreateSession +
        // sendPrompt` path (often hit "Transient delivery failure" when
        // cloud-runtime received the prompt before the child cloud-runtime started).
        const result = await this.communication.send(state.owner_session_id, undefined, 'spawn', JSON.stringify({ agent: agentName, title, taskTreeId: taskId, initialPrompt }));
        if (sendFailed(result ?? { status: 'delivered' })) {
            throw new Error(`Failed to spawn session for agent ${agentName}: ${sendError(result ?? { status: 'failed' })}`);
        }
        const sessionId = result?.data?.sessionId;
        if (!sessionId)
            throw new Error(`Failed to spawn session for agent ${agentName}`);
        // Register in engine_sessions — this is the origin tag
        this.store.updateState(planId, (s) => {
            s.engine_sessions[sessionId] = {
                task_id: taskId,
                role,
                agent_name: agentName,
                spawned_at: Date.now(),
            };
            return s;
        });
        cache.set(cacheKey, sessionId);
        logger.info(ctx, `[team-engine] Session spawned and registered: planId=${planId} taskId=${taskId} role=${role} agentName=${agentName} sessionId=${sessionId} (atomic spawn+prompt via Communicate)`);
        return { sessionId, isFresh: true };
    }
    /**
     * Create a completion handle that resolves when the session ends or times out.
     *
     * The handle starts **deactivated** — all `end: true` events are silently
     * drained until `activate()` is called.  This eliminates the race condition
     * where a stale terminal event from a previous turn on a reused session
     * resolves the handle before the producer has started working.
     *
     * Typical usage:
     *   const handle = sessions.createCompletionHandle(sid, timeout);
     *   await communication.send(...);
     *   handle.activate();  // NOW accept end events
     */
    createCompletionHandle(sessionId, timeoutMs) {
        const ctx = backgroundCtx();
        let activated = false;
        let activatedAtMs = 0;
        let content = '';
        const chunkMsgIds = new Set();
        let resolved = false;
        let resolvePromise;
        let rejectPromise;
        const promise = new Promise((resolve, reject) => {
            resolvePromise = resolve;
            rejectPromise = reject;
        });
        // Always attach a no-op rejection handler so that callers who drop the
        // handle (e.g. dispatch failed → handles.delete + handle.cancel, or
        // pause/cancel cancelling all handles before the awaiter has subscribed)
        // do not leak an unhandled "Cancelled" rejection up to
        // `process.on('unhandledRejection')` in daemon/src/index.ts — that handler
        // calls process.exit(1) and would tear the whole daemon down. Real
        // consumers (Promise.allSettled in engine-production / engine-verification)
        // still see the rejection independently because attaching multiple
        // handlers does not deduplicate them.
        promise.catch(() => {
            /* prevent unhandled-rejection on cancellation when no caller awaits */
        });
        const gracePeriodMs = this.endEventGracePeriodMs;
        let deadlineAtMs = Date.now() + timeoutMs;
        let timer;
        const scheduleTimer = () => {
            const delayMs = Math.max(0, deadlineAtMs - Date.now());
            timer = setTimeout(() => {
                if (!resolved) {
                    resolved = true;
                    unsubscribe();
                    resolvePromise({ content: content.trim(), completed: false });
                }
            }, delayMs);
            if (typeof timer.unref === 'function')
                timer.unref();
        };
        const unsubscribe = this.bridge.onResponse((evtSid, message) => {
            if (evtSid !== sessionId)
                return;
            if (message.end) {
                if (!activated) {
                    // Drain stale end events from previous turns
                    logger.debug(ctx, `[team-engine] Draining stale end event — handle not yet activated: sessionId=${sessionId}`);
                    return;
                }
                // Drain `end: true` events that arrive before the agent has had time
                // to start working. legacy local runtime surfaces every `session.idle` (between
                // tool calls / permission waits) as `end: true`, so the very first
                // signal after dispatch is almost never a real completion.  We only
                // accept an `end` event once either:
                //   (a) the agent has streamed at least one chunk of content, or
                //   (b) the grace window has elapsed (slow start without streaming).
                if (!resolved) {
                    const elapsed = Date.now() - activatedAtMs;
                    if (content === '' && elapsed < gracePeriodMs) {
                        logger.debug(ctx, `[team-engine] Draining early end event with empty content (likely stale idle): sessionId=${sessionId} elapsedMs=${elapsed} gracePeriodMs=${gracePeriodMs}`);
                        return;
                    }
                    resolved = true;
                    clearTimeout(timer);
                    unsubscribe();
                    resolvePromise({ content: content.trim(), completed: true });
                }
                return;
            }
            // Only accumulate content after activation
            if (activated) {
                const rd = message.respData;
                const nextContent = rd?.agent_message_chunk?.msg_content ?? rd?.agentMessageChunk?.msgContent;
                if (typeof nextContent === 'string')
                    content += nextContent;
                const chunkMsgId = rd?.agent_message_chunk && 'msg_id' in rd.agent_message_chunk
                    ? rd.agent_message_chunk.msg_id
                    : undefined;
                if (chunkMsgId)
                    chunkMsgIds.add(chunkMsgId);
                const fullMsg = rd?.agent_message;
                const fullMsgContent = fullMsg?.msg_content ?? rd?.agentMessage?.msgContent;
                const fullMsgId = fullMsg && 'msg_id' in fullMsg ? fullMsg.msg_id : undefined;
                if (typeof fullMsgContent === 'string' && !(fullMsgId && chunkMsgIds.has(fullMsgId))) {
                    content += fullMsgContent;
                }
            }
        });
        scheduleTimer();
        const cancel = () => {
            if (resolved)
                return;
            resolved = true;
            clearTimeout(timer);
            unsubscribe();
            rejectPromise(new Error('Cancelled'));
        };
        const extendTimeout = (extraMs) => {
            if (!Number.isFinite(extraMs) || extraMs <= 0) {
                throw new Error('extraMs must be a positive finite number');
            }
            if (resolved)
                return deadlineAtMs;
            deadlineAtMs += extraMs;
            clearTimeout(timer);
            scheduleTimer();
            return deadlineAtMs;
        };
        const activate = () => {
            activated = true;
            activatedAtMs = Date.now();
        };
        return { promise, cancel, extendTimeout, deadlineAtMs: () => deadlineAtMs, activate };
    }
    /** Cancel all active completion handles for a plan. */
    cancelHandles(planId) {
        const handles = this.activeHandles.get(planId);
        if (!handles)
            return;
        for (const [, h] of handles)
            h.cancel();
        this.activeHandles.delete(planId);
    }
    /** Get the active handles map for a plan (used by production phase). */
    getActiveHandles(planId) {
        return this.activeHandles.get(planId);
    }
    /** Set the active handles for a plan (used by production phase). */
    setActiveHandles(planId, handles) {
        this.activeHandles.set(planId, handles);
    }
    /** Delete active handles for a plan. */
    deleteActiveHandles(planId) {
        this.activeHandles.delete(planId);
    }
    /** Clear the session cache for a plan. */
    clearSessionCache(planId) {
        this.sessionCache.delete(planId);
    }
}
//# sourceMappingURL=engine-session.js.map