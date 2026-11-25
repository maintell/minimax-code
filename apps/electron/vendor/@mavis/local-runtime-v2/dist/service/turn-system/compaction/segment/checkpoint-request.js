import { omitUnsampleableVideosForModel, projectAgentMessagesForModel, } from '@mavis/agent-core/pi-turn-runner';
import { SEGMENT_PROTOCOL, buildSegmentControlText, buildSegmentSharedPrefixControlText, } from '../../../coordinator-text/index.js';
import { buildIsolatedTranscript } from './algorithm/transcript.js';
import { fingerprintRequest, firstRequestDifference, } from './request-fingerprint.js';
/**
 * A compaction model call gives up after 5 minutes. A Turn stops waiting for
 * it much earlier (the coordinator's foreground wait); the call keeps running
 * so its result can still be committed at a later Turn start.
 */
const SEGMENT_CHECKPOINT_TIMEOUT_MS = 300_000;
/**
 * The checkpoint is a strict-format rewrite, not a reasoning task. At the
 * session's effort a model whose thinking cannot be turned off drafts the whole
 * handoff inside thinking until the output budget or the timeout runs out
 * and no text block arrives (`empty`); at `low` it writes the text directly.
 */
const SEGMENT_CHECKPOINT_EFFORT = 'low';
const AT_OR_BELOW_CHECKPOINT_EFFORT = new Set(['none', 'minimal', SEGMENT_CHECKPOINT_EFFORT]);
class SegmentCheckpointRequestError extends Error {
    reason;
    name = 'SegmentCheckpointRequestError';
    constructor(reason, message, options) {
        super(message, options);
        this.reason = reason;
    }
}
/**
 * One Bunny compaction model call. With a main-request snapshot it first sends
 * the shared-prefix shape (system prompt and tools byte-identical to the last
 * main request, the protocol in the final control message); a tool call there
 * re-sends the same input once in the isolated shape. A route whose effort the
 * checkpoint lowers sends the isolated shape directly: the lowered effort
 * already breaks the cached prefix on routes that cache it implicitly, so the
 * shared shape would pay for the whole history uncached.
 */
export async function requestSegmentCheckpoint(input) {
    const timeout = AbortSignal.timeout(input.timeoutMs ?? SEGMENT_CHECKPOINT_TIMEOUT_MS);
    const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
    if (input.sharedPrefix && !checkpointLowersEffort(input)) {
        const shared = await send(input, buildSharedContext(input, input.sharedPrefix), signal, {
            sessionId: input.sharedPrefix.sessionId,
            timeout,
        });
        if (!hasToolCall(shared.final))
            return toResponse(input, shared, 'shared_prefix');
    }
    return toResponse(input, await send(input, buildIsolatedContext(input), signal, { timeout }), 'isolated');
}
function buildSharedContext(input, prefix) {
    const projected = projectAgentMessagesForModel(prefix.projectRequestMessages(input.records.map((record) => record.message)), input.model).messages;
    return {
        systemPrompt: prefix.systemPrompt,
        messages: [
            ...projected,
            controlMessage(buildSegmentSharedPrefixControlText(input.control), projected),
        ],
        tools: [...prefix.tools],
    };
}
function buildIsolatedContext(input) {
    const projected = projectAgentMessagesForModel(buildIsolatedTranscript(input.records, input.facts), input.model).messages;
    return {
        systemPrompt: SEGMENT_PROTOCOL,
        messages: [...projected, controlMessage(buildSegmentControlText(input.control), projected)],
    };
}
function controlMessage(text, projected) {
    return {
        role: 'user',
        content: [{ type: 'text', text }],
        timestamp: projected.at(-1)?.timestamp ?? 0,
    };
}
async function send(input, context, signal, options) {
    let final;
    let sent;
    const request = await withSampleableVideos(context, input.model);
    try {
        const stream = await input.streamFn(input.model, request, streamOptions(input, signal, options.sessionId, (payload) => {
            sent = fingerprintRequest(payload);
        }));
        final = await stream.result();
    }
    catch (error) {
        throw requestError(error, signal, options.timeout);
    }
    if (final.stopReason === 'aborted' || signal.aborted) {
        throw requestError(final.errorMessage, signal, options.timeout);
    }
    if (final.stopReason === 'error') {
        throw new SegmentCheckpointRequestError('provider_error', final.errorMessage ?? 'provider error');
    }
    return { final, sent };
}
/**
 * The main request replaces a video the provider would reject (a broken
 * container, a frame sampling or length rule) in its own copy only; the
 * records keep it, so the compaction request repeats that replacement.
 */
async function withSampleableVideos(context, model) {
    const sampled = await omitUnsampleableVideosForModel(context.messages, model);
    if (sampled.omittedCount + sampled.brokenCount + sampled.limitedCount === 0)
        return context;
    return { ...context, messages: sampled.messages };
}
function streamOptions(input, signal, sessionId, sent) {
    return {
        ...(input.apiKey === undefined ? {} : { apiKey: input.apiKey }),
        ...(input.headers === undefined ? {} : { headers: { ...input.headers } }),
        reasoning: input.model.reasoning && input.thinkingLevel !== 'off' ? input.thinkingLevel : undefined,
        maxTokens: input.maxOutputTokens,
        ...(sessionId === undefined ? {} : { sessionId }),
        onPayload: checkpointPayload(input.payloadTransform, sent),
        signal,
    };
}
/**
 * The route's own transform decides thinking and effort for the session; the
 * checkpoint then lowers an effort level the request carries. A request
 * without one keeps whatever the route sent.
 */
function checkpointPayload(transform, sent) {
    return async (payload, model) => {
        const transformed = (await transform?.(payload, model)) ?? payload;
        const lowered = lowerEffort(transformed, model.api);
        sent(transformed);
        if (lowered)
            return transformed;
        return transformed === payload ? undefined : transformed;
    };
}
function lowerEffort(payload, api) {
    if (!isRecord(payload))
        return false;
    if (api === 'openai-completions') {
        if (!aboveCheckpointEffort(payload.reasoning_effort))
            return false;
        payload.reasoning_effort = SEGMENT_CHECKPOINT_EFFORT;
        return true;
    }
    const holder = api === 'anthropic-messages' ? payload.output_config : payload.reasoning;
    if (!isRecord(holder) || !aboveCheckpointEffort(holder.effort))
        return false;
    holder.effort = SEGMENT_CHECKPOINT_EFFORT;
    return true;
}
/**
 * Whether the request carries an effort above the checkpoint's, which
 * `lowerEffort` then rewrites. The route sends the Turn's thinking level as its
 * effort whenever the model reasons and thinking is on.
 */
function checkpointLowersEffort(input) {
    return (input.model.reasoning === true &&
        input.thinkingLevel !== 'off' &&
        aboveCheckpointEffort(input.thinkingLevel));
}
function aboveCheckpointEffort(effort) {
    return typeof effort === 'string' && !AT_OR_BELOW_CHECKPOINT_EFFORT.has(effort);
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function requestError(cause, signal, timeout) {
    if (timeout.aborted) {
        return new SegmentCheckpointRequestError('timeout', 'Bunny compaction timed out.', { cause });
    }
    if (signal.aborted) {
        return new SegmentCheckpointRequestError('aborted', 'Bunny compaction was aborted.', { cause });
    }
    return new SegmentCheckpointRequestError('provider_error', cause instanceof Error ? cause.message : String(cause), { cause });
}
function hasToolCall(final) {
    return final.stopReason === 'toolUse' || final.content.some((block) => block.type === 'toolCall');
}
function toResponse(input, sent, shape) {
    const { final } = sent;
    if (hasToolCall(final)) {
        throw new SegmentCheckpointRequestError('tool_call', 'Bunny compaction called a tool.');
    }
    const text = final.content
        .flatMap((block) => (block.type === 'text' ? [block.text] : []))
        .join('');
    if (!text.trim())
        throw new SegmentCheckpointRequestError('empty', 'Bunny compaction was empty.');
    const usage = final.usage;
    return {
        text,
        shape,
        outputTokens: count(usage?.output),
        inputTokens: count(usage?.input),
        cacheReadTokens: count(usage?.cacheRead),
        cacheWriteTokens: count(usage?.cacheWrite),
        ...(sent.sent
            ? { prefixDifference: firstRequestDifference(input.mainRequest, sent.sent) }
            : {}),
    };
}
function count(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}
//# sourceMappingURL=checkpoint-request.js.map