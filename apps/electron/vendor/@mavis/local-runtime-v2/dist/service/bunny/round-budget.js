import { isTurnClosedByTerminatingTools } from '@mavis/agent-core/tools';
import { REVIEW_CONCLUDED_WITHOUT_DELIVERY_FOLLOW_UP, reviewRoundBudgetReminder, roundBudgetRefusal, roundBudgetReminder, } from '../coordinator-text/index.js';
import { BUNNY_AGENT_NAME } from './contracts.js';
/**
 * Bunny turn round budget.
 *
 * Counts tool rounds the same way the Bunny prompt's `<dispatch>` section
 * does, so the model is never stopped by a count it does not recognise:
 * - parallel calls in one assistant step are one round;
 * - a `run_code` call counts its dependent internal steps: sub-calls that start
 *   before any earlier counted sibling finished share one round, a sub-call
 *   started after a counted sibling finished opens the next round;
 * - only the calls below are free: dispatching (`assignment_create`, also
 *   inside `run_code`), `send_to_user`, and the writes themselves — memory,
 *   the working-state ledger, schedules, and the coordinator's own space and
 *   task model writes (`bunny_task_space_create`, `bunny_task_space_update`, `bunny_task_space_context_write`,
 *   `bunny_task_model_set`).
 *   Finding the tool, probing paths or reading anything else for such a write
 *   still counts, a ledger `list` and every space or task model read included.
 *
 * Known approximation: the PTC scheduler runs sequential tools (bash, MCP, …)
 * one at a time even inside `Promise.all`, so independent calls to such tools
 * inside one `run_code` count as separate rounds.
 */
/**
 * Top-level tools that never count as a round and are never blocked.
 * @internal Exported only for focused tests.
 */
export const BUNNY_UNCOUNTED_TOOLS = Object.freeze([
    'assignment_create',
    'assignment_send',
    'assignment_summary',
    // Reading a stored verdict is the step before concluding, not a round of work: a wake Turn
    // that has to claim before it may summarize would otherwise pay for the gate's own bookkeeping.
    'assignment_claim_verdict',
    'send_to_user',
    'remember',
    'cron_create',
    'cron_update',
    'cron_delete',
    'self_reminder',
    // The coordinator's own writes: the space the user just agreed to, its
    // settings, context.md, and the task model the user just chose. Their reads
    // (bunny_task_space_list, bunny_task_space_get, bunny_task_space_context_read, bunny_task_model_list) still count.
    'bunny_task_space_create',
    'bunny_task_space_update',
    'bunny_task_space_context_write',
    'bunny_task_model_set',
]);
/** `working_state` actions that write the ledger; `list` reads it and counts. */
const UNCOUNTED_WORKING_STATE_ACTIONS = new Set(['add', 'update', 'close']);
const BUNNY_ROUND_REMIND_AT = 3;
const BUNNY_REVIEW_ROUND_REMIND_AT = 4;
const BUNNY_ROUND_BLOCK_AT = 6;
const DISPATCH_TOOL = 'assignment_create';
const RUN_CODE_TOOL = 'run_code';
const WORKING_STATE_TOOL = 'working_state';
/** What the user reads as this Turn's answer; a plain tool row is never one of these. */
const SEND_TO_USER_TOOL = 'send_to_user';
const TASK_CARD_TOOL = 'assignment_summary';
const SUMMARY_SCHEMA_VERSION = 2;
/**
 * How long a review-round read may take.
 *
 * The host awaits `on_step_end` and `turn_end` handlers, so this read sits on both paths. It
 * is bounded because a store read that never settles would otherwise hold a step or keep the
 * Turn from ever ending; a read that is slow or fails degrades to "no review history read".
 */
const REVIEW_ROUND_READ_TIMEOUT_MS = 500;
const uncountedTools = new Set(BUNNY_UNCOUNTED_TOOLS);
/**
 * True when one direct tool call (top-level or inside `run_code`) costs a round.
 * @internal Exported only for focused tests.
 */
export function isBunnyRoundCountedCall(toolName, args) {
    if (uncountedTools.has(toolName))
        return false;
    if (toolName === WORKING_STATE_TOOL)
        return !UNCOUNTED_WORKING_STATE_ACTIONS.has(argument(args, 'action'));
    return true;
}
export function createBunnyRoundBudgetExtension(options = {}) {
    const remindAt = options.remindAtRound ?? BUNNY_ROUND_REMIND_AT;
    const reviewRemindAt = options.reviewRemindAtRound ?? BUNNY_REVIEW_ROUND_REMIND_AT;
    const blockAt = options.blockAtRound ?? BUNNY_ROUND_BLOCK_AT;
    const turns = new Map();
    const stateFor = (ctx) => {
        const key = turnKey(ctx);
        const existing = turns.get(key);
        if (existing)
            return existing;
        const next = {
            blockEnabled: readFlag(options.isBlockEnabled),
            rounds: 0,
            firstDispatchRound: null,
            reminderInjected: false,
            deliveryFollowUpAsked: false,
            isReviewRound: false,
            blockedCalls: 0,
            sendToUserCalls: 0,
            taskCardCalls: 0,
            deliveredSendToUser: 0,
            concludedSummaries: 0,
            pendingDeliveries: new Set(),
            pendingSummaries: new Set(),
            runCodes: new Map(),
            blockedTopLevel: new Set(),
        };
        turns.set(key, next);
        return next;
    };
    const beforeToolCall = (event, _signal, ctx) => {
        if (ctx.agentName !== BUNNY_AGENT_NAME)
            return undefined;
        try {
            const state = stateFor(ctx);
            const call = {
                id: event.toolCall.id,
                name: event.toolCall.name,
                args: event.args ?? event.toolCall.arguments,
                parentId: event.parentToolCallId,
            };
            const refused = admitCall(state, call, blockAt);
            // Counted only when the call actually runs: a refused call produced nothing.
            if (!refused)
                recordAdmittedOutput(state, call);
            return refused;
        }
        catch {
            // Budget bookkeeping must never change whether a tool runs.
            return undefined;
        }
    };
    const afterToolCall = (event, _signal, ctx) => {
        if (ctx.agentName !== BUNNY_AGENT_NAME)
            return undefined;
        try {
            const state = turns.get(turnKey(ctx));
            if (state)
                settleCallOutcome(state, event.toolCall.id, event.isError === true);
            const parent = event.parentToolCallId
                ? state?.runCodes.get(event.parentToolCallId)
                : undefined;
            const args = event.args ?? event.toolCall.arguments;
            if (parent && parent.waves > 0 && isBunnyRoundCountedCall(event.toolCall.name, args)) {
                parent.waveSettled = true;
            }
        }
        catch {
            // fail open
        }
        return undefined;
    };
    const onStepEnd = async (event, ctx) => {
        if (ctx.agentName !== BUNNY_AGENT_NAME)
            return;
        try {
            const state = stateFor(ctx);
            state.rounds += stepRounds(state, event.message);
            state.runCodes.clear();
            state.blockedTopLevel.clear();
            settleStepToolResults(state, event.toolResults);
            if (event.signal.aborted || isStoppedByFault(event.message))
                return;
            if (isExitingTurnStep(event.message, event.toolResults)) {
                await maybeAskConcludedDelivery(state, event, options.reviewRound, ctx);
                return;
            }
            await maybeSteerRoundReminder(state, event, {
                remindAt,
                reviewRemindAt,
                blockAt,
                reviewRound: options.reviewRound,
                ctx,
            });
        }
        catch {
            // Counting, steering and follow-up fail open.
        }
    };
    const onTurnEnd = (event, ctx) => {
        if (ctx.agentName !== BUNNY_AGENT_NAME)
            return;
        const key = turnKey(ctx);
        const state = turns.get(key);
        turns.delete(key);
        // The Turn is already over and its state is released above. The host may still await this
        // handler before it commits the terminal state, so the review read inside is bounded
        // (REVIEW_ROUND_READ_TIMEOUT_MS) and degrades to 0 rather than holding that commit open.
        return summarizeTurn(state, event, ctx);
    };
    const summarizeTurn = async (state, event, ctx) => {
        try {
            const reviewed = (await readReviewCounts(options.reviewRound, ctx)).reviewedTaskCount;
            notifyBestEffort(options.onTurnSummary, {
                schemaVersion: SUMMARY_SCHEMA_VERSION,
                sessionId: ctx.sessionId,
                turnId: ctx.turnId,
                agentName: ctx.agentName,
                roundsCounted: state?.rounds ?? 0,
                reviewRound: reviewed > 0,
                reviewedTaskCount: reviewed,
                visibleOutput: visibleOutputOf(state),
                delivery: deliveryOf(state),
                referencedSessionRead: readProbe(options.referencedSessionRead, ctx),
                firstDispatchRound: state?.firstDispatchRound ?? null,
                dispatched: state?.firstDispatchRound != null,
                reminderInjected: state?.reminderInjected ?? false,
                blockEnabled: state?.blockEnabled ?? readFlag(options.isBlockEnabled),
                blockedCalls: state?.blockedCalls ?? 0,
                ...(event.reason ? { endReason: event.reason } : {}),
            });
        }
        catch {
            // A summary is observability; losing one never affects the Turn that ended.
        }
    };
    return {
        id: 'bunny-round-budget',
        description: 'Count Bunny tool rounds by the <dispatch> rules, remind once, and optionally refuse counted tools.',
        init(pi) {
            pi.on('before_tool_call', beforeToolCall);
            pi.on('after_tool_call', afterToolCall);
            pi.on('on_step_end', onStepEnd);
            pi.on('turn_end', onTurnEnd);
        },
    };
}
/** Records one call's admission and refuses it when it would open the block round. */
function admitCall(state, call, blockAt) {
    const parent = call.parentId ? runCodeFor(state, call.parentId) : undefined;
    // A top-level run_code is counted at step end by the waves of its sub-calls.
    if (call.name === RUN_CODE_TOOL && !parent)
        return undefined;
    if (!isBunnyRoundCountedCall(call.name, call.args)) {
        recordDispatch(state, call, parent);
        return undefined;
    }
    return admitCountedCall(state, call, parent, blockAt);
}
function admitCountedCall(state, call, parent, blockAt) {
    // Top-level calls of one step share its first round; run_code sub-calls
    // stack their waves after the waves other run_code calls already opened.
    const wave = parent ? nextWave(parent) : 1;
    const round = parent
        ? state.rounds + liveRunCodeRounds(state, call.parentId) + wave
        : state.rounds + 1;
    if (state.blockEnabled && round >= blockAt) {
        state.blockedCalls += 1;
        if (!parent)
            state.blockedTopLevel.add(call.id);
        return { block: true, reason: roundBudgetRefusal(round - 1, blockAt) };
    }
    if (parent && wave > parent.waves) {
        parent.waves = wave;
        parent.waveSettled = false;
    }
    return undefined;
}
/** Counts one call that put something in front of the user; tool rows are not output. */
function recordAdmittedOutput(state, call) {
    if (call.name === SEND_TO_USER_TOOL) {
        state.sendToUserCalls += 1;
        if (!call.parentId && hasDeliveryContent(call.args))
            state.pendingDeliveries.add(call.id);
    }
    if (call.name === TASK_CARD_TOOL) {
        state.taskCardCalls += 1;
        state.pendingSummaries.add(call.id);
    }
}
function hasDeliveryContent(args) {
    if (typeof args !== 'object' || args === null || !('content' in args))
        return true;
    const content = Reflect.get(args, 'content');
    return typeof content === 'string' && content.trim().length > 0;
}
function settleCallOutcome(state, toolCallId, isError) {
    if (state.pendingDeliveries.delete(toolCallId) && !isError)
        state.deliveredSendToUser += 1;
    if (state.pendingSummaries.delete(toolCallId) && !isError)
        state.concludedSummaries += 1;
}
/**
 * Settles this step's deliveries and conclusions from its tool results, then releases the
 * pending ids. `after_tool_call` settles them first in production; the sweep keeps a step
 * that never reported one from carrying its ids into the next step.
 *
 * An id still pending after the results are read is a call that was admitted and produced no
 * result row at all — the step was interrupted, stopped or faulted before it ran. It is
 * dropped, never counted: `deliveredSendToUser` and `concludedSummaries` mean "settled as a
 * success", and counting an unknown outcome as a delivery both contradicts that and suppresses
 * the concluded-without-delivery follow-up exactly when the outcome is least known.
 */
function settleStepToolResults(state, toolResults) {
    for (const item of toolResults) {
        const id = argument(item, 'toolCallId');
        if (typeof id === 'string')
            settleCallOutcome(state, id, argument(item, 'isError') === true);
    }
    state.pendingDeliveries.clear();
    state.pendingSummaries.clear();
}
function isStoppedByFault(message) {
    const stopReason = argument(message, 'stopReason');
    return stopReason === 'error' || stopReason === 'aborted';
}
function isExitingTurnStep(message, toolResults) {
    return toolCalls(message).length === 0 || isTurnClosedByTerminatingTools(message, toolResults);
}
function waitsForUser(toolResults) {
    return toolResults.some((item) => argument(argument(item, 'details'), 'waiting_for_user') === true);
}
async function maybeSteerRoundReminder(state, event, input) {
    if (state.reminderInjected || state.rounds < Math.min(input.remindAt, input.reviewRemindAt))
        return;
    if (!state.isReviewRound && input.reviewRound) {
        const counts = await readReviewCounts(input.reviewRound, input.ctx);
        if (counts.reviewedTaskCount > 0)
            state.isReviewRound = true;
    }
    const threshold = state.isReviewRound ? input.reviewRemindAt : input.remindAt;
    if (state.rounds < threshold)
        return;
    const blockLimit = state.blockEnabled ? input.blockAt : undefined;
    const content = state.isReviewRound
        ? reviewRoundBudgetReminder(state.rounds, blockLimit)
        : roundBudgetReminder(state.rounds, blockLimit);
    event.agent.steer({ role: 'user', content, timestamp: Date.now() });
    state.reminderInjected = true;
}
/**
 * Asks once when this step would end the Turn with a concluded review and nothing delivered.
 *
 * The task graph is read here rather than reused from the reminder path: a Turn can send a
 * review back or cancel it after that read, and only the state at this step decides whether
 * finishing now would close a task silently.
 */
async function maybeAskConcludedDelivery(state, event, reviewRound, ctx) {
    if (state.deliveryFollowUpAsked || state.deliveredSendToUser > 0)
        return;
    if (waitsForUser(event.toolResults) || event.agent.hasQueuedMessages?.() === true)
        return;
    // An explicit conclusion needs no read; the plain-text ending follow-up and any queued
    // steering were already excluded above, so nothing else asks for this Turn.
    const concluded = state.concludedSummaries > 0 || (await readReviewCounts(reviewRound, ctx)).openReviewCount > 0;
    if (!concluded)
        return;
    event.agent.followUp({
        role: 'user',
        content: [{ type: 'text', text: REVIEW_CONCLUDED_WITHOUT_DELIVERY_FOLLOW_UP }],
        timestamp: Date.now(),
    });
    // Marked only once the ask is queued: a throw leaves the next exiting step free to ask again.
    state.deliveryFollowUpAsked = true;
}
/** What the Turn put in front of the user, counting admitted calls. */
function visibleOutputOf(state) {
    const sendToUserCalls = state?.sendToUserCalls ?? 0;
    const taskCardCalls = state?.taskCardCalls ?? 0;
    return {
        sendToUserCalls,
        taskCardCalls,
        hasUserVisibleOutput: sendToUserCalls + taskCardCalls > 0,
    };
}
/** What the Turn actually delivered and concluded, as its tool results settled. */
function deliveryOf(state) {
    return {
        deliveredSendToUser: state?.deliveredSendToUser ?? 0,
        concludedSummaries: state?.concludedSummaries ?? 0,
        deliveryFollowUpAsked: state?.deliveryFollowUpAsked ?? false,
    };
}
const ZERO_REVIEW_COUNTS = { reviewedTaskCount: 0, openReviewCount: 0 };
/**
 * Tasks this Turn holds or concluded a review for; zeroes whenever the marker cannot be read in
 * time. Bounded because both `on_step_end` and `turn_end` sit on the Turn path.
 */
async function readReviewCounts(read, ctx) {
    if (!read)
        return ZERO_REVIEW_COUNTS;
    let timer;
    try {
        const timeout = new Promise((resolve) => {
            timer = setTimeout(() => resolve(ZERO_REVIEW_COUNTS), REVIEW_ROUND_READ_TIMEOUT_MS);
            timer.unref?.();
        });
        return await Promise.race([readCountedRound(read, ctx), timeout]);
    }
    catch {
        return ZERO_REVIEW_COUNTS;
    }
    finally {
        if (timer)
            clearTimeout(timer);
    }
}
async function readCountedRound(read, ctx) {
    try {
        const result = await read({ sessionId: ctx.sessionId, turnId: ctx.turnId });
        const reviewedTaskCount = positiveCount(result?.reviewedTaskCount);
        const openReviewCount = result?.openReviewCount === undefined
            ? reviewedTaskCount
            : positiveCount(result.openReviewCount);
        return { reviewedTaskCount, openReviewCount };
    }
    catch {
        return ZERO_REVIEW_COUNTS;
    }
}
function positiveCount(value) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}
/** The probe's answer, or `unavailable` when there is no probe or it failed. */
function readProbe(read, ctx) {
    if (!read)
        return 'unavailable';
    try {
        const result = read({ sessionId: ctx.sessionId, turnId: ctx.turnId });
        return result === 'read' || result === 'not_read' ? result : 'unavailable';
    }
    catch {
        return 'unavailable';
    }
}
function recordDispatch(state, call, parent) {
    if (call.name !== DISPATCH_TOOL || state.firstDispatchRound !== null)
        return;
    const opened = parent ? liveRunCodeRounds(state, call.parentId) + parent.waves : 0;
    state.firstDispatchRound = state.rounds + opened;
}
function runCodeFor(state, parentId) {
    const existing = state.runCodes.get(parentId);
    if (existing)
        return existing;
    const next = { waves: 0, waveSettled: false };
    state.runCodes.set(parentId, next);
    return next;
}
function nextWave(parent) {
    if (parent.waves === 0)
        return 1;
    return parent.waveSettled ? parent.waves + 1 : parent.waves;
}
/** Rounds already opened in this step by run_code calls other than `exceptParent`. */
function liveRunCodeRounds(state, exceptParent) {
    let rounds = 0;
    for (const [id, parent] of state.runCodes) {
        if (id !== exceptParent)
            rounds += parent.waves;
    }
    return rounds;
}
/**
 * Parallel top-level calls are one round. Each run_code adds its own waves; one
 * whose sub-calls were all free (or refused) adds none, and one with no
 * sub-calls at all is an ordinary single round.
 */
function stepRounds(state, message) {
    let topLevel = 0;
    let runCode = 0;
    for (const call of toolCalls(message)) {
        if (call.name === RUN_CODE_TOOL) {
            const parent = state.runCodes.get(call.id);
            runCode += parent ? parent.waves : 1;
            continue;
        }
        if (state.blockedTopLevel.has(call.id))
            continue;
        if (isBunnyRoundCountedCall(call.name, call.arguments))
            topLevel = 1;
    }
    return Math.max(topLevel, runCode);
}
function toolCalls(message) {
    const value = message;
    if (value?.role !== 'assistant' || !Array.isArray(value.content))
        return [];
    return value.content.flatMap((block) => {
        const call = block;
        return call?.type === 'toolCall' && typeof call.id === 'string' && typeof call.name === 'string'
            ? [{ id: call.id, name: call.name, arguments: call.arguments }]
            : [];
    });
}
function argument(args, name) {
    return typeof args === 'object' && args !== null ? Reflect.get(args, name) : undefined;
}
function turnKey(ctx) {
    return `${ctx.sessionId}\u0000${ctx.turnId}`;
}
function readFlag(read) {
    try {
        return read?.() === true;
    }
    catch {
        return false;
    }
}
function notifyBestEffort(observer, value) {
    try {
        observer?.(value);
    }
    catch {
        // Observers never affect Turn execution or cleanup.
    }
}
/** Projects a summary to the turn log, the trace and the Turn's business event. */
export function createBunnyRoundBudgetObserver(telemetry) {
    return (summary) => telemetry.roundBudget(summary, {
        schema_version: summary.schemaVersion,
        policy_version: 'bunny-round-budget-v1',
        session_id: summary.sessionId,
        turn_id: summary.turnId,
        agent_name: summary.agentName,
        rounds_counted: summary.roundsCounted,
        review_round: summary.reviewRound,
        reviewed_task_count: summary.reviewedTaskCount,
        send_to_user_calls: summary.visibleOutput.sendToUserCalls,
        task_card_calls: summary.visibleOutput.taskCardCalls,
        has_user_visible_output: summary.visibleOutput.hasUserVisibleOutput,
        delivered_send_to_user: summary.delivery.deliveredSendToUser,
        concluded_summaries: summary.delivery.concludedSummaries,
        delivery_follow_up_asked: summary.delivery.deliveryFollowUpAsked,
        referenced_session_read: summary.referencedSessionRead,
        first_dispatch_round: summary.firstDispatchRound,
        dispatched: summary.dispatched,
        reminder_injected: summary.reminderInjected,
        block_enabled: summary.blockEnabled,
        blocked_calls: summary.blockedCalls,
        ...(summary.endReason ? { end_reason: summary.endReason } : {}),
    });
}
//# sourceMappingURL=round-budget.js.map