import { composeStreamFn, recordPiLLMCallMetrics, withLLMRetry, withSessionIdentity, withTurnRequestPhase, } from '@mavis/agent-core/pi-turn-runner';
import { resetPtcPrefixBaseline } from '../runner/observability/ptc-prefix-fingerprint.js';
import { endToolSearchWindow, forgetToolSearchAnnouncements } from '../tools/tool-search.js';
import { resolveCheckpointRequestShape } from './checkpoint-request-shape.js';
import { captureContextCompactionResult, createCompactionReplaceMetadata, } from './context-compaction.js';
/**
 * The segment profile for the Sessions `usesProfile` accepts, decided once
 * when a Turn begins and again for a manual `/compact`. Every other Session
 * stays on the default profile and never reaches `segments`: the host ends a
 * Turn and observes its main request only when the Turn began on the profile,
 * and other readers of the profile ask `onProfile` first.
 */
export function scopeSegmentCompaction(segments, usesProfile) {
    const profiled = new Set();
    const decide = async (sessionId) => {
        const uses = await usesProfile(sessionId);
        if (uses)
            profiled.add(sessionId);
        else
            profiled.delete(sessionId);
        return uses;
    };
    return {
        beginTurn: async (input) => (await decide(input.sessionId)) ? segments.beginTurn(input) : undefined,
        endTurn: (input) => segments.endTurn(input),
        observeMainRequest: (input) => segments.observeMainRequest(input),
        compactManual: async (input) => (await decide(input.sessionId)) ? segments.compactManual(input) : undefined,
        onProfile: (sessionId) => profiled.has(sessionId),
        providerSessionId: async (sessionId) => (await usesProfile(sessionId)) ? segments.providerSessionId?.(sessionId) : undefined,
        resetContext: async (input) => segments.resetContext && (await usesProfile(input.sessionId))
            ? segments.resetContext(input)
            : undefined,
    };
}
/**
 * Turn start of the segment profile: a ready background result is committed
 * here, before the Turn reads its history, through the single Host history
 * writer. The segment profile swallows its own failures; this never fails the Turn.
 */
export async function beginSegmentCompactionTurn(input) {
    const segments = input.compaction?.segments;
    if (!segments)
        return undefined;
    try {
        return await segments.beginTurn({
            sessionId: input.context.sessionId,
            turnId: input.context.turnId,
            commit: (commit) => commitSegment(input, commit),
            ...(input.request ? { pendingInputText: pendingTurnInputText(input.request) } : {}),
        });
    }
    catch {
        return undefined;
    }
}
/** The repairs one preparation may take: the history's and the configuration's. */
const MAX_PREPARATION_REPAIRS = 2;
/**
 * Prepares the Turn. When the preparation fails, the segment profile may
 * repair what the failure points at (a history or configuration file it
 * cannot read), and the Turn prepares once more; a failure nothing repairs
 * fails it.
 *
 * @internal Exported only for focused tests.
 */
export async function prepareRepairing(prepare, turn) {
    for (let repairs = 0;; repairs += 1) {
        try {
            return await prepare();
        }
        catch (error) {
            if (repairs >= MAX_PREPARATION_REPAIRS ||
                !turn?.repairPreparation ||
                (await repairOutcome(turn, error)) !== 'repaired') {
                throw error;
            }
        }
    }
}
/**
 * Prepares the Turn, repairing what the segment profile can repair, and gives
 * its model route the session identifier the profile chose.
 */
export async function prepareSegmentTurn(prepare, turn) {
    const prepared = await prepareRepairing(prepare, turn);
    const preparation = withSegmentSessionIdentity(prepared.preparation, turn?.providerSessionId);
    return { ...prepared, preparation };
}
/** The segment profile learns how every Turn it began ended (spec 3.5, 12.1). */
export function settleSegmentTurn(turn, outcome) {
    try {
        turn?.finish({
            status: outcome.status,
            ...(outcome.status === 'completed' && outcome.waitingForUser ? { waitingForUser: true } : {}),
        });
    }
    catch {
        // The segment profile can never fail a settled Turn.
    }
    return outcome;
}
/**
 * The Turn's model route with the session identifier the segment profile
 * gives it: a request that carries a session identifier (the main request,
 * a shared-prefix compaction request) carries this one, read as it is sent.
 */
export function withSegmentSessionIdentity(preparation, providerSessionId) {
    if (!providerSessionId)
        return preparation;
    const streamFn = withSessionIdentity(preparation.llm.streamFn, providerSessionId);
    return { ...preparation, llm: { ...preparation.llm, streamFn } };
}
async function repairOutcome(turn, error) {
    try {
        return (await turn.repairPreparation?.(error)) ?? 'not_handled';
    }
    catch {
        return 'not_handled';
    }
}
/** Text this Turn is about to add to the history, for the Turn-start size check (11.5). */
function pendingTurnInputText(request) {
    if (request.executionMode === 'continuation')
        return '';
    const { input } = request;
    return [
        input.text,
        input.quotedMessage?.text,
        ...(input.queuedMessages ?? []).map((item) => item.text),
    ]
        .filter((text) => typeof text === 'string' && text.length > 0)
        .join('\n');
}
async function commitSegment(input, commit) {
    const { context } = input;
    const attemptId = input.attempts.create(context, input.leaseId, 'initial');
    // Paired with the writer's barrier release once the replacement settles.
    await input.compaction?.barrier?.begin(context.sessionId, attemptId, context.turnId);
    const result = captureContextCompactionResult(commit.result, commit.result.messagesBefore);
    if (result.status !== 'completed')
        throw new TypeError('Segment commit must be completed.');
    await input.committedHistory.commit(context, {
        sessionId: context.sessionId,
        turnId: context.turnId,
        reason: 'replaceMessages',
        messages: [...result.replacementMessages],
        metadata: createCompactionReplaceMetadata(result, 'initial', attemptId),
        operation: {
            id: `agent-host:${context.turnId}:history:compaction:${encodeURIComponent(result.compactionId)}`,
            kind: 'compaction',
        },
    }, { compactionAttemptId: attemptId });
}
/**
 * The model route a finished Turn hands to its background compaction: the
 * same resolved model, credentials and managed auth refresh, wrapped in the
 * compaction-scoped transport retry; no forced first tool. Its requests carry
 * the compaction turn phase, like every other compaction request.
 */
export function segmentCompactionRoute(input) {
    const { llm } = input;
    const streamFn = withTurnRequestPhase(withLLMRetry(composeStreamFn(llm), {
        sessionId: input.sessionId,
        turnId: `${input.turnId}:segment-compaction`,
        scope: 'compaction',
        onCallSettled: (event) => recordPiLLMCallMetrics(input.compaction?.metricsClient, 'compact', event, llm.route),
    }), () => 'compaction', llm.turnPhaseHeader);
    return {
        model: llm.model,
        streamFn,
        thinkingLevel: llm.thinkingLevel ?? 'off',
        ...(llm.maxTokens === undefined ? {} : { maxTokens: llm.maxTokens }),
        ...(llm.apiKey === undefined ? {} : { apiKey: llm.apiKey }),
        ...(llm.headers === undefined ? {} : { headers: llm.headers }),
        ...(input.payloadTransform ? { payloadTransform: input.payloadTransform } : {}),
        sharedPrefixAllowed: resolveCheckpointRequestShape(llm, input.compaction?.checkpointSharedPrefixEnabled) ===
            'shared_prefix',
    };
}
/** A context reset that failed; `category` tells the caller which failure to report (context reset spec 5.4). */
export class BunnyContextResetError extends Error {
    category;
    name = 'BunnyContextResetError';
    constructor(category, cause) {
        super(`Bunny context reset failed: ${category}`, { cause });
        this.category = category;
    }
}
/**
 * The user's context reset of a Bunny main conversation, in place of a
 * compaction (context reset spec 4 to 7). Undefined: the segment profile does
 * not take it, and the request compacts as before. Nothing of the compaction
 * lifecycle runs: no compaction card, no model request.
 */
export async function resetContextOrSkip(compaction, input) {
    const reset = input.contextReset;
    const segments = compaction?.segments;
    if (!reset || !compaction || !segments?.resetContext)
        return undefined;
    const { sessionId, turnId } = input.lease;
    const outcome = await segments.resetContext({ sessionId, turnId, ...reset });
    if (!outcome)
        return undefined;
    if (outcome.status === 'failed') {
        return { status: 'failed', error: new BunnyContextResetError(outcome.category, outcome.error) };
    }
    // The history the next Turn reads starts over: every per-history hint does too.
    resetPtcPrefixBaseline(sessionId);
    endToolSearchWindow(sessionId);
    forgetToolSearchAnnouncements(sessionId);
    try {
        compaction.usageAnchor?.advanceHistory(sessionId);
    }
    catch {
        // Process-local usage hints never change the reset.
    }
    return {
        status: 'completed',
        compactionId: outcome.resetId,
        messagesBefore: outcome.messagesBefore,
        messagesAfter: 1,
        tokensBefore: outcome.tokensBefore,
        tokensAfter: outcome.tokensAfter,
    };
}
//# sourceMappingURL=segment-turn.js.map