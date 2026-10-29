import { createHash } from 'node:crypto';
import { RuntimeEventStatus, RuntimeEventType, } from '@mavis/agent-core/protocol';
import { formatRuntimeModelIdentity } from '../../model-system/index.js';
import { summarizeCommittedPiGoalUsage } from '../../session-system/index.js';
import { observeThreadGoalToolCall } from '../breaker/tool-call-observation.js';
import { classifyThreadGoalFailure } from '../settlement/failure-classification.js';
/**
 * Observes committed history and runtime status per Turn, then settles each Turn
 * with the Goal owner. The active-Turn timing registry is frozen while
 * settlement runs so the Goal accounts exactly the time the Turn was running.
 */
export function createGoalTurnLifecycle(input) {
    const { goals, turnTimings } = input;
    const turns = new Map();
    const state = (context) => {
        const key = turnKey(context);
        const workerModelKey = formatRuntimeModelIdentity(context.executionModel);
        const existing = turns.get(key);
        if (existing) {
            if (workerModelKey)
                existing.workerModelKey = workerModelKey;
            return existing;
        }
        const created = {
            tokens: 0,
            retracted: false,
            started: false,
            usageIncomplete: false,
            historyObserved: false,
            toolCalls: 0,
            toolWork: new Map(),
            ...(workerModelKey ? { workerModelKey } : {}),
        };
        turns.set(key, created);
        return created;
    };
    const ensureStarted = (context, observed) => {
        if (observed.started)
            return;
        observed.started = true;
        turnTimings.begin(context.sessionId, context.turnId, context.provenance?.source);
    };
    const observer = {
        observeHistoryCommitted: ({ context, change }) => {
            const observed = state(context);
            if (change.reason === 'messageDelta') {
                const usage = summarizeCommittedPiGoalUsage(change.messages);
                observed.tokens += usage.tokens;
                observed.usageIncomplete ||= usage.incomplete;
                const questionnaireFailed = readLastQuestionnaireFailure(change.messages);
                if (questionnaireFailed !== undefined)
                    observed.questionnaireFailed = questionnaireFailed;
                observed.historyObserved = true;
                observed.toolCalls += countCommittedToolCalls(change.messages);
                recordCommittedToolWork(observed.toolWork, change.messages);
                const finalAssistant = readLastAssistantText(change.messages);
                if (finalAssistant.seen) {
                    if (finalAssistant.text === undefined)
                        delete observed.finalAssistantText;
                    else
                        observed.finalAssistantText = finalAssistant.text;
                }
            }
            if (change.operation.kind === 'output-recall' ||
                change.operation.kind === 'turn-retraction') {
                observed.retracted = true;
            }
        },
        observeRuntimeEvent: ({ context, event }) => {
            const status = observedRuntimeStatus(event);
            if (!status)
                return;
            const observed = state(context);
            ensureStarted(context, observed);
            if (status === 'failed') {
                observed.failureClass = preferFailureClass(observed.failureClass, classifyThreadGoalFailure(event.payload.error));
            }
        },
    };
    return {
        observer,
        settlement: {
            settle: async (turn) => {
                const observed = state(turn);
                ensureStarted(turn, observed);
                turnTimings.markSettling(turn.sessionId, turn.turnId);
                const decision = await goals.settleInjectedTurn({
                    ...turn,
                    tokens: observed.tokens,
                    retracted: observed.retracted,
                    ...(observed.usageIncomplete ? { usageIncomplete: true } : {}),
                    ...(turn.status === 'failed' ? { failureClass: observed.failureClass ?? 'unknown' } : {}),
                    ...(observed.finalAssistantText !== undefined
                        ? { finalAssistantText: observed.finalAssistantText }
                        : {}),
                    ...(observed.questionnaireFailed ? { questionnaireFailed: true } : {}),
                    ...(observed.workerModelKey ? { workerModelKey: observed.workerModelKey } : {}),
                    // Only report work signals backed by an actual history observation.
                    // An omitted field means "unknown" downstream; a fabricated zero
                    // would let the Goal no-tool breaker count an observation gap.
                    ...(observed.historyObserved
                        ? {
                            workSignals: {
                                toolCalls: observed.toolCalls,
                                toolCallObservations: [...observed.toolWork.values()].map((call) => observeThreadGoalToolCall({ ...call, result: call.result ?? '' })),
                            },
                        }
                        : {}),
                });
                turnTimings.finish(turn.sessionId, turn.turnId);
                turns.delete(turnKey(turn));
                // A settled sub-session round sends no more requests to charge.
                goals.forgetSubSessionRound(turn.turnId);
                // Runs once this Turn is fully settled: TurnSystem has already
                // committed the Queue pause its failure left, and the Turn no longer
                // counts as running when the woken Queue starts the next one.
                if (turn.status === 'failed' && isOrdinaryTurn(decision)) {
                    await goals.continueAfterOrdinaryTurnFailure({
                        sessionId: turn.sessionId,
                        turnId: turn.turnId,
                    });
                }
            },
            abandon: async (turn) => {
                // TurnSystem is out of settle retries, so the Goal decision for this
                // Turn is never happening. Drop the observation and release the
                // Turn-scoped timing frozen for settlement; otherwise the session stays
                // `settling` and automatic continuation reads it as busy.
                turns.delete(turnKey(turn));
                turnTimings.finish(turn.sessionId, turn.turnId);
                goals.forgetSubSessionRound(turn.turnId);
            },
        },
        budgetGuard: createGoalBudgetGuardExtension(goals),
    };
}
function createGoalBudgetGuardExtension(goals) {
    return {
        id: 'local-goal-budget-guard',
        description: 'Stop new tools when the admitted Goal execution budget is exhausted.',
        init(pi) {
            pi.on('before_tool_call', async (_input, _signal, turn) => {
                let decision;
                try {
                    decision = await goals.checkTurnBudget({
                        sessionId: turn.sessionId,
                        turnId: turn.turnId,
                    });
                }
                catch {
                    return {
                        block: true,
                        reason: 'GOAL_BUDGET_CHECK_UNAVAILABLE: Tool execution is disabled because the Goal budget check failed closed.',
                    };
                }
                if (decision.decision === 'allow')
                    return undefined;
                return { block: true, reason: decision.message };
            });
        },
    };
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/**
 * Count committed tool calls produced by this Turn.
 *
 * Pi-agent assistant messages carry tool calls as `toolCall` content blocks
 * (`AssistantMessage['content'][number].type`), which is the same durable shape
 * the history projection and compaction paths read. Only committed assistant
 * messages are counted, so an in-flight or discarded call never inflates it.
 */
function countCommittedToolCalls(messages) {
    let count = 0;
    for (const message of messages) {
        if (!isRecord(message) || message.role !== 'assistant')
            continue;
        const content = message.content;
        if (!Array.isArray(content))
            continue;
        for (const block of content) {
            if (isRecord(block) && block.type === 'toolCall')
                count += 1;
        }
    }
    return count;
}
/**
 * Remember each committed tool call and the result committed for it, so the
 * Goal breaker can tell a Turn that learned something from one that only
 * repeated a recent call. A failed result is marked so it never matches a
 * successful one with the same text.
 */
function recordCommittedToolWork(toolWork, messages) {
    for (const message of messages) {
        if (!isRecord(message))
            continue;
        if (message.role === 'assistant')
            recordToolCalls(toolWork, message.content);
        if (message.role === 'toolResult')
            recordToolResult(toolWork, message);
    }
}
function recordToolCalls(toolWork, content) {
    if (!Array.isArray(content))
        return;
    for (const block of content) {
        if (!isRecord(block) || block.type !== 'toolCall')
            continue;
        const id = typeof block.id === 'string' ? block.id : `#${String(toolWork.size)}`;
        toolWork.set(id, {
            name: typeof block.name === 'string' ? block.name : '',
            arguments: block.arguments,
        });
    }
}
function recordToolResult(toolWork, message) {
    const call = typeof message.toolCallId === 'string' ? toolWork.get(message.toolCallId) : undefined;
    if (!call)
        return;
    const result = resultParts(message.content).join('\n');
    call.result = message.isError === true ? `error:${result}` : result;
}
/**
 * The comparable content of a tool result. Text blocks stay as written; any
 * other block (an image a `read` returned, say) is reduced to a digest of the
 * whole block, so a result whose only change is non-text content still reads
 * as new.
 */
function resultParts(content) {
    if (!Array.isArray(content))
        return [];
    return content.map((block) => {
        if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') {
            return block.text;
        }
        const kind = isRecord(block) && typeof block.type === 'string' ? block.type : 'block';
        const digest = createHash('sha256')
            .update(JSON.stringify(block) ?? '')
            .digest('hex');
        return `[${kind}:${digest}]`;
    });
}
/** Only committed tool outcomes establish a failed handoff; model prose is not evidence. */
function readLastQuestionnaireFailure(messages) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (!isRecord(message) || message.role !== 'toolResult' || message.toolName !== 'ask_user') {
            continue;
        }
        if (typeof message.isError === 'boolean')
            return message.isError;
    }
    return undefined;
}
function readLastAssistantText(messages) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (!isRecord(message) || message.role !== 'assistant')
            continue;
        const content = message.content;
        if (!Array.isArray(content))
            return { seen: true };
        const text = content
            .flatMap((block) => isRecord(block) && block.type === 'text' && typeof block.text === 'string'
            ? [block.text]
            : [])
            .join('');
        return text.length > 0 ? { seen: true, text } : { seen: true };
    }
    return { seen: false };
}
function preferFailureClass(current, next) {
    const rank = {
        unknown: 0,
        infra_retryable: 1,
        rate_limit: 2,
        provider_quota: 3,
        safety: 4,
    };
    return current !== undefined && (rank[current] ?? 0) >= (rank[next] ?? 0) ? current : next;
}
function observedRuntimeStatus(event) {
    if (event.type !== RuntimeEventType.SESSION_STATUS &&
        event.type !== RuntimeEventType.TURN_TERMINAL) {
        return undefined;
    }
    if (event.payload.status === RuntimeEventStatus.RUNNING)
        return 'running';
    if (event.payload.status === RuntimeEventStatus.COMPLETED)
        return 'completed';
    if (event.payload.status === RuntimeEventStatus.FAILED)
        return 'failed';
    return event.payload.status === RuntimeEventStatus.ABORTED ? 'aborted' : undefined;
}
/** The Goal owner found no Goal binding: the Turn was an ordinary one. */
function isOrdinaryTurn(decision) {
    return decision.stage === 1 && decision.reason === 'not_a_goal_turn';
}
function turnKey(context) {
    return `${context.sessionId}\0${context.turnId}`;
}
//# sourceMappingURL=turn-lifecycle.js.map