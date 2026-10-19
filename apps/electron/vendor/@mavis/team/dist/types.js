/**
 * Team Engine — core types for the produce-verify cycle engine.
 *
 * Mental model:
 *   Owner creates a Plan → Engine drives produce-verify cycles → agents deliver
 *
 * Key concepts:
 *   - Plan: a living task list managed by the owner, evolved during execution
 *   - Cycle: one round of produce → verify → evaluate
 *   - PlanTask: a single unit of work with expected output
 *   - CycleReport: engine → owner, summarizing one cycle's results
 *   - Decision: owner → engine, instructions for the next cycle
 *
 * The engine is keyed by plan_id.
 * Multiple engines can run concurrently, fully isolated.
 *
 * Task state machine (5 states, linear pipeline):
 *
 *   blocked ──→ ready ──→ producing ──→ verifying ──→ done
 *
 *   blocked:    dependencies not satisfied, engine will NOT allocate a session
 *   ready:      dependencies met, eligible for batch selection
 *   producing:  session spawned, agent is working
 *   verifying:  output delivered, verifier is checking
 *   done:       verified and accepted
 *
 *   Reverse edge (retry): verifying → ready  (verification failed, retry)
 *
 *   There is no "failed", "skipped", or "rejected" state.
 *   - Skip = owner never assigns it / removes it from plan. No session, stays blocked/ready forever.
 *   - Fail = goes back to ready for retry. Attempt counter tracks how many times.
 *   - Abort = abort the session (communication abort). State stays where it is.
 *   - Give up = owner removes it from plan or declares plan_complete.
 *
 * Cycle phase machine:
 *   determining ──→ producing ──→ verifying ──→ evaluating ──→ determining
 *                                                                   │
 *                                                               completed
 */
import { z } from 'zod';
// ─── Time field shape (storage = Unix-ms numbers) ───────────────────
/**
 * Build a zod schema accepting a time field as either Unix-ms number (canonical
 * new format) or a legacy ISO string. ISO strings are parsed at the boundary
 * so callers always see a number; this lets us reload pre-cutover state.json
 * files without an explicit migration step.
 *
 * Unparseable strings are silently coerced to `Date.now()` so we never throw
 * mid-startup when an old state file has unexpected garbage.
 */
function legacyMsField() {
    return z.union([z.number(), z.string()]).transform((v) => {
        if (typeof v === 'number')
            return v;
        const parsed = Date.parse(v);
        return Number.isFinite(parsed) ? parsed : Date.now();
    });
}
// ─── Plan Task ──────────────────────────────────────────────────────
/**
 * Expected output from a task — engine checks existence, not quality.
 * Quality judgment is left to verifier agents.
 */
export const TaskOutputSchema = z.object({
    /** File paths expected to be created or modified. */
    files: z.array(z.string()).optional(),
    /** Minimum file size in bytes (prevents empty-file cheating). */
    min_size: z.number().int().positive().optional(),
    /** Description of expected output (for the verifier to understand). */
    description: z.string().optional(),
});
/** Objective gate — optional shell command check (typecheck, lint, test). */
export const ObjectiveGateSchema = z.object({
    name: z.string().min(1),
    command: z.string().min(1),
    working_dir: z.string().optional(),
    timeout_ms: z
        .number()
        .int()
        .positive()
        .default(5 * 60 * 1000),
});
/**
 * Task role — describes the nature of the deliverable, NOT a verify on/off
 * decision. `verify-as-task` rows produce verification artifacts themselves
 * (E2E tests, reviews, audits), so the structural floor can allow them to omit
 * `verified_by` when nothing downstream consumes them.
 */
export const TaskRoleEnum = z.enum(['produce', 'verify-as-task']);
/**
 * A single task in the plan.
 * Prompt is stored inline — storage isolation is NOT the defense layer.
 * Defense is session origin validation (engine_sessions in PlanState).
 */
export const PlanTaskSchema = z.object({
    id: z.string().min(1),
    title: z.string().min(1),
    description: z.string().optional(),
    /** The prompt sent to the producing agent. */
    prompt: z.string().min(1),
    /**
     * Verification prompts. Accepts:
     * - string: same prompt for all verifiers
     * - Record<agentName, prompt>: per-verifier prompts
     * If omitted, engine builds a default verification prompt.
     */
    verify_prompt: z.union([z.string(), z.record(z.string(), z.string())]).optional(),
    /** Agent name assigned by PM. Required — engine cannot schedule unassigned tasks. */
    assigned_to: z.string().min(1),
    /** Task role used by the verify-optional structural floor. */
    role: TaskRoleEnum.default('produce'),
    /**
     * Agent(s) for verification. Accepts a single name or an array.
     * For coding tasks, typically [tester, code-reviewer].
     * All verifiers must pass for the task to be considered verified.
     */
    verified_by: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]).optional(),
    /** User-owned reason for intentionally skipping verifier scheduling. */
    verify_skip_reason: z.string().min(1).optional(),
    depends_on: z.array(z.string()).default([]),
    output: TaskOutputSchema.optional(),
    gates: z.array(ObjectiveGateSchema).default([]),
    max_retries: z.number().int().min(0).max(10).default(2),
    timeout_ms: z
        .number()
        .int()
        .positive()
        .default(15 * 60 * 1000),
    added_in_cycle: z.number().int().optional(),
});
// ─── Plan ───────────────────────────────────────────────────────────
/** Top-level plan definition. */
export const PlanSchema = z.object({
    /** Schema version for forward compatibility. */
    version: z.literal(1),
    /** Plan metadata. */
    plan: z.object({
        /** Display name. */
        name: z.string().min(1),
        /** Max parallel tasks in a single produce batch. */
        max_concurrency: z.number().int().min(1).max(10).default(3),
        /** Max consecutive failed cycles before auto-pausing. */
        max_consecutive_failures: z.number().int().min(1).max(10).default(3),
        /** Max total cycles before forcing a pause (prevents runaway). */
        max_cycles: z.number().int().min(1).max(100).default(30),
        /** When true, auto-accept tasks where ALL verifiers pass; only wait for owner on failures. */
        auto_accept: z.boolean().default(false),
        /**
         * Auto-reject FAIL verdicts back to the producer for the first N attempts
         * (engine bypasses owner decision). After attempt > N, normal owner flow.
         * 0 disables auto-reject; default 1 saves one owner round-trip per task.
         * Failed verifier feedback is injected into the producer's next prompt
         * via the existing reject pathway (verdict_summary → buildTaskPrompt).
         */
        auto_reject_retries: z.number().int().min(0).max(10).default(1),
    }),
    /** Initial task list. PM can add more during execution. */
    tasks: z.array(PlanTaskSchema).min(1),
});
// ─── Task Status ────────────────────────────────────────────────────
export const TaskStatusEnum = z.enum([
    'blocked', // dependencies not met — engine will NOT allocate a session
    'ready', // dependencies met, eligible for batch selection
    'producing', // session spawned, agent is working
    'verifying', // output delivered, verifier is checking
    'done', // verified and accepted
]);
/** Valid state transitions — code-enforced. */
export const VALID_TASK_TRANSITIONS = {
    blocked: ['ready'], // dependencies satisfied
    ready: ['producing'], // selected into batch, session spawned
    producing: ['verifying'], // agent delivered, move to verification
    verifying: ['done', 'ready'], // done = pass, ready = fail (retry)
    // done is terminal — no transitions out
};
export function assertValidTaskTransition(from, to, taskId) {
    const allowed = VALID_TASK_TRANSITIONS[from];
    if (!allowed || !allowed.includes(to)) {
        throw new Error(`Invalid task state transition: ${from} → ${to} (task: ${taskId}). ` +
            `Allowed from ${from}: [${(allowed ?? []).join(', ')}]`);
    }
}
// ─── Cycle State ────────────────────────────────────────────────────
export const CyclePhaseEnum = z.enum([
    'determining', // selecting batch of ready tasks
    'producing', // agents are delivering
    'verifying', // verifiers are checking
    'evaluating', // PM is reviewing results, deciding next steps
]);
// ─── Task Result (per-task runtime state) ───────────────────────────
export const VerifierResultSchema = z.object({
    agent: z.string(),
    session_id: z.string().optional(),
    passed: z.boolean(),
    summary: z.string(),
});
export const TaskResultSchema = z.object({
    task_id: z.string(),
    status: TaskStatusEnum,
    /** How many produce-verify cycles this task has been through. Scheduling metadata, not state. */
    attempt: z.number().int().default(0),
    /** Session that produced the output (current or last). */
    producer_session_id: z.string().optional(),
    producer_agent: z.string().optional(),
    /** Per-verifier results from the last verification round. */
    verifier_results: z.array(VerifierResultSchema).default([]),
    /** Aggregate verdict — all verifiers passed? */
    verdict_summary: z.string().optional(),
    /** Objective gate results from last verification (if any). */
    gate_results: z
        .array(z.object({
        name: z.string(),
        passed: z.boolean(),
        exit_code: z.number().int(),
        stdout: z.string().optional(),
        stderr: z.string().optional(),
        duration_ms: z.number(),
    }))
        .default([]),
    // Backward-compatible: accept legacy ISO string and normalize to Unix-ms,
    // and accept canonical numbers for new state files.
    started_at: legacyMsField().optional(),
    finished_at: legacyMsField().optional(),
    /** Owner-granted extension for the current/last producer timeout. */
    timeout_extended_ms: z.number().int().min(0).optional().default(0),
    /** Current producer timeout deadline after owner extensions. */
    timeout_deadline_at: legacyMsField().optional(),
});
// ─── Plan State (runtime, persisted to state.json) ──────────────────
/**
 * Plan-level statuses.
 *
 * Terminal states (no further engine activity expected):
 *   - completed: owner declared the plan complete
 *   - failed:    cycle loop crashed
 *   - cancelled: owner explicitly cancelled (`mavis team plan cancel`)
 *
 * The set of terminal states is encoded in {@link TERMINAL_PLAN_STATUSES} for
 * GC, system-reminder filtering, and any other terminal-state checks. Add new
 * terminal states there too — drift between the enum and the set is a foot-gun.
 */
export const PlanStatusEnum = z.enum([
    'planning',
    'approved',
    'running',
    'paused',
    'completed',
    'failed',
    'cancelled',
]);
export const TERMINAL_PLAN_STATUSES = new Set(['completed', 'failed', 'cancelled']);
export const PlanStateSchema = z.object({
    plan_id: z.string(),
    status: PlanStatusEnum,
    owner_session_id: z.string(),
    /** Agent name of the owner session — resolved at plan creation, read at runtime. */
    owner_agent_name: z.string().optional(),
    cycle: z.number().int().default(0),
    phase: CyclePhaseEnum.default('determining'),
    results: z.array(TaskResultSchema),
    dynamic_tasks: z.array(PlanTaskSchema).default([]),
    /** Mutable overlay on plan-static task definitions for runtime verify config changes. */
    task_overrides: z
        .record(z.string(), z.object({
        verified_by: z
            .union([z.string().min(1), z.array(z.string().min(1)).min(1), z.null()])
            .optional(),
        verify_skip_reason: z.union([z.string().min(1), z.null()]).optional(),
        role: TaskRoleEnum.optional(),
    }))
        .default({}),
    consecutive_failures: z.number().int().default(0),
    /**
     * Sessions spawned by the engine, keyed by sessionId → { planId, taskId, role }.
     * Only sessions in this map are trusted for task completion and verification.
     * Anything outside this map is considered rogue — engine ignores its output.
     */
    engine_sessions: z
        .record(z.string(), z.object({
        task_id: z.string(),
        role: z.enum(['producer', 'verifier']),
        agent_name: z.string(),
        spawned_at: legacyMsField(),
    }))
        .default({}),
    created_at: legacyMsField(),
    updated_at: legacyMsField(),
});
/**
 * Owner → Engine: decision after reviewing a cycle's results.
 *
 * Two sections:
 * 1. last_cycle — owner's verdict on each task from the previous cycle
 * 2. next_cycle — exactly what to execute next (owner has full authority)
 *
 * The initial plan.yaml is a roadmap. Each cycle's actual execution
 * is driven by the owner's decision, not mechanically following the plan.
 */
export const DecisionSchema = z.object({
    /** Owner's verdict on tasks from the last cycle. */
    last_cycle: z.array(z.object({
        task_id: z.string().min(1),
        /** accept = mark done, reject = back to ready, override_accept = ignore verifier reject, manual_retry = retry with owner's correction. */
        verdict: z.enum(['accept', 'reject', 'override_accept', 'manual_retry']),
        /** Owner's reasoning. */
        reason: z.string().min(1),
    })),
    /** Tasks to execute in the next cycle. Owner specifies full details. */
    next_cycle: z.array(z.object({
        task_id: z.string().min(1),
        title: z.string().min(1),
        prompt: z.string().min(1),
        assigned_to: z.string().min(1),
        verified_by: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]).optional(),
        verify_skip_reason: z.string().min(1).optional(),
        role: TaskRoleEnum.optional(),
        verify_prompt: z.union([z.string(), z.record(z.string(), z.string())]).optional(),
        timeout_ms: z.number().int().positive().optional(),
    })),
    /** Owner declares the plan objective achieved — wrap up. */
    plan_complete: z.boolean(),
    /** Message to relay to the user (informational, sent to owner session). */
    message_to_user: z.string().optional(),
});
/** @deprecated Use DecisionSchema instead. */
export const PMDecisionSchema = DecisionSchema;
//# sourceMappingURL=types.js.map