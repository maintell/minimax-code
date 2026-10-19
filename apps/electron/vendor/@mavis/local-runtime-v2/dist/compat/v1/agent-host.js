import { RuntimeEventStatus, RuntimeEventType, } from '@mavis/agent-core/protocol';
import { createHookExtension } from '@mavis/agent-runtime';
import { summarizeCommittedPiGoalUsage } from '../../service/session-system/index.js';
/** Exposes only durable local attachment registration to v2 ingress owners. */
export function createV1AttachmentRegistration(source) {
    const attachments = source.createHostedAgentCapabilities().attachments;
    return {
        register: attachments.register,
        discard: attachments.discard,
        resolveSource: attachments.resolveSource,
    };
}
/**
 * Optional model-resolver ports are spread only when the host supplies them.
 * Extracted so the adapter below stays within its complexity budget.
 */
function createV1ModelResolver(hosted) {
    return {
        ...(hosted.authContextGetter ? { authContextGetter: hosted.authContextGetter } : {}),
        ...(hosted.authContextInvalidator
            ? { authContextInvalidator: hosted.authContextInvalidator }
            : {}),
        ...(hosted.routingContextGetter ? { routingContextGetter: hosted.routingContextGetter } : {}),
        providerAuthGetter: hosted.providerAuthGetter,
        ...(hosted.fetchImpl ? { fetchImpl: hosted.fetchImpl } : {}),
    };
}
/**
 * The only v1 -> v2 AgentHost adapter. It maps product owners into native
 * composition ports and never exposes the v1 Host to TurnSystem.
 */
export function createV1AgentHostProductCapabilities(source, evalReporterFactory, cloudHandoff) {
    const hosted = source.createHostedAgentCapabilities();
    const websiteDeploy = createV1WebsiteDeployProjectionAdapter(hosted.websiteDeploy);
    const goalTurnLifecycle = createV1ThreadGoalTurnLifecycle(hosted.turnLifecycle);
    const goalBudgetGuard = createV1GoalBudgetGuardExtension(hosted.turnLifecycle.checkBudget, goalTurnLifecycle.observedUsage);
    return {
        preparation: {
            configBuilder: {
                config: hosted.config,
                memory: hosted.memory,
                skills: hosted.skills,
                modelRepairLogger: hosted.runnerLogger,
            },
            modelResolver: createV1ModelResolver(hosted),
        },
        // V1 Computer Use state is retired. The V2 CUA composition replaces this
        // source when the broker client is present; compatibility alone stays
        // globally closed.
        turnRuntimeFacts: {
            snapshot: () => ({ computerUseGloballyEnabled: false }),
        },
        checkpointState: hosted.checkpointState,
        toolSources: hosted.toolSources,
        inputPreparation: {
            assets: hosted.attachments,
            materializePrompt: hosted.websiteDeploy.materializeSources,
            reminders: {
                buildBackground: hosted.reminders.buildBackground,
                buildSystem: (input) => {
                    const model = systemReminderModel(input.agentConfig);
                    return hosted.reminders.buildSystem({
                        session: input.session,
                        resourceAgentName: input.agent.resourceAgentName ?? input.agent.agentName,
                        promptText: input.promptText,
                        turnId: input.turnId,
                        deferTelemetry: true,
                        contextUsagePromptRanges: input.agentConfig.contextUsagePromptRanges,
                        availableSkillNames: (Array.isArray(input.agentConfig.skills)
                            ? input.agentConfig.skills
                            : []).flatMap((skill) => isRecord(skill) && typeof skill.name === 'string' ? [skill.name] : []),
                        ...(model ? { model } : {}),
                    });
                },
                confirmBackgroundTaskReads: async (input) => {
                    const confirmed = await hosted.reminders.confirmBackgroundTaskReads(input);
                    return confirmed.flatMap((value) => {
                        if (typeof value === 'string')
                            return [value];
                        const taskId = Reflect.get(Object(value), 'taskId');
                        return typeof taskId === 'string' ? [taskId] : [];
                    });
                },
            },
        },
        permission: hosted.permissions,
        terminalMemory: hosted.terminalMemory,
        runner: {
            contextUsage: hosted.contextUsage,
            logger: hosted.runnerLogger,
            ...(hosted.metricsClient ? { metricsClient: hosted.metricsClient } : {}),
            ...(hosted.llmRequestFailureHook
                ? { onLLMRequestFailure: hosted.llmRequestFailureHook }
                : {}),
            ...(hosted.observeLLMRequest ? { observeLLMRequest: hosted.observeLLMRequest } : {}),
            ...(evalReporterFactory ? { evalReporterFactory } : {}),
        },
        fileApi: {
            ...(hosted.fetchImpl ? { fetchImpl: hosted.fetchImpl } : {}),
            logger: hosted.runnerLogger,
        },
        executor: {
            createChildBashLifecycle: hosted.createChildBashLifecycle,
            fileChanges: {
                begin: hosted.fileChanges.begin,
                finalize: (input) => hosted.fileChanges.finalize(input),
                markFailed: async (input) => {
                    await hosted.fileChanges.markFailed(input);
                },
            },
            reportFailure: hosted.reportFailure,
            projectRuntimeEvent: async ({ sessionId, turnId, event }) => {
                const reviewed = hosted.review.projectRuntimeEvent({ sessionId, turnId }, event);
                return reviewed
                    ? websiteDeploy.projectRuntimeEvent({ sessionId, turnId, event: reviewed })
                    : undefined;
            },
        },
        eventObserver: goalTurnLifecycle.observer,
        turnSettlement: goalTurnLifecycle.settlement,
        normalExtensions: [
            websiteDeploy.extension,
            goalBudgetGuard,
            createHookExtension({
                id: 'local-builtin-tool-hooks',
                description: 'Product-internal tool policies and result handlers.',
                handlers: {
                    before_tool_call: (toolContext, _signal, turn) => hosted.hooks.beforeToolCall({
                        agentName: turn.agentName,
                        sessionId: turn.sessionId,
                        turnId: turn.turnId,
                        model: modelIdentity(turn.model),
                        toolContext,
                    }),
                    after_tool_call: (toolContext, _signal, turn) => hosted.hooks.afterToolCall({
                        agentName: turn.agentName,
                        sessionId: turn.sessionId,
                        turnId: turn.turnId,
                        toolContext,
                    }),
                },
            }),
            createHostedReviewExtension(hosted.review),
            ...(cloudHandoff ? [cloudHandoff.extension] : []),
        ],
    };
}
function createV1GoalBudgetGuardExtension(checkBudget, observedUsage) {
    return {
        id: 'local-v1-goal-budget-guard',
        description: 'Stop new tools when the admitted Goal execution budget is exhausted.',
        init(pi) {
            pi.on('before_tool_call', async (_input, _signal, turn) => {
                let decision;
                try {
                    decision = await checkBudget({
                        sessionId: turn.sessionId,
                        turnId: turn.turnId,
                        observedTokens: observedUsage(turn).tokens,
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
function createV1WebsiteDeployProjectionAdapter(capability) {
    const projections = new Map();
    const projectionFor = (sessionId, turnId) => {
        const key = turnKey({ sessionId, turnId });
        const existing = projections.get(key);
        if (existing)
            return existing;
        const created = capability.createTurnProjection();
        projections.set(key, created);
        return created;
    };
    return {
        projectRuntimeEvent: (input) => projectionFor(input.sessionId, input.turnId).projectRuntimeEvent(input.event),
        extension: {
            id: 'local-v1-website-deploy-projection',
            description: 'Project local website deploy output through the v2 turn owner.',
            init(pi) {
                pi.on('after_tool_call', (input, _signal, turn) => projectionFor(turn.sessionId, turn.turnId).afterToolCallHook(input));
                pi.on('after_llm_call', (input, turn) => projectionFor(turn.sessionId, turn.turnId).afterLlmCallHook(input));
                pi.on('turn_end', (_event, turn) => {
                    projections.delete(turnKey(turn));
                });
            },
        },
    };
}
function createHostedReviewExtension(review) {
    return {
        id: 'local-code-review',
        description: 'Activate and validate the local structured code review workflow.',
        init(pi) {
            pi.contributeUserPromptPrefix((turn) => review.buildUserPromptPrefix({
                sessionId: turn.sessionId,
                turnId: turn.turnId,
                agentName: turn.agentName,
                workspaceDir: turn.workspaceDir,
                userInput: turn.userInput.text,
                ...(turn.promptRead ? { promptRead: turn.promptRead } : {}),
                ...(turn.turnIntent ? { intent: turn.turnIntent } : {}),
            }));
            pi.on('before_llm_call', (input, turn) => review.beforeLlmCall(input, { sessionId: turn.sessionId, turnId: turn.turnId }));
            pi.on('after_llm_call', (input, turn) => review.afterLlmCall(input, { sessionId: turn.sessionId, turnId: turn.turnId }, modelIdentity(turn.model)));
            pi.on('before_tool_call', (input, signal, turn) => review.beforeToolCall(input, signal, {
                sessionId: turn.sessionId,
                turnId: turn.turnId,
            }));
            pi.on('turn_end', (_event, turn) => {
                review.endTurn({ sessionId: turn.sessionId, turnId: turn.turnId });
            });
        },
    };
}
function createV1ThreadGoalTurnLifecycle(lifecycle) {
    const turns = new Map();
    const state = (context) => {
        const key = turnKey(context);
        const existing = turns.get(key);
        if (existing) {
            const workerModelKey = context.executionModel
                ? modelIdentity(context.executionModel)
                : undefined;
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
        };
        const workerModelKey = context.executionModel
            ? modelIdentity(context.executionModel)
            : undefined;
        if (workerModelKey)
            Object.assign(created, { workerModelKey });
        turns.set(key, created);
        return created;
    };
    const ensureStarted = (context, observed) => {
        if (observed.started)
            return;
        observed.started = true;
        lifecycle.started({
            sessionId: context.sessionId,
            turnId: context.turnId,
            ...(context.provenance?.source ? { source: context.provenance.source } : {}),
        });
    };
    const observer = {
        observeHistoryCommitted: ({ context, change }) => {
            const observed = state(context);
            if (change.reason === 'messageDelta') {
                const usage = summarizeCommittedPiGoalUsage(change.messages);
                observed.tokens += usage.tokens;
                observed.usageIncomplete ||= usage.incomplete;
                observed.historyObserved = true;
                observed.toolCalls += countCommittedToolCalls(change.messages);
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
                observed.failureClass = preferFailureClass(observed.failureClass, lifecycle.classifyFailure(event.payload.error));
            }
        },
    };
    return {
        observer,
        observedUsage: (input) => {
            const observed = turns.get(turnKey(input));
            return {
                tokens: observed?.tokens ?? 0,
                usageIncomplete: observed?.usageIncomplete ?? false,
            };
        },
        settlement: {
            settle: async (input) => {
                const observed = state(input);
                ensureStarted(input, observed);
                await lifecycle.settled({
                    ...input,
                    tokens: observed.tokens,
                    retracted: observed.retracted,
                    ...(observed.usageIncomplete ? { usageIncomplete: true } : {}),
                    ...(input.status === 'failed'
                        ? { failureClass: observed.failureClass ?? 'unknown' }
                        : {}),
                    ...(observed.finalAssistantText !== undefined
                        ? { finalAssistantText: observed.finalAssistantText }
                        : {}),
                    ...(observed.workerModelKey ? { workerModelKey: observed.workerModelKey } : {}),
                    // Only report work signals backed by an actual history observation.
                    // An omitted field means "unknown" downstream; a fabricated zero
                    // would let the Goal no-tool breaker count an observation gap.
                    ...(observed.historyObserved ? { workSignals: { toolCalls: observed.toolCalls } } : {}),
                });
                turns.delete(turnKey(input));
            },
            abandon: async (input) => {
                // TurnSystem is out of settle retries, so the Goal decision for this
                // Turn is never happening. Drop the observation and let the host
                // release the Turn-scoped timing it froze for settlement.
                turns.delete(turnKey(input));
                lifecycle.abandoned(input);
            },
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
function readLastAssistantText(messages) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (!message || typeof message !== 'object' || Array.isArray(message))
            continue;
        if (Reflect.get(message, 'role') !== 'assistant')
            continue;
        const content = Reflect.get(message, 'content');
        if (!Array.isArray(content))
            return { seen: true };
        const text = content
            .flatMap((block) => {
            if (!block || typeof block !== 'object' || Array.isArray(block))
                return [];
            return Reflect.get(block, 'type') === 'text' &&
                typeof Reflect.get(block, 'text') === 'string'
                ? [Reflect.get(block, 'text')]
                : [];
        })
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
    return current !== undefined && rank[current] >= rank[next] ? current : next;
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
function turnKey(context) {
    return `${context.sessionId}\0${context.turnId}`;
}
function modelIdentity(model) {
    const provider = typeof model.provider === 'string' ? model.provider : undefined;
    const id = readModelId(model);
    return provider && id ? `${provider}/${id}` : id;
}
function readModelId(model) {
    if (typeof model.model_id === 'string')
        return model.model_id;
    return typeof model.id === 'string' ? model.id : undefined;
}
function systemReminderModel(agentConfig) {
    const raw = agentConfig.model;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        return undefined;
    const model = raw;
    const providerID = typeof model.provider === 'string' ? model.provider : undefined;
    const modelID = readModelId(model);
    if (!providerID || !modelID)
        return undefined;
    return {
        providerID,
        modelID,
        ...(typeof model.variant === 'string' && model.variant ? { variant: model.variant } : {}),
    };
}
//# sourceMappingURL=agent-host.js.map