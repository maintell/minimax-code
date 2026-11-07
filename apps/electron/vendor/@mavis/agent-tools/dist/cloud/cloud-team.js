/**
 * CloudTeamTool —— dedicated LLM-facing tool for the cloud team plan engine.
 *
 * This intentionally lifts team-plan operations out of the generic `mavis`
 * management tool. The schema stays CLI-like (`command` + `args`) so the
 * model can copy a compact command name, while the tool description owns the
 * team-specific planning/decision contract instead of burying it among agent,
 * cron, session, and drive commands.
 */
var __esDecorate = (this && this.__esDecorate) || function (ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
    function accept(f) { if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected"); return f; }
    var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
    var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
    var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
    var _, done = false;
    for (var i = decorators.length - 1; i >= 0; i--) {
        var context = {};
        for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
        for (var p in contextIn.access) context.access[p] = contextIn.access[p];
        context.addInitializer = function (f) { if (done) throw new TypeError("Cannot add initializers after decoration has completed"); extraInitializers.push(accept(f || null)); };
        var result = (0, decorators[i])(kind === "accessor" ? { get: descriptor.get, set: descriptor.set } : descriptor[key], context);
        if (kind === "accessor") {
            if (result === void 0) continue;
            if (result === null || typeof result !== "object") throw new TypeError("Object expected");
            if (_ = accept(result.get)) descriptor.get = _;
            if (_ = accept(result.set)) descriptor.set = _;
            if (_ = accept(result.init)) initializers.unshift(_);
        }
        else if (_ = accept(result)) {
            if (kind === "field") initializers.unshift(_);
            else descriptor[key] = _;
        }
    }
    if (target) Object.defineProperty(target, contextIn.name, descriptor);
    done = true;
};
var __runInitializers = (this && this.__runInitializers) || function (thisArg, initializers, value) {
    var useValue = arguments.length > 2;
    for (var i = 0; i < initializers.length; i++) {
        value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
    }
    return useValue ? value : void 0;
};
import { Type } from '@sinclair/typebox';
import { bindTool, } from '@mavis/agent-core/tools';
import { dispatchTeamTool, normalizeTeamDecision } from './mavis/commands/team.js';
import { toToolResult } from './mavis/output.js';
const NonEmptyString = (description) => Type.String({ minLength: 1, description });
// Mirrors @mavis/team DecisionSchema. Model tool-call decoders rely on these
// types; an untyped `decision` comes back with arrays collapsed into objects
// and booleans as strings.
const TeamDecisionInput = Type.Object({
    last_cycle: Type.Array(Type.Object({
        task_id: NonEmptyString('Task id from the cycle report.'),
        verdict: Type.Union([
            Type.Literal('accept'),
            Type.Literal('reject'),
            Type.Literal('override_accept'),
            Type.Literal('manual_retry'),
        ], { description: 'Owner verdict for the task.' }),
        reason: NonEmptyString('Owner reasoning; required even for accept.'),
    }), { description: 'Verdict for each task from the last cycle.' }),
    next_cycle: Type.Array(Type.Object({
        task_id: NonEmptyString('Task id; reuse an existing id to retry in the same session.'),
        title: NonEmptyString('Task title.'),
        prompt: NonEmptyString('Producer prompt.'),
        assigned_to: NonEmptyString('Producer agent name, copied exactly from agent list.'),
        verified_by: Type.Optional(Type.Union([
            NonEmptyString('Verifier agent name.'),
            Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
        ], {
            description: 'Verifier agent name(s).',
        })),
        verify_skip_reason: Type.Optional(NonEmptyString('Why the task can skip verification; required when verified_by is omitted.')),
        role: Type.Optional(Type.Union([Type.Literal('produce'), Type.Literal('verify-as-task')])),
        verify_prompt: Type.Optional(Type.Union([Type.String(), Type.Record(Type.String(), Type.String())], {
            description: 'Verifier prompt, or a map of verifier name to prompt.',
        })),
        timeout_ms: Type.Optional(Type.Integer({ minimum: 1, description: 'Task timeout in ms.' })),
    }), { description: 'Tasks to execute next; use [] when there are none.' }),
    plan_complete: Type.Boolean({ description: 'true when the plan objective is achieved.' }),
    message_to_user: Type.Optional(Type.String({ description: 'Message relayed to the user.' })),
}, {
    description: 'Decision object for decision. Pass a JSON object, not a string; arrays stay arrays ([] when empty) and plan_complete is a boolean. Example: {"last_cycle":[{"task_id":"task-1","verdict":"accept","reason":"Output verified."}],"next_cycle":[],"plan_complete":true}',
});
const TeamToolSchema = Type.Object({
    command: Type.String({
        description: 'Team action verb: run, status, steer, decision, extend-timeout, unblock, or cancel. All commands operate on plans.',
    }),
    args: Type.Optional(Type.Object({
        plan_path: Type.Optional(Type.String({ description: 'Workspace plan YAML path for run.' })),
        plan_id: Type.Optional(Type.String({ description: 'Team plan id.' })),
        message: Type.Optional(Type.String({ description: 'Owner guidance for steer.' })),
        decision: Type.Optional(TeamDecisionInput),
        task_id: Type.Optional(Type.String({ description: 'Task id for task-scoped commands.' })),
        extra_minutes: Type.Optional(Type.Number({ description: 'Extra timeout in minutes for extend-timeout.' })),
        extra_ms: Type.Optional(Type.Number({ description: 'Extra timeout in milliseconds for extend-timeout.' })),
    }, {
        additionalProperties: true,
        description: 'Command-specific arguments object. See the tool description for shapes.',
    })),
});
export const TeamToolDef = {
    name: 'team',
    description: `Dedicated tool for Mavis Agent Team plans — a producer-vs-verifier adversarial workflow with explicit owner decision points. Reach for it when independent verification matters: high-stakes deliverables, complex investigations, work where silent acceptance is too risky, or tasks needing real retries on verifier failure.

LIFECYCLE
  You launch a plan from a YAML file, monitor its workers, and submit a decision at the end of each cycle (accept / retry / propose next-cycle tasks). The engine handles producer ↔ verifier dispatch and surfaces a CycleReport for you to act on. For plan design, prompt writing, verdict semantics, and decision rubrics → load the \`mavis-team\` skill before drafting your first plan.

USAGE
  team({ command: "<action>", args: { ... } })

COMMANDS (all operate on plans)
  run             args: { plan_path: string }
                  Launch a workspace YAML; the current session becomes owner.
  status          args: { plan_id: string }
                  Read-only inspection — returns { plan_id, state, plan }.
  steer           args: { plan_id: string, message: string }
                  Owner injects guidance into running workers mid-cycle.
  decision        args: { plan_id: string, decision: object }
                  Owner submits cycle verdict + optional next-cycle tasks.
                  decision = { last_cycle: [...], next_cycle: [...] | [], plan_complete: boolean, message_to_user?: string }
                  See the \`mavis-team\` skill for verdict semantics and shape.
  extend-timeout  args: { plan_id: string, task_id: string, extra_minutes?: number, extra_ms?: number }
                  Buy one producing task more runtime (≤60 min per call).
  unblock         args: { plan_id: string, task_id: string }
                  Force a stuck \`blocked\` task to ready when \`depends_on\` was wrong.
  cancel          args: { plan_id: string }
                  Owner stops workers and marks the plan cancelled.

OUTPUT
  Success: { ok: true, command, response: <team response object> }
  Failure: { ok: false, command, error: { kind: "validation"|"workspace"|"unknown", message: string, ...details } }

EXAMPLES
  team({ command: "run", args: { plan_path: ".mavis/plans/draft/plan.yaml" } })
  team({ command: "status", args: { plan_id: "plan_a1b2c3d4" } })
  team({ command: "steer", args: { plan_id: "plan_a1b2c3d4", message: "switch to TypeScript types instead of any" } })
  team({ command: "decision", args: { plan_id: "plan_a1b2c3d4", decision: { last_cycle: [{ task_id: "task-1", verdict: "accept", reason: "Output verified." }], next_cycle: [], plan_complete: true } } })`,
    schema: TeamToolSchema,
    prepareArguments: prepareTeamToolArguments,
};
function prepareTeamToolArguments(raw) {
    if (typeof raw !== 'object' || raw === null)
        return raw;
    const input = raw;
    let args = input.args;
    if (typeof args === 'string' && args.trim().startsWith('{')) {
        try {
            args = JSON.parse(args);
        }
        catch {
            return raw;
        }
    }
    if (typeof args !== 'object' || args === null || Array.isArray(args)) {
        return (args === input.args ? raw : { ...input, args });
    }
    const argsRecord = args;
    if (!('decision' in argsRecord)) {
        return (args === input.args ? raw : { ...input, args });
    }
    return {
        ...input,
        args: { ...argsRecord, decision: normalizeTeamDecision(argsRecord.decision) },
    };
}
function normalizeTeamToolArgs(input) {
    return typeof input.args === 'object' && input.args !== null
        ? input.args
        : undefined;
}
let CloudTeamTool = (() => {
    let _classDecorators = [bindTool(TeamToolDef)];
    let _classDescriptor;
    let _classExtraInitializers = [];
    let _classThis;
    var CloudTeamTool = class {
        static { _classThis = this; }
        static {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(null) : void 0;
            __esDecorate(null, _classDescriptor = { value: _classThis }, _classDecorators, { kind: "class", name: _classThis.name, metadata: _metadata }, null, _classExtraInitializers);
            CloudTeamTool = _classThis = _classDescriptor.value;
            if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
            __runInitializers(_classThis, _classExtraInitializers);
        }
        deps;
        constructor(deps) {
            this.deps = deps;
        }
        async execute(ctx, input, signal) {
            const output = await dispatchTeamTool({
                workspaceRoot: this.deps.workspaceRoot,
                sessionId: ctx.sessionId,
                ...(this.deps.teamRuntime ? { teamRuntime: this.deps.teamRuntime } : {}),
            }, input.command, normalizeTeamToolArgs(input), signal);
            return toToolResult(output, TeamToolDef.name);
        }
    };
    return CloudTeamTool = _classThis;
})();
export { CloudTeamTool };
//# sourceMappingURL=cloud-team.js.map