import { readPromptWithBuiltinFallback } from '../../../agent/index.js';
import { SessionServiceError } from '../errors.js';
import { SessionTitleConflictError, } from '../repo/contract.js';
import { normalizeSessionTitleCandidate, readTitleLocale, stripSessionTitleInjectedTags, TITLE_ATTEMPTS, TITLE_MAX_TOKENS, TITLE_PROVIDER_RETRY_DELAYS_MS, TITLE_TIMEOUT_MS, } from './session-title-service.js';
import { SESSION_TITLE_REVIEW_PROMPT, SESSION_TITLE_REVIEW_PROMPT_KEY, } from './session-title-review-prompt.js';
import { TitleGenerationBudget } from './title-generation-budget.js';
/** Replies that may try to name a Session still showing a fallback title. */
const MAX_FALLBACK_NAMING_ATTEMPTS = 3;
/**
 * Best-effort title work after a committed reply, owned by its Runtime: one review of an
 * automatic title, or bounded naming of a Session that only has a fallback title.
 */
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
        // Serialize replies per Session: a later reply sees the claim of the attempt before it.
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
        const attempt = { stage: 'read', mode: 'review' };
        let budget;
        try {
            const admitted = await this.admit(input);
            if (!admitted)
                return;
            // Known before any content is read, so a failed first-request read counts as fallback.
            attempt.mode = admitted.mode;
            const prepared = await this.prepare(input, admitted);
            if (!prepared)
                return;
            attempt.stage = 'write';
            attempt.claimed = await this.claim(input.sessionId, input.turnId, prepared);
            if (!attempt.claimed || this.shutdown.signal.aborted)
                return;
            attempt.stage = 'model';
            budget = new TitleGenerationBudget(TITLE_TIMEOUT_MS, [this.shutdown.signal]);
            await this.request(input.sessionId, attempt, prepared, budget);
        }
        catch (error) {
            this.handleFailure(attempt.stage, attempt.mode, input.sessionId, error);
        }
        finally {
            budget?.dispose();
            await this.releaseAbandonedClaim(input.sessionId, attempt);
        }
    }
    async admit(input) {
        await this.options.waitForGeneration(input.sessionId);
        if (this.shutdown.signal.aborted)
            return null;
        const session = await this.options.sessions.get(input.sessionId);
        const mode = session && eligibleMode(session, input.turnId);
        return session && mode ? { session, mode } : null;
    }
    async prepare(input, admitted) {
        const content = await loadReviewContent(input, {
            scope: admitted.mode === 'fallback' ? 'first-request' : 'reply',
            session: admitted.session,
        });
        if (!content || this.shutdown.signal.aborted)
            return null;
        return preparedReview(admitted.session, admitted.mode, content);
    }
    async request(sessionId, attempt, prepared, budget) {
        const { claimed } = attempt;
        if (!claimed)
            return;
        const systemPrompt = await readPromptWithBuiltinFallback({
            source: this.options.promptSnapshots,
            key: SESSION_TITLE_REVIEW_PROMPT_KEY,
            builtin: SESSION_TITLE_REVIEW_PROMPT,
        });
        const ask = (active) => this.requestDecision(claimed, prepared, systemPrompt, active);
        if (attempt.mode === 'review') {
            const decision = await ask(budget);
            if (budget.remainingMs === 0) {
                this.observeExpired('review');
                return;
            }
            attempt.stage = 'write';
            await this.applyReview(sessionId, claimed, decision, budget.signal);
            return;
        }
        const title = await this.nameFallback(sessionId, budget, ask);
        if (!title)
            return;
        attempt.stage = 'write';
        await this.options.commitTitle(sessionId, title, {
            ...expectation(claimed),
            signal: budget.signal,
        });
        attempt.named = true;
        this.observe('updated', 'fallback');
    }
    /**
     * A fallback claim abandoned because the service is closing gives its cross-turn attempt back.
     * The claimed turn stays recorded, so the same Turn still cannot claim again. Provider errors and
     * an expired budget keep the attempt: that is what bounds naming while the model keeps failing.
     */
    async releaseAbandonedClaim(sessionId, attempt) {
        const { claimed } = attempt;
        if (attempt.mode !== 'fallback' || !claimed || attempt.named)
            return;
        if (!this.shutdown.signal.aborted)
            return;
        try {
            await this.options.sessions.update(sessionId, {
                titleReviewState: 'pending',
                titleReviewAttempts: Math.max(0, (claimed.titleReviewAttempts ?? 1) - 1),
            }, undefined, expectation(claimed));
        }
        catch {
            /* Best effort while closing: the attempt stays used, which only tightens the bound. */
        }
    }
    /**
     * Claims before the request, so crashes, invalid output and provider failures cannot repeat a
     * billable call in the same Turn. A review is terminal at once. A fallback stays `pending` so a
     * later reply can retry naming from the same first request, until its attempts run out; a claim
     * abandoned by closing is given back (`releaseAbandonedClaim`).
     */
    claim(sessionId, turnId, prepared) {
        const { session } = prepared;
        if (prepared.mode === 'review') {
            return this.options.sessions.update(sessionId, { titleReviewState: 'completed', titleReviewTurnId: turnId }, undefined, expectation(session));
        }
        const attempts = (session.titleReviewAttempts ?? 0) + 1;
        return this.options.sessions.update(sessionId, {
            titleReviewState: attempts >= MAX_FALLBACK_NAMING_ATTEMPTS ? 'completed' : 'pending',
            titleReviewTurnId: turnId,
            titleReviewAttempts: attempts,
        }, undefined, expectation(session));
    }
    async requestDecision(claimed, prepared, systemPrompt, budget) {
        const model = this.options.model;
        if (!model.review)
            return null;
        const appLocale = readTitleLocale(this.options.locale);
        budget.assertActive();
        // Call it on the model: the production adapter is a class and `review` reads `this`.
        return model.review({
            session: claimed,
            systemPrompt,
            // No tool history, thinking or system prompt. Never truncate the reply.
            userPrompt: JSON.stringify({
                currentTitle: claimed.title ?? '',
                // A fallback title is truncated user text, not a name; the prompt must produce one.
                titleState: prepared.mode === 'fallback' ? 'fallback' : 'automatic',
                userInputs: prepared.userInputs,
                finalReply: prepared.finalReply,
                // Last, after the inputs and the reply: it only fills in for inputs without a language.
                ...(appLocale ? { appLocale } : {}),
            }),
            maxTokens: TITLE_MAX_TOKENS,
            timeoutMs: budget.remainingMs,
            deadlineAt: budget.deadlineAt,
            signal: budget.signal,
        });
    }
    /**
     * Retries inside one budget the way first-message generation does: a provider error backs off,
     * unusable output, `keep` included, is asked again at once. A Session without a name must leave
     * with one, so only `replace` counts.
     */
    async nameFallback(sessionId, budget, ask) {
        const retryDelays = this.options.providerRetryDelaysMs ?? TITLE_PROVIDER_RETRY_DELAYS_MS;
        let invalidAttempts = 0;
        let providerRetries = 0;
        let outcome = 'invalid_output';
        while (budget.remainingMs > 0) {
            try {
                const decision = await ask(budget);
                // The budget ran out before the model answered: the result is void, not invalid output.
                if (budget.remainingMs === 0) {
                    this.observeExpired('fallback');
                    return null;
                }
                const title = fallbackTitle(decision);
                if (title)
                    return title;
                outcome = 'invalid_output';
                invalidAttempts += 1;
                if (invalidAttempts >= TITLE_ATTEMPTS)
                    break;
            }
            catch (error) {
                // A request cancelled by closing is neither a failure nor worth a diagnostic.
                if (this.shutdown.signal.aborted)
                    break;
                outcome = 'failed';
                this.report('model', sessionId, error);
                const delayMs = retryDelays[providerRetries];
                providerRetries += 1;
                if (!(await retryAfter(budget, delayMs)))
                    break;
            }
        }
        if (!this.shutdown.signal.aborted)
            this.observe(outcome, 'fallback');
        return null;
    }
    /** A budget that ran out is a failed attempt, as for first-message generation; closing is not. */
    observeExpired(mode) {
        if (!this.shutdown.signal.aborted)
            this.observe('failed', mode);
    }
    async applyReview(sessionId, claimed, decision, signal) {
        if (!decision) {
            this.observe('invalid_output', 'review');
            return;
        }
        if (decision.action === 'keep' || decision.title === claimed.title) {
            this.observe('kept', 'review');
            return;
        }
        const title = normalizeSessionTitleCandidate(decision.title);
        if (!title) {
            this.observe('invalid_output', 'review');
            return;
        }
        await this.options.commitTitle(sessionId, title, { ...expectation(claimed), signal });
        this.observe('updated', 'review');
    }
    handleFailure(stage, mode, sessionId, error) {
        // Closing cancels in-flight work; that is not a failure to count or report.
        if (this.shutdown.signal.aborted)
            return;
        if (error instanceof SessionTitleConflictError ||
            (error instanceof SessionServiceError && error.reason === 'session-not-found')) {
            this.observe('skipped_race', mode);
        }
        else {
            this.observe('failed', mode);
            this.report(stage, sessionId, error);
        }
    }
    report(stage, sessionId, error) {
        try {
            this.options.onFailure?.({ stage, sessionId, error });
        }
        catch {
            /* Diagnostics are best-effort. */
        }
    }
    observe(outcome, mode) {
        try {
            this.options.onOutcome?.(outcome, mode);
        }
        catch {
            /* Metrics cannot fail a Turn. */
        }
    }
}
/** Backs off before the next provider-error retry; no delay left means no retry. */
function retryAfter(budget, delayMs) {
    return delayMs === undefined ? Promise.resolve(false) : budget.waitForRetry(delayMs);
}
/** A Session without a name must leave with one, so only a usable `replace` names it. */
function fallbackTitle(decision) {
    return decision?.action === 'replace' ? normalizeSessionTitleCandidate(decision.title) : null;
}
function loadReviewContent(input, request) {
    return 'loadContent' in input ? input.loadContent(request) : Promise.resolve(input);
}
function preparedReview(session, mode, content) {
    const userInputs = content.userInputs.map(stripSessionTitleInjectedTags).filter(Boolean);
    // Only a fallback may be named from the inputs alone, when its first request had no reply.
    if (!userInputs.length || (mode === 'review' && !content.finalReply.trim()))
        return null;
    return {
        session,
        mode,
        userInputs,
        finalReply: content.finalReply,
    };
}
/** Which pass this reply may run, if any; either pass claims at most once per Turn. */
function eligibleMode(session, turnId) {
    if (!acceptsTitleWork(session, turnId))
        return undefined;
    if (session.titleSource === 'auto') {
        return session.titleReviewState === 'pending' ? 'review' : undefined;
    }
    return session.titleSource === 'default' && canNameFallback(session) ? 'fallback' : undefined;
}
function acceptsTitleWork(session, turnId) {
    return (session.sessionType === 'branch' &&
        session.sessionKind !== 'task' &&
        session.visibility !== 'hidden' &&
        !session.archived &&
        session.titleReviewTurnId !== turnId);
}
/** A fallback written before reviews took over naming carries no state; it is named the same way. */
function canNameFallback(session) {
    const open = session.titleReviewState === 'pending' || session.titleReviewState === undefined;
    return open && (session.titleReviewAttempts ?? 0) < MAX_FALLBACK_NAMING_ATTEMPTS;
}
function expectation(session) {
    return {
        title: session.title ?? null,
        source: session.titleSource === 'default' ? 'default' : 'auto',
        reviewState: session.titleReviewState,
        reviewTurnId: session.titleReviewTurnId ?? null,
    };
}
//# sourceMappingURL=session-title-review-service.js.map