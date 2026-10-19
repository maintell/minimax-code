/**
 * `team` tool command group —— 7 个 handler 映射到 @mavis/team CycleEngine /
 * PlanStore 的对应方法。每个 handler 是 thin wrapper:
 *
 *   1. 校验 teamRuntime 已注入(没注入时直接 validation failure,给 LLM 清晰错误)
 *   2. 把 args 翻成 engine / store 入参
 *   3. 调对应方法,捕获 AppError → archon_server / validation failure
 *
 * Owner-only 操作(start / pause / resume / decision / cancel / steer / unblock /
 * extend-timeout)的 access check 不在 cloud-runtime 这层做 —— 直接复用 daemon
 * api/team.ts 同样的 contract:`from_session === plan.owner_session_id`。本地
 * 工具化模式下 dispatcher 已把当前 turn 的 sessionId 注入 CommandContext,handler
 * 直接读 ctx.sessionId 做 owner check。
 *
 * `team plan run` 是初始化入口:
 *   - 读 plan yaml 文件 → PlanSchema.parse → store.create → engine.start
 *   - owner_session 必须由 ctx.sessionId 提供(LLM 不能伪造)
 *
 * `team plan status` 是只读:state + plan 都返回让 owner 自己渲染。
 *
 * 其它 5 个 handler 是状态写:steer / decision / cancel / extend-timeout / unblock。
 *
 * 注意:archonServer adapter 由 ctx 携带但 team handler 不直接用 —— 所有
 * archon-server 交互通过已经在 team-ports.ts 里的 5 个 port 完成,handler 这层
 * 只跟 engine / store 打交道。
 */
import fs from 'node:fs';
import yaml from 'js-yaml';
import { z } from 'zod';
import { DecisionSchema, PlanSchema } from '@mavis/team';
import { backgroundCtx } from '../../runtime-types.js';
import { errorToFailure, failure, success } from '../output.js';
import { resolveWithinWorkspace } from '../../path-guard.js';
const idString = z.string().min(1, 'ID must be a non-empty string');
const optionalNumber = z.number().int().nonnegative().optional();
/**
 * Seven plan-level handlers backed by the @mavis/team CycleEngine.
 * `plan_id` follows daemon's `plan_<8-hex>` shape — but cloud-runtime
 * accepts any non-empty string so future id schemes don't require a schema
 * change.
 */
export const teamRunSchema = z.object({
    plan_path: z.string().min(1),
});
export const teamStatusSchema = z.object({
    plan_id: idString,
});
export const teamSteerSchema = z.object({
    plan_id: idString,
    message: z.string().min(1),
});
export const teamDecisionSchema = z.object({
    plan_id: idString,
    // decision body — deep-validated by handler via agent-core DecisionSchema
    decision: z.unknown(),
});
export const teamExtendTimeoutSchema = z
    .object({
    plan_id: idString,
    task_id: idString,
    extra_ms: optionalNumber,
    extra_minutes: optionalNumber,
})
    .refine((v) => Boolean(v.extra_ms) || Boolean(v.extra_minutes), {
    message: 'extend-timeout requires either extra_ms or extra_minutes',
});
export const teamUnblockSchema = z.object({
    plan_id: idString,
    task_id: idString,
});
export const teamCancelSchema = z.object({
    plan_id: idString,
});
const TEAM_COMMAND_SCHEMAS = {
    'plan run': teamRunSchema,
    'plan status': teamStatusSchema,
    'plan steer': teamSteerSchema,
    'plan decision': teamDecisionSchema,
    'plan extend-timeout': teamExtendTimeoutSchema,
    'plan unblock': teamUnblockSchema,
    'plan cancel': teamCancelSchema,
};
export const TEAM_KNOWN_COMMANDS = Object.keys(TEAM_COMMAND_SCHEMAS);
export async function dispatchTeamTool(deps, rawCommand, rawArgs, signal) {
    const command = normalizeTeamCommand(rawCommand);
    if (!isTeamCommand(command)) {
        return failure(command, 'validation', `unknown team command: ${JSON.stringify(rawCommand)}. Did you mean one of: ${suggestTeamCommands(command).join(', ')}?`, { known_commands: TEAM_KNOWN_COMMANDS });
    }
    const schema = TEAM_COMMAND_SCHEMAS[command];
    const parsed = schema.safeParse(rawArgs ?? {});
    if (!parsed.success) {
        return failure(command, 'validation', `invalid args: ${parsed.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`).join('; ')}`, { issues: parsed.error.issues });
    }
    const ctx = {
        command,
        archonServer: undefined,
        workspaceRoot: deps.workspaceRoot,
        sessionId: deps.sessionId,
        ...(deps.teamRuntime ? { teamRuntime: deps.teamRuntime } : {}),
    };
    try {
        switch (command) {
            case 'plan run':
                return await handleTeamPlanRun(ctx, parsed.data, signal);
            case 'plan status':
                return await handleTeamPlanStatus(ctx, parsed.data, signal);
            case 'plan steer':
                return await handleTeamPlanSteer(ctx, parsed.data, signal);
            case 'plan decision':
                return await handleTeamPlanDecision(ctx, parsed.data, signal);
            case 'plan extend-timeout':
                return await handleTeamPlanExtendTimeout(ctx, parsed.data, signal);
            case 'plan unblock':
                return await handleTeamPlanUnblock(ctx, parsed.data, signal);
            case 'plan cancel':
                return await handleTeamPlanCancel(ctx, parsed.data, signal);
        }
    }
    catch (error) {
        return errorToFailure(command, error);
    }
}
function normalizeTeamCommand(raw) {
    const command = raw.trim().replace(/\s+/g, ' ');
    if (command.startsWith('team '))
        return command.slice('team '.length);
    if (TEAM_SHORT_COMMAND_ALIASES.has(command))
        return `plan ${command}`;
    return command;
}
function isTeamCommand(command) {
    return TEAM_KNOWN_COMMANDS.includes(command);
}
function suggestTeamCommands(command) {
    const first = command.split(' ')[0] ?? '';
    const exactPrefix = TEAM_KNOWN_COMMANDS.filter((c) => c.startsWith(first));
    return (exactPrefix.length > 0 ? exactPrefix : TEAM_KNOWN_COMMANDS).slice(0, 5);
}
const TEAM_SHORT_COMMAND_ALIASES = new Set([
    'run',
    'status',
    'steer',
    'decision',
    'extend-timeout',
    'unblock',
    'cancel',
]);
// ─── helper: ensure teamRuntime is wired ────────────────────────────
function requireTeamRuntime(ctx) {
    if (!ctx.teamRuntime) {
        return {
            failure: failure(ctx.command, 'validation', 'team engine is not enabled in this cloud-runtime — server.ts must call initTeamRuntime() at startup'),
        };
    }
    return { runtime: ctx.teamRuntime };
}
function requireOwnerSession(ctx) {
    if (!ctx.sessionId) {
        return {
            failure: failure(ctx.command, 'validation', 'team plan operations require a session_id — runtime context is missing it'),
        };
    }
    return { sessionId: ctx.sessionId };
}
function checkOwner(ctx, planId, runtime, fromSession) {
    const state = runtime.planStore.getState(planId);
    if (!state) {
        return failure(ctx.command, 'validation', `Plan not found: ${planId}`, { plan_id: planId });
    }
    if (fromSession !== state.owner_session_id) {
        return failure(ctx.command, 'validation', `Access denied: only the plan owner can perform this operation (plan owner=${state.owner_session_id}, caller=${fromSession})`, { plan_id: planId, owner_session_id: state.owner_session_id });
    }
    return null;
}
/**
 * Generate a fresh plan id. Same shape as daemon (`plan_<8-hex>`) so logs
 * and tools stay format-compatible.
 */
function generatePlanId() {
    // 8 hex chars = 32 bits — collision-resistant enough for per-user
    // plansDir. PlanStore.create() throws PLAN_EXISTS if we collide.
    const hex = Math.floor(Math.random() * 0xffffffff)
        .toString(16)
        .padStart(8, '0');
    return `plan_${hex}`;
}
// ─── handlers ─────────────────────────────────────────────────────────
/**
 * `team plan run` — initialize + start a new plan from a yaml file.
 *
 * args.plan_path is workspace-relative or absolute (path-guard resolves it).
 * The yaml is parsed, validated against `PlanSchema`, then persisted via
 * `store.create(planId, plan, ownerSessionId)` and the engine is kicked
 * with `engine.start(planId)`.
 *
 * Why we accept a path (vs inline plan body): plan yaml can grow large
 * (multiple tasks with long prompts) and the LLM already writes plan
 * files into the workspace via the file tools; reading from disk avoids
 * re-passing the same body through the tool args.
 */
export const handleTeamPlanRun = async (ctx, args) => {
    const rt = requireTeamRuntime(ctx);
    if ('failure' in rt)
        return rt.failure;
    const session = requireOwnerSession(ctx);
    if ('failure' in session)
        return session.failure;
    // Resolve plan_path against workspace, with path-guard refusing escapes.
    // `resolveWithinWorkspace` signature is `(inputPath, workspaceRoot)`.
    let absPath;
    try {
        absPath = await resolveWithinWorkspace(args.plan_path, ctx.workspaceRoot);
    }
    catch (err) {
        return failure(ctx.command, 'workspace', err instanceof Error ? err.message : String(err), {
            plan_path: args.plan_path,
        });
    }
    if (!fs.existsSync(absPath)) {
        return failure(ctx.command, 'workspace', `plan file not found: ${absPath}`, {
            plan_path: args.plan_path,
        });
    }
    let rawDoc;
    try {
        rawDoc = yaml.load(fs.readFileSync(absPath, 'utf8'));
    }
    catch (err) {
        return failure(ctx.command, 'validation', `failed to parse plan yaml: ${err instanceof Error ? err.message : String(err)}`, { plan_path: args.plan_path });
    }
    const validated = PlanSchema.safeParse(rawDoc);
    if (!validated.success) {
        return failure(ctx.command, 'validation', `invalid plan schema: ${validated.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`).join('; ')}`, { issues: validated.error.issues });
    }
    const planId = generatePlanId();
    try {
        const result = rt.runtime.planStore.create(planId, validated.data, session.sessionId);
        await rt.runtime.cycleEngine.start(planId);
        return success(ctx.command, {
            plan_id: planId,
            status: 'started',
            state: result.state,
        });
    }
    catch (err) {
        return failure(ctx.command, 'validation', err instanceof Error ? err.message : String(err), {
            plan_id: planId,
            name: err instanceof Error ? err.name : undefined,
        });
    }
};
/**
 * `team plan status` — read-only plan inspection.
 *
 * Returns both `plan` (definition) and `state` (runtime) so the LLM can
 * render a compact summary or surface specific fields (cycle / phase /
 * task states). Caller is not gated by ownership — anyone with the
 * plan_id can read. Caller's own filtering is downstream.
 */
export const handleTeamPlanStatus = async (ctx, args) => {
    const rt = requireTeamRuntime(ctx);
    if ('failure' in rt)
        return rt.failure;
    const state = rt.runtime.planStore.getState(args.plan_id);
    if (!state) {
        return failure(ctx.command, 'validation', `Plan not found: ${args.plan_id}`, {
            plan_id: args.plan_id,
        });
    }
    const plan = rt.runtime.planStore.getPlan(args.plan_id);
    return success(ctx.command, { plan_id: args.plan_id, state, plan });
};
/**
 * `team plan steer` — owner injects a steering message into all active
 * worker sessions in a plan. Engine aborts + re-prompts each worker.
 *
 * Wraps `engine.steer(ctx, planId, message)` and surfaces the engine's
 * `{ steered_sessions, failed_sessions }` summary back to the caller.
 */
export const handleTeamPlanSteer = async (ctx, args) => {
    const rt = requireTeamRuntime(ctx);
    if ('failure' in rt)
        return rt.failure;
    const session = requireOwnerSession(ctx);
    if ('failure' in session)
        return session.failure;
    const ownerErr = checkOwner(ctx, args.plan_id, rt.runtime, session.sessionId);
    if (ownerErr)
        return ownerErr;
    try {
        const result = await rt.runtime.cycleEngine.steer(backgroundCtx(), args.plan_id, args.message);
        return success(ctx.command, { plan_id: args.plan_id, status: 'steered', ...result });
    }
    catch (err) {
        return failure(ctx.command, 'validation', err instanceof Error ? err.message : String(err), {
            plan_id: args.plan_id,
        });
    }
};
/**
 * `team plan decision` — owner submits cycle decision (accept / reject /
 * next_cycle tasks). Engine queues + applies the decision asynchronously.
 *
 * `engine.submitDecision` returns void — the engine auto-resumes a paused
 * plan if needed (see CycleEngine.submitDecision for race-handling).
 */
export const handleTeamPlanDecision = async (ctx, args) => {
    const rt = requireTeamRuntime(ctx);
    if ('failure' in rt)
        return rt.failure;
    const session = requireOwnerSession(ctx);
    if ('failure' in session)
        return session.failure;
    const ownerErr = checkOwner(ctx, args.plan_id, rt.runtime, session.sessionId);
    if (ownerErr)
        return ownerErr;
    const validated = DecisionSchema.safeParse(args.decision);
    if (!validated.success) {
        const hint = buildDecisionValidationHint(args.plan_id, args.decision);
        return failure(ctx.command, 'validation', `invalid decision: ${validated.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`).join('; ')}\n\n${hint}`, { issues: validated.error.issues, hint });
    }
    try {
        rt.runtime.cycleEngine.submitDecision(args.plan_id, validated.data);
        return success(ctx.command, { plan_id: args.plan_id, status: 'queued' });
    }
    catch (err) {
        return failure(ctx.command, 'validation', err instanceof Error ? err.message : String(err), {
            plan_id: args.plan_id,
        });
    }
};
function buildDecisionValidationHint(planId, decision) {
    const problems = [];
    const d = decision;
    if (!d || typeof d !== 'object' || Array.isArray(d)) {
        problems.push('`args.decision` must be an object, not a string or missing value.');
    }
    else {
        if (!Array.isArray(d.last_cycle))
            problems.push('`decision.last_cycle` must be an array.');
        if (!Array.isArray(d.next_cycle))
            problems.push('`decision.next_cycle` must be an array (use [] when there are no new tasks).');
        if (typeof d.plan_complete !== 'boolean')
            problems.push('`decision.plan_complete` must be a boolean true/false, not "true"/"false".');
        const lastCycle = Array.isArray(d.last_cycle) ? d.last_cycle : [];
        if (lastCycle.some((item) => !item ||
            typeof item !== 'object' ||
            typeof item.reason !== 'string')) {
            problems.push('Every `last_cycle` item needs a non-empty `reason`, even for `accept`.');
        }
    }
    const example = {
        command: 'decision',
        args: {
            plan_id: planId,
            decision: {
                last_cycle: [
                    {
                        task_id: '<task-id-from-cycle-report>',
                        verdict: 'accept',
                        reason: 'Accepted: output is ready to proceed.',
                    },
                ],
                next_cycle: [],
                plan_complete: false,
            },
        },
    };
    return [
        'Fix the `team` tool call shape and retry. Common issues:',
        ...(problems.length > 0
            ? problems.map((p) => `- ${p}`)
            : ['- Use the exact object shape below.']),
        '',
        'Valid example:',
        JSON.stringify(example, null, 2),
    ].join('\n');
}
/**
 * `team plan extend-timeout` — owner adds extra time to a producing task.
 *
 * Enforces a 60-min ceiling per call (mirrors daemon
 * `api/team.ts:MAX_OWNER_TIMEOUT_EXTENSION_MS`) to prevent runaway tasks
 * from being kept alive forever via one large extension.
 */
const MAX_OWNER_TIMEOUT_EXTENSION_MS = 60 * 60 * 1000;
export const handleTeamPlanExtendTimeout = async (ctx, args) => {
    const rt = requireTeamRuntime(ctx);
    if ('failure' in rt)
        return rt.failure;
    const session = requireOwnerSession(ctx);
    if ('failure' in session)
        return session.failure;
    const ownerErr = checkOwner(ctx, args.plan_id, rt.runtime, session.sessionId);
    if (ownerErr)
        return ownerErr;
    const extraMs = typeof args.extra_ms === 'number' ? args.extra_ms : (args.extra_minutes ?? 0) * 60 * 1000;
    if (!Number.isFinite(extraMs) || extraMs <= 0) {
        return failure(ctx.command, 'validation', 'extra_ms or extra_minutes must be a positive number');
    }
    if (extraMs > MAX_OWNER_TIMEOUT_EXTENSION_MS) {
        return failure(ctx.command, 'validation', 'timeout extension cannot exceed 60 minutes per request');
    }
    try {
        const result = rt.runtime.cycleEngine.extendTaskTimeout(backgroundCtx(), args.plan_id, args.task_id, Math.round(extraMs));
        return success(ctx.command, {
            plan_id: args.plan_id,
            task_id: args.task_id,
            status: 'extended',
            added_ms: Math.round(extraMs),
            ...result,
        });
    }
    catch (err) {
        return failure(ctx.command, 'validation', err instanceof Error ? err.message : String(err), {
            plan_id: args.plan_id,
            task_id: args.task_id,
        });
    }
};
/**
 * `team plan unblock` — owner force-flips a task from `blocked` → `ready`,
 * bypassing depends_on. Use when the dependency graph is wrong at runtime.
 *
 * Delegates to `store.unblockTask` which raises AppError 404/409 on
 * invalid state — we surface those as validation failures.
 */
export const handleTeamPlanUnblock = async (ctx, args) => {
    const rt = requireTeamRuntime(ctx);
    if ('failure' in rt)
        return rt.failure;
    const session = requireOwnerSession(ctx);
    if ('failure' in session)
        return session.failure;
    const ownerErr = checkOwner(ctx, args.plan_id, rt.runtime, session.sessionId);
    if (ownerErr)
        return ownerErr;
    try {
        const result = rt.runtime.planStore.unblockTask(args.plan_id, args.task_id);
        return success(ctx.command, {
            plan_id: args.plan_id,
            task_id: args.task_id,
            status: 'unblocked',
            ...result,
        });
    }
    catch (err) {
        return failure(ctx.command, 'validation', err instanceof Error ? err.message : String(err), {
            plan_id: args.plan_id,
            task_id: args.task_id,
        });
    }
};
/**
 * `team plan cancel` — stop running workers + mark plan cancelled.
 * Preserves the plan directory (plan.yaml / state.json / outputs /
 * workspace) so the owner can inspect deliverables after cancel.
 *
 * Order matters (mirrors daemon api/team.ts:430-445 comment):
 *   1. `store.markCancelled(planId, sessionId)` writes status + appends
 *      board.md audit entry BEFORE
 *   2. `engine.cancel(ctx, planId)` which would otherwise short-circuit
 *      on the already-cancelled status.
 */
export const handleTeamPlanCancel = async (ctx, args) => {
    const rt = requireTeamRuntime(ctx);
    if ('failure' in rt)
        return rt.failure;
    const session = requireOwnerSession(ctx);
    if ('failure' in session)
        return session.failure;
    const ownerErr = checkOwner(ctx, args.plan_id, rt.runtime, session.sessionId);
    if (ownerErr)
        return ownerErr;
    const state = rt.runtime.planStore.getState(args.plan_id);
    if (!state) {
        return failure(ctx.command, 'validation', `Plan not found: ${args.plan_id}`, {
            plan_id: args.plan_id,
        });
    }
    if (state.status === 'cancelled') {
        return success(ctx.command, {
            plan_id: args.plan_id,
            status: 'noop',
            message: 'Plan already cancelled',
        });
    }
    if (state.status === 'completed' || state.status === 'failed') {
        return success(ctx.command, {
            plan_id: args.plan_id,
            status: 'noop',
            message: `Plan already ${state.status} — cancel is a no-op for non-cancelled terminal states`,
        });
    }
    try {
        rt.runtime.planStore.markCancelled(args.plan_id, session.sessionId);
        await rt.runtime.cycleEngine.cancel(backgroundCtx(), args.plan_id);
        return success(ctx.command, { plan_id: args.plan_id, status: 'cancelled' });
    }
    catch (err) {
        return failure(ctx.command, 'validation', err instanceof Error ? err.message : String(err), {
            plan_id: args.plan_id,
        });
    }
};
// path: '../path-guard.js' for the resolveWithinWorkspace re-export the bash
// tool family uses; team handlers reuse it for plan_path safety.
//# sourceMappingURL=team.js.map