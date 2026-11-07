import { initializeReviewContextAdmission } from './initialize.js';
import { logger as defaultLogger } from '../../infra/logging/logger.js';
import { resolveLocalAppMode } from '../../infra/runtime-owner/app-mode.js';
import { createReviewActivityIdentity, emitReviewActivity } from './projection/activity-events.js';
import { createReviewAfterLlmHook } from './orchestration/after-llm-hook.js';
import { ReviewContextAdmission } from './preparation/context-admission.js';
import { discardReviewPromptRead, rememberReviewPromptRead, rebindReviewPromptRead, reserveReviewPromptRead, } from './prompts/prompt-read-handoff.js';
import { prepareReview } from './prompts/prompt-preparation.js';
import { projectReviewRuntimeEvent } from './projection/projection-writer.js';
import { inspectReviewProtocolOutput, recordReviewProjectionBypass, } from './orchestration/protocol-diagnostics.js';
import { buildInlineReviewReminder } from './prompts/reminder.js';
import { createReviewToolGuard } from './preparation/tool-guard.js';
import { ReviewTurnState } from './turn-state.js';
import { projectReviewResultEvent } from './projection/result-event-projection.js';
import { reviewSubagentResult, waitForReviewCompletion } from './orchestration/subagent-result.js';
import { attributeReviewRound } from './orchestration/round-attribution.js';
export class HostedReviewCapability {
    options;
    turns = new Map();
    contextAdmission;
    constructor(options) {
        this.options = options;
        this.contextAdmission = initializeReviewContextAdmission(options);
    }
    async buildUserPromptPrefix(input) {
        const trigger = reviewTrigger(input.intent);
        if (!trigger)
            return undefined;
        const existing = this.turns.get(turnKey(input));
        if (existing?.state.prepared) {
            return existing.state.delivery === 'git-discovery'
                ? existing.state.renderedCompactReminder
                : existing.state.renderedFullReminder;
        }
        const preparedRead = await prepareReview({
            workspace: input.workspaceDir,
            trigger: trigger === 'subagent' ? 'slash' : trigger,
            request: input.userInput,
            ...(trigger === 'subagent' ? { requestedMode: 'inline' } : {}),
            ...(input.promptRead ? { promptRead: input.promptRead } : {}),
        }, this.options);
        const { prepared } = preparedRead;
        const turn = this.getOrCreate(input);
        turn.promptRead = preparedRead.promptRead;
        return this.activateReview(turn, prepared, prepared.mode === 'subagent' ? 'git-discovery' : 'full');
    }
    createCodeReviewAdapter(identity, session) {
        if (resolveLocalAppMode(session.appMode) !== 'coding' || session.purpose)
            return undefined;
        const turn = this.getOrCreate({
            ...identity,
            agentName: session.agentName,
            workspaceDir: session.workspaceDir,
            userInput: '',
        });
        return {
            run: async (_ctx, toolInput, signal) => {
                try {
                    const preparedRead = await prepareReview({
                        workspace: session.workspaceDir,
                        trigger: 'natural_language',
                        request: toolInput.request,
                        ...(toolInput.mode ? { requestedMode: toolInput.mode } : {}),
                    }, this.options);
                    const { prepared } = preparedRead;
                    turn.promptRead = preparedRead.promptRead;
                    const reminder = this.activateReview(turn, prepared, prepared.mode === 'subagent' ? 'git-discovery' : 'full');
                    if (prepared.mode === 'inline') {
                        return {
                            status: 'prepared',
                            mode: 'inline',
                            instruction: [reminder, '', prepared.request].join('\n'),
                        };
                    }
                    const result = await this.runSubagent(turn, {
                        parent: session,
                        preparedRead,
                        parentTurnId: identity.turnId,
                        signal,
                    });
                    if (result.status === 'succeeded') {
                        turn.state.setSubagentResult(result.finalText);
                        return { status: 'succeeded', mode: 'subagent' };
                    }
                    if (result.status === 'aborted') {
                        return { status: 'failed', mode: 'subagent', errorMessage: 'Review was aborted.' };
                    }
                    const inlinePrepared = { ...prepared, mode: 'inline' };
                    const inlineReminder = this.activateReview(turn, inlinePrepared, turn.state.delivery);
                    return {
                        status: 'prepared',
                        mode: 'inline',
                        instruction: [inlineReminder, '', inlinePrepared.request].join('\n'),
                    };
                }
                catch (error) {
                    return {
                        status: 'failed',
                        mode: toolInput.mode === 'subagent' ? 'subagent' : 'inline',
                        errorMessage: error instanceof Error ? error.message : String(error),
                    };
                }
            },
        };
    }
    async beforeLlmCall(input, identity) {
        const turn = this.turns.get(turnKey(identity));
        if (!turn?.state.isReviewActivated())
            return undefined;
        const ready = turn.state.getSubagentResult();
        if (ready !== undefined) {
            return {
                type: 'respond',
                reason: 'trusted_review_subagent_result',
                text: ready,
            };
        }
        const prepared = turn.state.prepared;
        if (!prepared)
            return undefined;
        if (prepared.mode === 'inline') {
            return this.contextAdmission.evaluate(input, turn.state, identity);
        }
        return this.beforeSubagentLlmCall({ turn, input, identity, prepared });
    }
    async beforeSubagentLlmCall({ turn, input, identity, prepared, }) {
        await this.ensureActivity(turn, input, identity, prepared);
        const parent = await this.options.conversation?.query.getSession(identity.sessionId);
        if (!parent) {
            await this.settleActivity(turn, input, identity, 'review_failed');
            this.activateReview(turn, { ...prepared, mode: 'inline' }, turn.state.delivery);
            return ((await this.contextAdmission.evaluate(input, turn.state, identity)) ?? { type: 'continue' });
        }
        const result = await this.runSubagent(turn, {
            parent,
            preparedRead: { prepared, promptRead: turn.promptRead },
            parentTurnId: identity.turnId,
            signal: input.signal,
        });
        if (result.status === 'aborted') {
            await this.settleActivity(turn, input, identity, 'review_aborted');
            return { type: 'abort', reason: 'review_subagent_aborted' };
        }
        if (result.status === 'failed') {
            await this.settleActivity(turn, input, identity, 'review_failed');
            this.activateReview(turn, { ...prepared, mode: 'inline' }, turn.state.delivery);
            return ((await this.contextAdmission.evaluate(input, turn.state, identity)) ?? { type: 'continue' });
        }
        turn.state.setSubagentResult(result.finalText);
        if (!/^\s*<annotation-result\b/iu.test(result.finalText)) {
            await this.settleActivity(turn, input, identity, 'review_failed');
        }
        return {
            type: 'respond',
            reason: 'trusted_review_subagent_result',
            text: result.finalText,
        };
    }
    afterLlmCall(input, identity, model) {
        const turn = this.turns.get(turnKey(identity));
        const protocolOutput = inspectReviewProtocolOutput(input);
        const reasonCode = projectionBypassReason(turn);
        if (!turn || reasonCode) {
            if (protocolOutput) {
                recordReviewProjectionBypass({
                    identity,
                    reasonCode: reasonCode ?? 'turn_not_found',
                    ...(turn ? { state: turn.state } : {}),
                    protocolOutput,
                    logger: this.options.logger ?? defaultLogger,
                    ...(model ? { model } : {}),
                });
            }
            return undefined;
        }
        turn.afterLlmHook ??= this.createAfterLlmHook(turn, model);
        return turn.afterLlmHook(input);
    }
    createAfterLlmHook(turn, model) {
        return createReviewAfterLlmHook(turn.state, {
            ...(this.options.metricsClient ? { metricsClient: this.options.metricsClient } : {}),
            logger: this.options.logger ?? defaultLogger,
            ...(model ? { model } : {}),
        });
    }
    beforeToolCall(input, signal, identity) {
        const turn = this.turns.get(turnKey(identity));
        if (!turn)
            return undefined;
        return createReviewToolGuard(turn.state).beforeToolCall(input, signal);
    }
    projectRuntimeEvent(identity, event) {
        const turn = this.turns.get(turnKey(identity));
        if (!turn)
            return event;
        const projected = projectReviewRuntimeEvent(event, turn.state);
        if (!projected)
            return projected;
        return projectReviewResultEvent(projected, turn.activity, identity.turnId, turn.state.outcome);
    }
    endTurn(identity) {
        this.turns.delete(turnKey(identity));
    }
    getOrCreate(input) {
        const key = turnKey(input);
        const current = this.turns.get(key);
        if (current)
            return current;
        const created = { state: new ReviewTurnState() };
        this.turns.set(key, created);
        return created;
    }
    activateReview(turn, prepared, delivery = 'full') {
        const fullReminder = buildInlineReviewReminder(prepared, 'full');
        const compactReminder = buildInlineReviewReminder(prepared, 'git-discovery');
        turn.state.activate(prepared, { fullReminder, compactReminder }, delivery);
        return delivery === 'git-discovery' ? compactReminder : fullReminder;
    }
    async ensureActivity(turn, input, identity, prepared) {
        if (turn.activity || !input.eventWriter)
            return;
        const activity = createReviewActivityIdentity(prepared.context.reviewRunId);
        turn.activity = activity;
        await emitReviewActivity({
            eventWriter: input.eventWriter,
            sessionId: identity.sessionId,
            turnId: identity.turnId,
            identity: activity,
            kind: 'review_start',
            timestamp: (this.options.nowMs ?? Date.now)(),
            ...(input.runtimeSeqGenerator ? { runtimeSeq: input.runtimeSeqGenerator() } : {}),
        });
    }
    async settleActivity(turn, input, identity, kind) {
        const activity = turn.activity;
        if (!activity || activity.terminal || !input.eventWriter)
            return;
        activity.terminal = true;
        await emitReviewActivity({
            eventWriter: input.eventWriter,
            sessionId: identity.sessionId,
            turnId: identity.turnId,
            identity: activity,
            kind,
            timestamp: (this.options.nowMs ?? Date.now)(),
            ...(input.runtimeSeqGenerator ? { runtimeSeq: input.runtimeSeqGenerator() } : {}),
        });
    }
    runSubagent(turn, request) {
        if (turn.subagentRun)
            return turn.subagentRun;
        const run = this.executeSubagentWithFallback(request.parent, request.preparedRead, request.parentTurnId, request.signal);
        turn.subagentRun = run;
        return run;
    }
    async executeSubagentWithFallback(parent, preparedRead, parentTurnId, signal) {
        try {
            return await this.executeSubagent(parent, preparedRead, parentTurnId, signal);
        }
        catch (error) {
            return {
                status: 'failed',
                errorMessage: error instanceof Error ? error.message : String(error),
            };
        }
    }
    async executeSubagent(parent, preparedRead, parentTurnId, signal) {
        const conversation = this.options.conversation;
        if (!conversation)
            return { status: 'failed', errorMessage: 'Conversation is unavailable.' };
        if (signal?.aborted)
            return { status: 'aborted' };
        const child = await conversation.lifecycle.createSession({
            agentName: parent.agentName,
            workspaceDir: parent.workspaceDir,
            sessionType: 'branch',
            sessionKind: 'task',
            parentSessionId: parent.sessionId,
            title: preparedRead.prepared.responseLanguage === 'zh-CN' ? '代码审查' : 'Code review',
            visibility: 'hidden',
            purpose: `code-review:${preparedRead.prepared.context.reviewRunId}`,
            runLocation: parent.runLocation,
            appMode: parent.appMode,
            ...(parent.effectiveModel !== undefined ? { effectiveModel: parent.effectiveModel } : {}),
            ...(parent.effectiveModelVariant !== undefined
                ? { effectiveModelVariant: parent.effectiveModelVariant }
                : {}),
        });
        const promptReadHandoff = reserveReviewPromptRead(preparedRead.promptRead, this.options.internalTurnPromptReads?.());
        if (!promptReadHandoff) {
            return {
                status: 'failed',
                errorMessage: 'Code review prompt snapshot handoff is unavailable.',
            };
        }
        const { requestedTurnId } = promptReadHandoff;
        let registeredTurnId = requestedTurnId;
        const childTurn = this.getOrCreate({
            sessionId: child.sessionId,
            turnId: requestedTurnId,
            agentName: child.agentName,
            workspaceDir: child.workspaceDir,
            userInput: preparedRead.prepared.request,
            intent: {
                kind: 'code-review',
                attributes: { trigger: 'subagent', scope: 'local_changes' },
            },
        });
        this.activateReview(childTurn, { ...preparedRead.prepared, mode: 'inline' }, 'full');
        // The review child round is submitted below; its parent Turn is reported
        // first so the Goal owner can charge the round's very first request.
        const attribution = await attributeReviewRound(this.options, {
            parentSessionId: parent.sessionId,
            parentTurnId,
            childSessionId: child.sessionId,
            childTurnId: requestedTurnId,
        });
        let submitted = false;
        try {
            rememberReviewPromptRead(promptReadHandoff);
            const accepted = await conversation.ingress.submit({
                sessionId: child.sessionId,
                source: 'code_review',
                allowQueue: false,
                clientRequestId: `review:${preparedRead.prepared.context.reviewRunId}`,
                requestedTurnId,
                message: {
                    content: preparedRead.prepared.request,
                    displayContent: preparedRead.prepared.displayPrompt,
                    origin: {
                        review: {
                            trigger: 'subagent',
                            scope: 'local_changes',
                        },
                    },
                },
            });
            submitted = true;
            if (accepted.turnId !== requestedTurnId) {
                attribution?.forgetRound(requestedTurnId);
                rebindReviewPromptRead(promptReadHandoff, accepted.turnId);
                registeredTurnId = accepted.turnId;
            }
            const result = await waitForReviewCompletion(conversation, child.sessionId, accepted.completion, signal);
            return reviewSubagentResult(result);
        }
        catch (error) {
            if (!submitted)
                attribution?.forgetRound(requestedTurnId);
            discardReviewPromptRead(promptReadHandoff, registeredTurnId);
            throw error;
        }
    }
}
function projectionBypassReason(turn) {
    if (!turn)
        return 'turn_not_found';
    if (!turn.state.isProjectionActive())
        return 'projection_inactive';
    if (!turn.state.prepared)
        return 'prepared_missing';
    return undefined;
}
function reviewTrigger(intent) {
    if (intent?.kind !== 'code-review' || intent.attributes?.scope !== 'local_changes') {
        return undefined;
    }
    return intent.attributes.trigger === 'slash' || intent.attributes.trigger === 'subagent'
        ? intent.attributes.trigger
        : undefined;
}
function turnKey(identity) {
    return `${identity.sessionId}\u0000${identity.turnId}`;
}
//# sourceMappingURL=hosted-capability.js.map