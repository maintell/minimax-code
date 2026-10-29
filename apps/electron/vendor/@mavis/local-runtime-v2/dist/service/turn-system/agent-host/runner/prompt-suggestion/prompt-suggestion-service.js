import { composeStreamFn, } from '@mavis/agent-core/pi-turn-runner';
import { buildRecentConversationPrompt, latestUserText } from './recent-context.js';
import { evaluatePromptSuggestionPolicy, PROMPT_SUGGESTION_VERSION, promptSuggestionInstruction, } from './prompt-suggestion-policy.js';
/** One suggestion at a time per Session, and only a few across the process. */
const PROMPT_SUGGESTION_MAX_CONCURRENT = 2;
const PROMPT_SUGGESTION_MAX_TURN_KEYS = 64;
/** At most 64 restorable results are retained across all Sessions. */
const PROMPT_SUGGESTION_MAX_CACHED_RESULTS = 64;
/**
 * A generated suggestion is an optional convenience tied to a short-lived UI
 * surface, so it is retained only briefly. Past this it is treated exactly like
 * a result that was never generated.
 */
const PROMPT_SUGGESTION_RESULT_TTL_MS = 10 * 60 * 1_000;
/** Prompt asks for one line under 120 characters; never accept a longer one. */
const PROMPT_SUGGESTION_MAX_CHARS = 120;
/**
 * Turn ids are only unique inside their own Session, so every dedupe, cancel and
 * tombstone key is the (sessionId, turnId) pair.
 */
function turnKey(sessionId, turnId) {
    return `${sessionId}\u0000${turnId}`;
}
export function createPromptSuggestionCapture(resolved, payloadFactory) {
    let prepared;
    let finalAssistant;
    return {
        preparedHook(input) {
            prepared = input;
            finalAssistant = undefined;
        },
        assistantHook(input) {
            finalAssistant = input.message;
            return undefined;
        },
        read() {
            return prepared && finalAssistant
                ? { resolved, prepared, finalAssistant, payloadFactory }
                : undefined;
        },
    };
}
export function createPromptSuggestionService(options) {
    const now = options.nowMs ?? (() => Date.now());
    let closed = false;
    const pending = new Map();
    /** Bounded dedupe of already-scheduled Turns so a retry cannot double-spend. */
    const scheduledTurns = new Set();
    /**
     * Bounded record of Turns the user already cancelled. A cancel can arrive
     * before its Turn settles, so a late schedule must still be refused.
     */
    const cancelledTurns = new Set();
    /**
     * Restorable results, insertion-ordered and bounded. Only a result that passed
     * every safety and validation check is ever stored here; a capture, a prompt
     * or any conversation history is deliberately not part of the entry.
     */
    const results = new Map();
    /** Owner identity the current cache and in-flight work belong to. */
    let ownerIdentity = options.identity.identity();
    const detached = new WeakSet();
    const log = (fields) => {
        try {
            options.log?.(fields);
        }
        catch {
            /* Diagnostics cannot affect either turn. */
        }
    };
    const status = (sessionId, turnId, value) => {
        try {
            options.publish({
                type: 'turn.prompt_suggestion.status',
                payload: { sessionId, turnId, status: value },
            });
        }
        catch {
            /* Advisory. */
        }
    };
    /** Drops every retained result. Used by close and by an identity change. */
    const clearResults = () => {
        results.clear();
    };
    /**
     * Drops one Session's result. A newer Turn supersedes the previous Turn's
     * suggestion, so its restored result is no longer meaningful either.
     */
    const clearSessionResult = (sessionId) => {
        for (const [key, result] of results) {
            if (result.sessionId === sessionId)
                results.delete(key);
        }
    };
    const storeResult = (result) => {
        clearSessionResult(result.sessionId);
        const key = turnKey(result.sessionId, result.turnId);
        // Re-insert so the map stays in least-recently-stored order.
        results.delete(key);
        results.set(key, result);
        while (results.size > PROMPT_SUGGESTION_MAX_CACHED_RESULTS) {
            const oldest = results.keys().next();
            if (oldest.done)
                return;
            results.delete(oldest.value);
        }
    };
    /**
     * Detects an account change. Returning true means the caller must abandon its
     * own work: the cache was dropped and in-flight requests were aborted, so a
     * late completion belonging to the previous identity is never published.
     */
    const syncIdentity = () => {
        const current = options.identity.identity();
        if (current === ownerIdentity)
            return false;
        ownerIdentity = current;
        clearResults();
        for (const sessionId of [...pending.keys()]) {
            const entry = pending.get(sessionId);
            pending.delete(sessionId);
            entry?.controller.abort();
        }
        log({ status: 'identity_changed', promptVersion: PROMPT_SUGGESTION_VERSION });
        return true;
    };
    const policyKey = () => JSON.stringify([options.enabled(), options.policy()]);
    let currentPolicyKey = policyKey();
    const syncPolicy = () => {
        const next = policyKey();
        if (next === currentPolicyKey)
            return;
        currentPolicyKey = next;
        clearResults();
        for (const entry of pending.values())
            entry.controller.abort();
        pending.clear();
    };
    /**
     * Session-wide cancel: a new Turn, disposal or shutdown supersedes any
     * request. The retained result is dropped too, because the new Turn replaces
     * what the previous one offered.
     */
    const cancel = (sessionId) => {
        clearSessionResult(sessionId);
        const entry = pending.get(sessionId);
        if (!entry)
            return;
        pending.delete(sessionId);
        entry.controller.abort();
    };
    /**
     * Precise per-Turn cancel. Never touches a newer Turn of the same Session, and
     * always records a tombstone so a cancel that beats its own schedule still
     * blocks that late schedule. The tombstone outranks the cache, so a completed
     * result the user already dismissed can never be restored by a later read,
     * including a UI remount or navigation.
     */
    const cancelTurn = (sessionId, turnId) => {
        rememberTurn(cancelledTurns, turnKey(sessionId, turnId));
        results.delete(turnKey(sessionId, turnId));
        const entry = pending.get(sessionId);
        if (!entry || entry.turnId !== turnId)
            return false;
        pending.delete(sessionId);
        entry.controller.abort();
        return true;
    };
    return {
        cancel,
        cancelTurn,
        isEnabled: () => {
            syncIdentity();
            syncPolicy();
            const policy = options.policy();
            return !closed && options.enabled() && !policy.killSwitch && policy.sampleRate > 0;
        },
        /**
         * Restores an already generated suggestion. This performs no model request
         * and spends no quota. Every condition that must not be resurrected returns
         * a status instead of text: a disabled feature, a closed runtime, a
         * different account, a cancelled Turn, an expired entry, a superseded Turn,
         * or a policy that no longer admits the feature.
         */
        read(sessionId, turnId) {
            if (syncIdentity())
                return { status: 'other_account' };
            syncPolicy();
            if (closed || !options.enabled())
                return { status: 'disabled' };
            const policy = options.policy();
            if (!evaluatePromptSuggestionPolicy(policy, { sessionId }).allowed)
                return { status: 'disabled' };
            const key = turnKey(sessionId, turnId);
            if (cancelledTurns.has(key))
                return { status: 'cancelled' };
            const result = results.get(key);
            if (!result)
                return { status: 'absent' };
            if (now() - result.generatedAt > PROMPT_SUGGESTION_RESULT_TTL_MS) {
                results.delete(key);
                log({ sessionId, turnId, status: 'expired', promptVersion: result.promptVersion });
                return { status: 'expired' };
            }
            return {
                suggestion: result.suggestion,
                promptVersion: result.promptVersion,
                generatedAt: result.generatedAt,
                elapsedMs: result.elapsedMs,
                usage: result.usage,
                status: 'ready',
            };
        },
        close() {
            closed = true;
            clearResults();
            for (const sessionId of [...pending.keys()])
                cancel(sessionId);
        },
        schedule(sessionId, turnId, capture) {
            syncPolicy();
            if (closed || !options.enabled() || capture.finalAssistant.stopReason !== 'stop')
                return;
            // Dedupe runs before any cancel: a repeated schedule for the same Turn
            // must not cancel the request it is duplicating.
            const key = turnKey(sessionId, turnId);
            if (cancelledTurns.has(key) || scheduledTurns.has(key))
                return;
            // An account switch invalidates everything in flight, so refuse before any
            // capture is retained or any request is issued.
            if (syncIdentity())
                return;
            // Policy is evaluated before the capture is used, so a kill switch or an
            // unsampled Session costs no request at all. The user switch cannot
            // re-enable what the policy refused.
            const decision = evaluatePromptSuggestionPolicy(options.policy(), { sessionId });
            if (!decision.allowed) {
                log({
                    sessionId,
                    turnId,
                    status: `skipped_policy_${decision.reason}`,
                    promptVersion: PROMPT_SUGGESTION_VERSION,
                });
                status(sessionId, turnId, 'unavailable');
                return;
            }
            if (pending.size >= PROMPT_SUGGESTION_MAX_CONCURRENT) {
                log({ sessionId, turnId, status: 'skipped_concurrency_limit' });
                status(sessionId, turnId, 'unavailable');
                return;
            }
            rememberTurn(scheduledTurns, key);
            // A newer Turn of this Session supersedes whatever is still generating.
            cancel(sessionId);
            const controller = new AbortController();
            const admittedPolicyKey = currentPolicyKey;
            const admittedIdentity = ownerIdentity;
            const stillCurrent = () => {
                syncIdentity();
                syncPolicy();
                return (!closed &&
                    options.enabled() &&
                    !controller.signal.aborted &&
                    admittedPolicyKey === currentPolicyKey &&
                    admittedIdentity === ownerIdentity &&
                    pending.get(sessionId)?.controller === controller);
            };
            pending.set(sessionId, { turnId, controller });
            detached.add(runScheduledSuggestion({
                options,
                sessionId,
                turnId,
                capture,
                controller,
                stillCurrent,
                storeResult,
                log,
                status,
                now,
                finish: () => {
                    if (pending.get(sessionId)?.controller === controller)
                        pending.delete(sessionId);
                },
            }));
        },
    };
}
async function runScheduledSuggestion({ options, sessionId, turnId, capture, controller, stillCurrent, storeResult, log, status, now, finish, }) {
    const started = Date.now();
    const disabled = setInterval(() => {
        if (!stillCurrent())
            controller.abort();
    }, 250);
    // The abort listener is armed before the first status is published, so a
    // synchronous subscriber that cancels on `generating` is still observed:
    // an abort dispatched before any listener exists can never be replayed.
    const aborted = new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(new Error('suggestion_cancelled')), {
        once: true,
    }));
    // Published only once the request is cancellable, so a synchronous
    // subscriber can already find it in `pending`.
    status(sessionId, turnId, 'generating');
    const supersededByPendingInput = async () => {
        let pendingInput = false;
        try {
            pendingInput = (await options.hasPendingInput?.(sessionId)) === true;
        }
        catch {
            /* Unreadable queue: proceed; the next Turn's start still cancels. */
        }
        if (controller.signal.aborted)
            throw new Error('suggestion_cancelled');
        if (!pendingInput)
            return false;
        log({ sessionId, turnId, status: 'skipped_pending_input' });
        status(sessionId, turnId, 'unavailable');
        return true;
    };
    const canGenerate = async () => {
        // Cancelled between the schedule and the first await: start nothing, and
        // report the cancellation instead of leaving the status on `generating`.
        if (controller.signal.aborted)
            throw new Error('suggestion_cancelled');
        // Checked before the membership read and again right before the model
        // request: input requeued at the Turn's exit is committed asynchronously.
        if (await supersededByPendingInput())
            return false;
        if (options.eligibility) {
            const ineligible = await options.eligibility.check(controller.signal);
            if (controller.signal.aborted)
                throw new Error('suggestion_cancelled');
            if (ineligible) {
                log({ sessionId, turnId, status: 'skipped_ineligible', reason: ineligible });
                status(sessionId, turnId, 'unavailable');
                return false;
            }
        }
        if (controller.signal.aborted)
            throw new Error('suggestion_cancelled');
        if (await supersededByPendingInput())
            return false;
        return stillCurrent();
    };
    const work = async () => {
        if (!(await canGenerate()))
            return;
        const message = await generatePromptSuggestion(capture, controller.signal);
        const elapsedMs = Date.now() - started;
        const usage = readUsage(message.usage);
        // The request was issued and cost quota whatever happens next, so this
        // is logged before any validation outcome. Never logs prompt text.
        log({
            sessionId,
            turnId,
            status: 'request_completed',
            elapsedMs,
            promptVersion: PROMPT_SUGGESTION_VERSION,
            usage,
            stopReason: message.stopReason,
            contentTypes: message.content.map((part) => part.type),
        });
        const verdict = validatePromptSuggestion(message, latestUserText(capture.prepared.messages));
        if (!stillCurrent())
            return;
        if (typeof verdict !== 'string') {
            // A well-formed reply that carries no usable next action. Distinct
            // from a safety rejection below, and neither is ever cached.
            log({
                sessionId,
                turnId,
                status: verdict.abstained ? 'abstained' : 'rejected_validation',
                elapsedMs,
                promptVersion: PROMPT_SUGGESTION_VERSION,
            });
            status(sessionId, turnId, 'unavailable');
            return;
        }
        const text = verdict;
        if (!(await options.review(text))) {
            log({
                sessionId,
                turnId,
                status: 'rejected_safety',
                elapsedMs,
                promptVersion: PROMPT_SUGGESTION_VERSION,
            });
            status(sessionId, turnId, 'unavailable');
            return;
        }
        if (!stillCurrent())
            return;
        // Only a result that passed every check becomes restorable, and only
        // under the version that actually produced this exact text.
        log({
            sessionId,
            turnId,
            status: 'generated',
            promptVersion: PROMPT_SUGGESTION_VERSION,
            elapsedMs,
        });
        storeResult({
            sessionId,
            turnId,
            suggestion: text,
            promptVersion: PROMPT_SUGGESTION_VERSION,
            generatedAt: now(),
            elapsedMs,
            usage,
        });
        options.publish({
            type: 'turn.prompt_suggestion.generated',
            payload: {
                sessionId,
                turnId,
                suggestion: text,
                promptVersion: PROMPT_SUGGESTION_VERSION,
                elapsedMs,
                usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens },
            },
        });
    };
    const settle = async () => {
        try {
            await Promise.race([work(), aborted]);
        }
        catch {
            status(sessionId, turnId, controller.signal.aborted ? 'cancelled' : 'unavailable');
            log({
                sessionId,
                turnId,
                status: controller.signal.aborted ? 'cancelled' : 'failed',
                elapsedMs: Date.now() - started,
                promptVersion: PROMPT_SUGGESTION_VERSION,
            });
        }
        finally {
            clearInterval(disabled);
            finish();
            // Release the request. Transport watchdogs listen to this signal and
            // would otherwise stay armed until they expire on their own.
            if (!controller.signal.aborted)
                controller.abort();
        }
    };
    await settle();
}
/**
 * Normalises provider usage into the reported shape. pi-ai reports a cached
 * prefix under `cacheRead`/`cacheWrite` and excludes it from `input`, so the
 * three are summed into the whole prompt. Missing counts read as zero.
 */
function readUsage(usage) {
    const count = (value) => typeof value === 'number' && Number.isFinite(value) ? value : 0;
    return {
        inputTokens: count(usage?.input) + count(usage?.cacheRead) + count(usage?.cacheWrite),
        outputTokens: count(usage?.output),
    };
}
/**
 * Issues the suggestion as its own small request: the recent conversation as
 * one user message, with no system prompt and no tools. Thinking and effort
 * follow the user's selection for the main Turn; no output cap is set, so a
 * thinking reply is never cut short.
 */
async function generatePromptSuggestion(capture, signal) {
    // The instruction is read through the version it belongs to, so a result can
    // never be published under a version that did not produce its text.
    const instruction = promptSuggestionInstruction(PROMPT_SUGGESTION_VERSION);
    if (!instruction)
        throw new Error('unknown_prompt_suggestion_version');
    const context = {
        messages: [
            {
                role: 'user',
                content: buildRecentConversationPrompt(capture.prepared.messages, capture.finalAssistant, instruction),
                timestamp: Date.now(),
            },
        ],
    };
    const transform = capture.payloadFactory(signal);
    // Same thinking level as the main Turn's last call, mapped the way the main
    // runner maps it: `off` sends no reasoning option.
    const thinkingLevel = capture.prepared.thinkingLevel;
    const response = await composeStreamFn(capture.resolved)(capture.prepared.model, context, {
        ...(thinkingLevel && thinkingLevel !== 'off' ? { reasoning: thinkingLevel } : {}),
        apiKey: capture.resolved.apiKey,
        headers: capture.resolved.headers,
        maxRetries: 0,
        signal,
        onPayload: async (payload, model) => (await transform(payload, model)) ?? payload,
    });
    return response.result();
}
function normalizeSuggestion(text) {
    return text.toLowerCase().replace(/[\p{P}\s]/gu, '');
}
/** Reject only standalone conversational fillers, not useful requests containing them. */
function isNonActionSuggestion(text) {
    return /^(?:不用了|不需要了|先这样|就这样|暂时不用|谢谢你?|多谢|好的?|明白了?|知道了|收到|再见|辛苦了|继续|thanks|thankyou|nothanks|ok(?:ay)?|gotit|bye|goodbye|continue)+$/u.test(normalizeSuggestion(text));
}
const ABSTAIN_WORDS = /^(?:empty|none|nothing|null|n\/?a|无|暂无|没有|空|无建议|没有建议|无需操作|不需要|无下一步)$/iu;
/**
 * Models asked to "return nothing" sometimes write a placeholder instead, such
 * as "(empty)" or "无". A whole reply wrapped in brackets, or one of these
 * words alone, is an abstention rather than a suggestion.
 */
function isAbstention(text) {
    return (/^[(（[【].*[)）\]】]$/su.test(text) ||
        ABSTAIN_WORDS.test(text) ||
        ABSTAIN_WORDS.test(normalizeSuggestion(text)));
}
/**
 * Returns the suggestion text, or why there is none. Thinking blocks are
 * ignored: models that cannot switch thinking off still answer in text. A
 * tool call, a truncated or failed reply, or a reply of the wrong shape is
 * rejected.
 */
function validatePromptSuggestion(message, previousUserText) {
    if (message.stopReason !== 'stop' ||
        message.errorMessage ||
        message.content.some((part) => part.type !== 'text' && part.type !== 'thinking'))
        return { abstained: false };
    const text = message.content
        .map((part) => (part.type === 'text' ? part.text : ''))
        .join('')
        .trim();
    // Task complete or no useful next step yields nothing, never filler.
    if (!text || isAbstention(text))
        return { abstained: true };
    if (text.length > PROMPT_SUGGESTION_MAX_CHARS || /[\r\n]/u.test(text))
        return { abstained: false };
    if (isNonActionSuggestion(text) ||
        normalizeSuggestion(text) === normalizeSuggestion(previousUserText))
        return { abstained: false };
    return text;
}
/** Bounded insertion-ordered LRU of (sessionId, turnId) keys; all disposable. */
function rememberTurn(keys, key) {
    keys.add(key);
    while (keys.size > PROMPT_SUGGESTION_MAX_TURN_KEYS) {
        const oldest = keys.values().next();
        if (oldest.done)
            return;
        keys.delete(oldest.value);
    }
}
//# sourceMappingURL=prompt-suggestion-service.js.map