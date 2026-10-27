/**
 * Thread Goal tool implementations — `@bindTool`ed concrete classes that
 * back `create_goal` / `update_goal` / `get_goal`. They are host-agnostic:
 * they only depend on the `ThreadGoalStore` port, so the same impls work
 * in local-runtime today and could be reused by cloud-runtime later.
 *
 * `create_goal` accepts an optional `onChanged` callback for hosts that expose
 * model-owned creation. `update_goal` is deliberately asymmetric: terminal
 * status is only a turn-local proposal, while a user-requested token-budget
 * edit goes through a separate host-owned durable mutation port.
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
import { bindTool, TURN_TERMINATING_TOOL_RESULT_DETAIL } from '@mavis/agent-core/tools';
import { ThreadGoalAlreadyExistsError } from './store-port.js';
import { CreateGoalToolDef, GetGoalToolDef, UpdateGoalToolDef, resolveUpdateGoalMode, } from './tool-defs.js';
import { validateThreadGoalObjective, } from './types.js';
import { digestThreadGoalObjective } from './objective-digest.js';
import { GOAL_FINAL_REPLY_INSTRUCTION } from './final-reply.js';
/** Build the canonical text+content payload returned to the model. */
function ok(toolName, body) {
    const text = JSON.stringify(body);
    return {
        tool_name: toolName,
        text,
        content: [{ type: 'text', text }],
        details: body,
    };
}
/**
 * Build the canonical rejection payload returned to the model.
 *
 * `isError` is part of the contract, not decoration: without it a refused
 * proposal reaches the model as ordinary tool output, so "your goal is stale /
 * paused / has no goal" reads like a normal result. GOAL-09 requires those
 * rejections to be legible as failures.
 */
function err(toolName, message, body = {}) {
    const payload = { error: message, ...body };
    const text = JSON.stringify(payload);
    return {
        tool_name: toolName,
        text,
        content: [{ type: 'text', text }],
        isError: true,
        details: payload,
    };
}
/**
 * End the Turn and record that fact where it survives.
 *
 * `terminate` is consumed by the agent loop and dropped; only `details` reach
 * canonical history. Turn continuation reads that tail, so a Turn ended by an
 * accepted `blocked` proposal or a stale rejection must be legible as "ended
 * on purpose" rather than "interrupted" — otherwise the product offers to
 * resume a Goal that is already settled. The marker stays out of the
 * serialized `text` so the model-facing payload is unchanged.
 *
 * An accepted `complete` proposal does not end the Turn: the worker still
 * writes its final reply (see `final-reply.ts`), so a Turn interrupted before
 * that reply stays resumable like any other interrupted Goal Turn.
 */
function endTurn(result) {
    return {
        ...result,
        details: { ...(result.details ?? {}), [TURN_TERMINATING_TOOL_RESULT_DETAIL]: true },
        terminate: true,
    };
}
function serializeGoal(goal) {
    return {
        goalId: goal.goalId,
        sessionId: goal.sessionId,
        objective: goal.objective,
        ...(goal.objectiveResources?.length ? { objectiveResources: goal.objectiveResources } : {}),
        status: goal.status,
        createdAt: goal.createdAt,
        updatedAt: goal.updatedAt,
        tokensUsed: goal.tokensUsed,
        timeUsedSeconds: goal.timeUsedSeconds,
        tokenBudget: goal.tokenBudget,
        ...(goal.accounting ? serializeRequestAccounting(goal.accounting) : {}),
    };
}
/** The request ledger the Goal's budget is counted in (accounting version 2). */
function serializeRequestAccounting(accounting) {
    return {
        accountingVersion: accounting.version,
        requestsUsed: accounting.requestsUsed,
        workRequests: accounting.workRequests,
        graceRequests: accounting.graceRequests,
        legacyTurns: accounting.legacyTurns,
        reservedRequests: accounting.reservedRequests,
        unknownRequests: accounting.unknownRequests,
        usageIncomplete: accounting.usageIncomplete,
    };
}
// ─── create_goal ───────────────────────────────────────────────────────
let CreateGoalTool = (() => {
    let _classDecorators = [bindTool(CreateGoalToolDef)];
    let _classDescriptor;
    let _classExtraInitializers = [];
    let _classThis;
    var CreateGoalTool = class {
        static { _classThis = this; }
        static {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(null) : void 0;
            __esDecorate(null, _classDescriptor = { value: _classThis }, _classDecorators, { kind: "class", name: _classThis.name, metadata: _metadata }, null, _classExtraInitializers);
            CreateGoalTool = _classThis = _classDescriptor.value;
            if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
            __runInitializers(_classThis, _classExtraInitializers);
        }
        store;
        onChanged;
        constructor(store, onChanged) {
            this.store = store;
            this.onChanged = onChanged;
        }
        async execute(ctx, input) {
            const objective = (input.objective ?? '').trim();
            const invalid = validateThreadGoalObjective(objective);
            if (invalid) {
                return err(CreateGoalToolDef.name, invalid);
            }
            // Give the model an explicit, actionable rejection before attempting the
            // write when work is already active or intentionally paused. The store's
            // uniqueness guard remains the race-safe backstop for concurrent creates
            // and for other unfinished statuses.
            const existing = await this.store.getBySession(ctx.sessionId);
            if (existing && (existing.status === 'active' || existing.status === 'paused')) {
                return err(CreateGoalToolDef.name, `this thread already has a goal with status ${existing.status}; do not create another goal`, {
                    existingGoalId: existing.goalId,
                    existingStatus: existing.status,
                });
            }
            // Pass through the optional token_budget verbatim. Schema already
            // enforced `minimum: 1`; the store treats `undefined` as "no cap".
            const createInput = {
                sessionId: ctx.sessionId,
                objective,
            };
            if (typeof input.token_budget === 'number') {
                createInput.tokenBudget = input.token_budget;
            }
            try {
                const goal = await this.store.create(createInput);
                this.onChanged?.(goal);
                return ok(CreateGoalToolDef.name, { goal: serializeGoal(goal) });
            }
            catch (e) {
                if (e instanceof ThreadGoalAlreadyExistsError) {
                    // codex-verbatim rejection (tool.rs handle_create).
                    return err(CreateGoalToolDef.name, 'cannot create a new goal because this thread has an unfinished goal; complete the existing goal first', { existingGoalId: e.existingGoalId });
                }
                throw e;
            }
        }
    };
    return CreateGoalTool = _classThis;
})();
export { CreateGoalTool };
// ─── update_goal ───────────────────────────────────────────────────────
let UpdateGoalTool = (() => {
    let _classDecorators = [bindTool(UpdateGoalToolDef)];
    let _classDescriptor;
    let _classExtraInitializers = [];
    let _classThis;
    var UpdateGoalTool = class {
        static { _classThis = this; }
        static {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(null) : void 0;
            __esDecorate(null, _classDescriptor = { value: _classThis }, _classDecorators, { kind: "class", name: _classThis.name, metadata: _metadata }, null, _classExtraInitializers);
            UpdateGoalTool = _classThis = _classDescriptor.value;
            if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
            __runInitializers(_classThis, _classExtraInitializers);
        }
        store;
        collector;
        budgetMutation;
        successfulBudgetUpdateTurns = new Set();
        constructor(store, collector, budgetMutation) {
            this.store = store;
            this.collector = collector;
            this.budgetMutation = budgetMutation;
        }
        async execute(ctx, input) {
            const mode = resolveUpdateGoalMode(input);
            if (mode === 'mixed') {
                return err(UpdateGoalToolDef.name, 'cannot combine status and token_budget in one update; set mode to "status" or "token_budget" to disambiguate');
            }
            if (mode === 'none') {
                return err(UpdateGoalToolDef.name, 'provide either status or token_budget');
            }
            if (mode === 'token_budget')
                return this.updateTokenBudget(ctx, input);
            return this.proposeTerminalStatus(ctx, input);
        }
        async proposeTerminalStatus(ctx, input) {
            const status = input.status;
            if (status !== 'complete' && status !== 'blocked') {
                return err(UpdateGoalToolDef.name, 'status must be "complete" or "blocked" when proposing a terminal status');
            }
            const existing = await this.store.getBySession(ctx.sessionId);
            if (!existing) {
                // codex-verbatim rejection (tool.rs handle_update).
                return err(UpdateGoalToolDef.name, 'cannot update goal because this thread has no goal');
            }
            if (existing.status === 'paused') {
                return err(UpdateGoalToolDef.name, 'cannot update goal because it is paused; resume the goal before completing or blocking it', { currentStatus: existing.status });
            }
            const summary = input.summary?.trim();
            const collection = this.collector.collect(ctx, {
                type: status === 'complete' ? 'completion_proposed' : 'block_proposed',
                goalId: existing.goalId,
                objectiveDigest: digestThreadGoalObjective(existing.objective),
                ...(summary ? { summary } : {}),
            });
            if (collection === 'not_a_goal_turn') {
                return err(UpdateGoalToolDef.name, 'cannot update goal because this turn is not bound to the goal; continue handling the user request in this turn without updating goal status. This tool cannot resume a goal', { reason: collection, currentGoal: serializeGoal(existing) });
            }
            if (collection === 'stale') {
                return endTurn(err(UpdateGoalToolDef.name, 'cannot update goal because the objective changed during this turn; stop the stale turn and continue with the updated goal before completing or blocking it', { currentGoal: serializeGoal(existing) }));
            }
            if (collection === 'no_goal') {
                return err(UpdateGoalToolDef.name, 'cannot update goal because this thread has no goal');
            }
            if (collection === 'paused') {
                return err(UpdateGoalToolDef.name, 'cannot update goal because it is paused; resume the goal before completing or blocking it', { currentStatus: 'paused' });
            }
            const accepted = ok(UpdateGoalToolDef.name, {
                proposal: {
                    status,
                    ...(summary ? { summary } : {}),
                    accepted: true,
                    settlement: 'pending_host_validation',
                },
                goal: serializeGoal(existing),
                goalSnapshotPhase: 'before_host_settlement',
                ...(status === 'complete' ? { instruction: GOAL_FINAL_REPLY_INSTRUCTION } : {}),
            });
            return status === 'complete' ? accepted : endTurn(accepted);
        }
        async updateTokenBudget(ctx, input) {
            if (input.token_budget !== null &&
                (typeof input.token_budget !== 'number' ||
                    !Number.isInteger(input.token_budget) ||
                    input.token_budget <= 0)) {
                return err(UpdateGoalToolDef.name, 'token_budget must be a positive integer or null');
            }
            if (typeof input.expected_goal_id !== 'string' ||
                input.expected_goal_id.length === 0 ||
                typeof input.expected_updated_at !== 'number' ||
                !Number.isInteger(input.expected_updated_at) ||
                input.expected_updated_at < 0) {
                return err(UpdateGoalToolDef.name, 'expected_goal_id and expected_updated_at are required; call get_goal immediately before updating the token budget');
            }
            if (!this.budgetMutation) {
                return err(UpdateGoalToolDef.name, 'token-budget updates are not available in this runtime');
            }
            const turnKey = `${ctx.sessionId}\u0000${ctx.turnId}`;
            if (this.successfulBudgetUpdateTurns.has(turnKey)) {
                return err(UpdateGoalToolDef.name, 'already updated the token budget during this turn; start a new explicit user turn for another update');
            }
            const result = await this.budgetMutation.updateTokenBudget(ctx, {
                tokenBudget: input.token_budget ?? null,
                expectedGoalId: input.expected_goal_id,
                expectedUpdatedAt: input.expected_updated_at,
            });
            if (!result.updated) {
                return err(UpdateGoalToolDef.name, result.error, {
                    ...(result.currentGoal ? { currentGoal: serializeGoal(result.currentGoal) } : {}),
                });
            }
            this.successfulBudgetUpdateTurns.add(turnKey);
            return ok(UpdateGoalToolDef.name, {
                updated: true,
                previousTokenBudget: result.previousTokenBudget,
                goal: serializeGoal(result.goal),
                resumed: result.resumed,
            });
        }
    };
    return UpdateGoalTool = _classThis;
})();
export { UpdateGoalTool };
// ─── get_goal ──────────────────────────────────────────────────────────
let GetGoalTool = (() => {
    let _classDecorators = [bindTool(GetGoalToolDef)];
    let _classDescriptor;
    let _classExtraInitializers = [];
    let _classThis;
    var GetGoalTool = class {
        static { _classThis = this; }
        static {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(null) : void 0;
            __esDecorate(null, _classDescriptor = { value: _classThis }, _classDecorators, { kind: "class", name: _classThis.name, metadata: _metadata }, null, _classExtraInitializers);
            GetGoalTool = _classThis = _classDescriptor.value;
            if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
            __runInitializers(_classThis, _classExtraInitializers);
        }
        store;
        constructor(store) {
            this.store = store;
        }
        async execute(ctx, _input) {
            const goal = await this.store.getBySession(ctx.sessionId);
            if (!goal) {
                return ok(GetGoalToolDef.name, { goal: null });
            }
            return ok(GetGoalToolDef.name, { goal: serializeGoal(goal) });
        }
    };
    return GetGoalTool = _classThis;
})();
export { GetGoalTool };
//# sourceMappingURL=tool-impls.js.map