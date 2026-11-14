import { readPromptWithBuiltinFallback } from '../../../agent/index.js';
import { SessionServiceError } from '../errors.js';
import { SessionTitleConflictError, } from '../repo/contract.js';
import { normalizeSessionTitleCandidate, stripSessionTitleInjectedTags, } from './session-title-service.js';
import { SESSION_TITLE_REVIEW_PROMPT, SESSION_TITLE_REVIEW_PROMPT_KEY, } from './session-title-review-prompt.js';
import { TitleGenerationBudget } from './title-generation-budget.js';
/** One best-effort semantic review after the first substantive reply, owned by its Runtime. */
export class SessionTitleReviewService {
    options;
    pending = new Map();
    shutdown = new AbortController();
    constructor(options) {
        this.options = options;
    }
    review(input) {
        if (this.shutdown.signal.aborted || !this.options.model.review)
            return Promise.resolve();
        // Serialize later replies behind a clarification check; never drop the first real answer.
        const previous = this.pending.get(input.sessionId) ?? Promise.resolve();
        const run = async () => {
            await previous;
            try {
                await this.run(input);
            }
            finally {
                if (this.pending.get(input.sessionId) === operation)
                    this.pending.delete(input.sessionId);
            }
        };
        const operation = run();
        this.pending.set(input.sessionId, operation);
        return operation;
    }
    async close() {
        this.shutdown.abort();
        await Promise.allSettled(this.pending.values());
    }
    async run(input) {
        let stage = 'read';
        let budget;
        try {
            const prepared = await this.prepare(input);
            if (!prepared)
                return;
            const { session, userInputs, finalReply } = prepared;
            stage = 'write';
            // Claim before the request: crashes, invalid output and provider failures cannot cause
            // repeated billable reviews. Only an explicit clarification decision reopens eligibility.
            const claimed = await this.options.sessions.update(input.sessionId, {
                titleReviewState: 'completed',
                titleReviewTurnId: input.turnId,
            }, undefined, expectation(session));
            if (!claimed || this.shutdown.signal.aborted)
                return;
            stage = 'model';
            budget = new TitleGenerationBudget(10_000, [this.shutdown.signal]);
            const decision = await this.generateDecision(claimed, userInputs, finalReply, budget);
            if (budget.remainingMs === 0)
                return;
            stage = 'write';
            await this.applyDecision(input.sessionId, claimed, decision, budget.signal);
        }
        catch (error) {
            this.handleFailure(stage, input.sessionId, error);
        }
        finally {
            budget?.dispose();
        }
    }
    async prepare(input) {
        await this.options.waitForGeneration(input.sessionId);
        if (this.shutdown.signal.aborted)
            return null;
        const session = await this.options.sessions.get(input.sessionId);
        if (!session || !isEligible(session, input.turnId))
            return null;
        const content = 'loadContent' in input ? await input.loadContent() : input;
        if (!content || this.shutdown.signal.aborted)
            return null;
        const userInputs = content.userInputs.map(stripSessionTitleInjectedTags).filter(Boolean);
        if (!userInputs.length || !content.finalReply.trim())
            return null;
        return { session, userInputs, finalReply: content.finalReply };
    }
    async generateDecision(claimed, userInputs, finalReply, budget) {
        if (!this.options.model.review)
            return null;
        const systemPrompt = await readPromptWithBuiltinFallback({
            source: this.options.promptSnapshots,
            key: SESSION_TITLE_REVIEW_PROMPT_KEY,
            builtin: SESSION_TITLE_REVIEW_PROMPT,
        });
        budget.assertActive();
        return this.options.model.review({
            session: claimed,
            systemPrompt,
            // No tool history, thinking, system prompt or previous turns. Never truncate the reply.
            userPrompt: JSON.stringify({
                currentTitle: claimed.title ?? '',
                userInputs,
                finalReply,
            }),
            maxTokens: 1_000,
            timeoutMs: budget.remainingMs,
            deadlineAt: budget.deadlineAt,
            signal: budget.signal,
        });
    }
    async applyDecision(sessionId, claimed, decision, signal) {
        if (!decision) {
            this.observe('invalid_output');
            return;
        }
        if (decision.action === 'defer') {
            await this.options.sessions.update(sessionId, { titleReviewState: 'deferred' }, undefined, expectation(claimed));
            this.observe('deferred');
        }
        else if (decision.action === 'keep' || decision.title === claimed.title) {
            this.observe('kept');
        }
        else {
            const title = normalizeSessionTitleCandidate(decision.title);
            if (!title) {
                this.observe('invalid_output');
                return;
            }
            await this.options.commitTitle(sessionId, title, { ...expectation(claimed), signal });
            this.observe('updated');
        }
    }
    handleFailure(stage, sessionId, error) {
        if (error instanceof SessionTitleConflictError ||
            (error instanceof SessionServiceError && error.reason === 'session-not-found')) {
            this.observe('skipped_race');
        }
        else {
            this.observe('failed');
            try {
                this.options.onFailure?.({ stage, sessionId, error });
            }
            catch {
                /* Diagnostics are best-effort. */
            }
        }
    }
    observe(outcome) {
        try {
            this.options.onOutcome?.(outcome);
        }
        catch {
            /* Metrics cannot fail a Turn. */
        }
    }
}
function isEligible(session, turnId) {
    return (session.sessionType === 'branch' &&
        session.sessionKind !== 'task' &&
        session.visibility !== 'hidden' &&
        !session.archived &&
        session.titleSource === 'auto' &&
        (session.titleReviewState === 'pending' || session.titleReviewState === 'deferred') &&
        session.titleReviewTurnId !== turnId);
}
function expectation(session) {
    return {
        title: session.title ?? null,
        source: 'auto',
        reviewState: session.titleReviewState,
        reviewTurnId: session.titleReviewTurnId ?? null,
    };
}
//# sourceMappingURL=session-title-review-service.js.map