import { createHash } from 'node:crypto';
import { isLLMMediaContentRejectionMessage, parseLLMMediaCountLimitMessage, } from '@mavis/shared/llm-error-classifier';
import { listRequestImages, replaceRequestImages, } from './request-image-limit.js';
/**
 * Resend a request MiniMax rejected for an image or video it carries, without
 * that media, inside the same logical call.
 *
 * The outbound guards (the broken-container and frame-sampling checks, the
 * image filters) catch what they can read before the request is sent. What
 * they miss still fails the whole request with `invalid params, 400 (2013)`,
 * and the media lives in persisted history, so every later request fails the
 * same way and the session cannot recover (MCT-202611-E3ZW0XFK). This is the
 * net behind those guards:
 *
 * - The request is resent with the newest media the provider has not accepted
 *   before replaced by a placeholder that tells the agent what happened, then
 *   with more of it, at most {@link MAX_MEDIA_REJECTION_RETRIES} times. Media
 *   the provider accepted in an earlier request is never left out.
 * - Each verdict is remembered per model by a fingerprint of the media, so a
 *   later request leaves the rejected media out up front instead of failing
 *   first, and a learned count limit is applied up front too.
 * - When no resend is accepted, or a resend fails for anything other than
 *   media, the call ends with the first, original failure, so the host's own
 *   failure handling sees what it always saw.
 *
 * Only the provider-bound copy changes; history keeps every block. A call
 * that already produced output, was cancelled, or failed for anything else
 * passes through untouched.
 */
export function withRejectedMediaRetry(inner, options) {
    const registry = options.registry ?? processRequestMediaRegistry;
    return (async (model, context, streamOptions) => {
        const media = listRequestMedia(context.messages);
        if (media.length === 0)
            return inner(model, context, streamOptions);
        const modelKey = `${model.provider}/${model.id}`;
        const call = {
            options,
            registry,
            modelKey,
            media,
            texts: rememberedOmissions(media, registry, modelKey),
            retriedOmissions: [],
        };
        logRememberedOmissions(call, model.provider);
        let first;
        let ladder;
        for (let retries = 0;; retries += 1) {
            const request = call.texts.size === 0
                ? context
                : {
                    ...context,
                    messages: replaceRequestImages(context.messages, (image) => call.texts.get(image.key)),
                };
            const attempt = await openAttempt(inner, model, request, streamOptions);
            if (attempt.kind === 'committed') {
                settleAcceptedRequest(call, retries, model.provider);
                return attempt.stream;
            }
            first ??= attempt;
            if (streamOptions?.signal?.aborted)
                return deliverFailure(first);
            ladder ??= omissionLadder(call, attempt.errorMessage);
            const rung = nextRung(ladder, retries, attempt.errorMessage);
            if (!rung) {
                if (retries > 0)
                    logUnrecovered(call, model.provider, retries, first.errorMessage);
                return deliverFailure(first);
            }
            applyRung(call, rung);
            logRetry(call, model.provider, retries + 1, rung, attempt.errorMessage);
            notify(options.beforeResend);
        }
    });
}
/** Resends after a media rejection, each leaving more media out. */
export const MAX_MEDIA_REJECTION_RETRIES = 3;
/** Verdicts kept per process; least recently used go first. */
const REQUEST_MEDIA_REGISTRY_MAX_ENTRIES = 4096;
/** Base64 characters sampled from each end and the middle of a block. */
const FINGERPRINT_SAMPLE_CHARS = 64 * 1024;
/**
 * The gateway's wording, without anything the request carried. It arrives as
 * the message of a JSON error body, so quotes inside it are escaped
 * (`video format \".webm\" not allowed`) and an unescaped quote ends it.
 */
const GATEWAY_ERROR_SUMMARY_RE = /invalid params?(?:[^"\\]|\\.){0,200}?\(2013\)/i;
/**
 * What the provider did with requests carrying a media block, per model and
 * by a fingerprint of the block. History replays the same blocks on every
 * request of a session, so one verdict serves all of them.
 */
export class RequestMediaRegistry {
    maxEntries;
    verdicts = new Map();
    countLimits = new Map();
    constructor(maxEntries = REQUEST_MEDIA_REGISTRY_MAX_ENTRIES) {
        this.maxEntries = maxEntries;
    }
    verdict(model, fingerprint) {
        const key = `${model}\n${fingerprint}`;
        const verdict = this.verdicts.get(key);
        if (verdict === undefined)
            return undefined;
        this.verdicts.delete(key);
        this.verdicts.set(key, verdict);
        return verdict;
    }
    record(model, fingerprint, verdict) {
        const key = `${model}\n${fingerprint}`;
        this.verdicts.delete(key);
        this.verdicts.set(key, verdict);
        for (const oldest of this.verdicts.keys()) {
            if (this.verdicts.size <= this.maxEntries)
                break;
            this.verdicts.delete(oldest);
        }
    }
    countLimit(model, kind) {
        return this.countLimits.get(`${model}\n${kind}`);
    }
    recordCountLimit(model, kind, limit) {
        this.countLimits.set(`${model}\n${kind}`, limit);
    }
}
const processRequestMediaRegistry = new RequestMediaRegistry();
/**
 * Read the attempt up to its first frame other than `start`. Output, or an
 * empty response, commits it: the provider accepted the request. A rejection
 * arrives before any output, so it can still be replaced by a resend.
 */
async function openAttempt(inner, model, request, streamOptions) {
    let stream;
    try {
        stream = await inner(model, request, streamOptions);
    }
    catch (error) {
        return {
            kind: 'failed',
            errorMessage: errorText(error),
            deliver: () => {
                throw error;
            },
        };
    }
    const iterator = stream[Symbol.asyncIterator]();
    const held = [];
    try {
        for (;;) {
            const next = await iterator.next();
            if (next.done)
                return await endedAttempt(stream, held);
            held.push(next.value);
            if (next.value.type === 'start')
                continue;
            if (next.value.type === 'error') {
                // Its usage is on the ledger before the next request.
                await stream.result().catch(() => undefined);
                return failedAttempt(stream, held, iterator, next.value.error.errorMessage);
            }
            return { kind: 'committed', stream: replayStream(held, iterator, () => stream.result()) };
        }
    }
    catch (error) {
        return {
            kind: 'failed',
            errorMessage: errorText(error),
            deliver: () => replayStream(held, throwingIterator(error), () => stream.result()),
        };
    }
}
/** The attempt ended without a terminal frame; its own result decides. */
async function endedAttempt(stream, held) {
    const ended = emptyIterator();
    const final = await stream.result().catch(() => undefined);
    if (final?.stopReason === 'error') {
        return failedAttempt(stream, held, ended, final.errorMessage);
    }
    return { kind: 'committed', stream: replayStream(held, ended, () => stream.result()) };
}
function failedAttempt(stream, held, rest, errorMessage) {
    return {
        kind: 'failed',
        errorMessage,
        deliver: () => replayStream(held, rest, () => stream.result()),
    };
}
function deliverFailure(first) {
    return first.deliver();
}
/** The frames already read, then the rest of the attempt; its result is the attempt's own. */
function replayStream(held, rest, result) {
    return {
        [Symbol.asyncIterator]() {
            let index = 0;
            return {
                async next() {
                    const value = held[index];
                    if (value === undefined)
                        return rest.next();
                    index += 1;
                    return { value, done: false };
                },
                async return(value) {
                    index = held.length;
                    await rest.return?.(value);
                    return { value: undefined, done: true };
                },
            };
        },
        result,
    };
}
function throwingIterator(error) {
    return {
        async next() {
            throw error;
        },
    };
}
function emptyIterator() {
    return {
        async next() {
            return { value: undefined, done: true };
        },
    };
}
function errorText(error) {
    return error instanceof Error ? error.message : undefined;
}
function listRequestMedia(messages) {
    return listRequestImages(messages).flatMap((image) => {
        const data = blockData(messages[image.messageIndex], image.blockIndex);
        if (data === undefined)
            return [];
        const kind = image.mimeType?.toLowerCase().startsWith('video/') ? 'video' : 'image';
        return [{ ...image, kind, fingerprint: mediaFingerprint(data, image.mimeType) }];
    });
}
function blockData(message, blockIndex) {
    if (!message || !Array.isArray(message.content))
        return undefined;
    const block = message.content[blockIndex];
    if (!block || typeof block !== 'object')
        return undefined;
    const data = block.data;
    return typeof data === 'string' && data.length > 0 ? data : undefined;
}
/**
 * Media type, length and three samples of the base64 data. A request may carry
 * many large videos, so the whole data is not hashed on every request.
 */
function mediaFingerprint(data, mimeType) {
    const hash = createHash('sha256').update(`${mimeType?.toLowerCase() ?? ''}\n${data.length}\n`);
    if (data.length <= FINGERPRINT_SAMPLE_CHARS * 3)
        return hash.update(data).digest('hex');
    const middle = Math.floor((data.length - FINGERPRINT_SAMPLE_CHARS) / 2);
    return hash
        .update(data.slice(0, FINGERPRINT_SAMPLE_CHARS))
        .update(data.slice(middle, middle + FINGERPRINT_SAMPLE_CHARS))
        .update(data.slice(-FINGERPRINT_SAMPLE_CHARS))
        .digest('hex');
}
/** Placeholders for media rejected before, and for media past a learned count limit. */
function rememberedOmissions(media, registry, modelKey) {
    const texts = new Map();
    for (const item of media) {
        const known = registry.verdict(modelKey, item.fingerprint);
        if (known?.verdict === 'rejected')
            texts.set(item.key, rememberedRejectionText(item, known.error));
    }
    for (const kind of ['image', 'video']) {
        const limit = registry.countLimit(modelKey, kind);
        if (limit === undefined)
            continue;
        for (const item of overLimit(media, texts, kind, limit)) {
            texts.set(item.key, overLimitText(item, limit));
        }
    }
    return texts;
}
/** The oldest media of `kind` still sent beyond the newest `limit`. */
function overLimit(media, texts, kind, limit) {
    const sent = media.filter((item) => item.kind === kind && !texts.has(item.key));
    return sent.slice(0, Math.max(0, sent.length - limit));
}
/**
 * The resends for this rejection, each leaving more media out. A content
 * rejection that names the media type leaves out only that type; one that
 * names none (a decoder failure) starts with videos, or with images for the
 * `410` an image with a 2px edge gets, and then leaves out the other type too.
 */
function omissionLadder(call, errorMessage) {
    const error = gatewayErrorSummary(errorMessage);
    const count = parseLLMMediaCountLimitMessage(errorMessage);
    if (count) {
        const omit = overLimit(call.media, call.texts, count.media, count.limit);
        if (omit.length === 0)
            return [];
        const countLimit = { kind: count.media, limit: count.limit };
        return [
            {
                omit,
                text: (item) => overLimitText(item, count.limit),
                rejection: 'count',
                countLimit,
                error,
            },
        ];
    }
    if (!isLLMMediaContentRejectionMessage(errorMessage))
        return [];
    const candidates = call.media.filter((item) => !call.texts.has(item.key) &&
        call.registry.verdict(call.modelKey, item.fingerprint)?.verdict !== 'accepted');
    return contentRungs(candidates, rejectedKinds(errorMessage ?? ''), error);
}
function contentRungs(candidates, kinds, error) {
    const [primary, secondary] = kinds.map((kind) => candidates.filter((item) => item.kind === kind));
    const steps = [];
    if (primary && primary.length > 0)
        steps.push(primary.slice(-1), primary);
    if (secondary && secondary.length > 0)
        steps.push([...(primary ?? []), ...secondary]);
    const rungs = [];
    const omitted = new Set();
    for (const step of steps) {
        const omit = step.filter((item) => !omitted.has(item.key));
        if (omit.length === 0)
            continue;
        for (const item of omit)
            omitted.add(item.key);
        const together = omitted.size;
        rungs.push({
            omit,
            text: (item) => rejectionText(item, error, together),
            rejection: 'content',
            error,
        });
    }
    return rungs;
}
/** The next resend: none once the ladder is used up or a resend failed for anything but media. */
function nextRung(ladder, retries, errorMessage) {
    if (retries >= MAX_MEDIA_REJECTION_RETRIES)
        return undefined;
    if (retries > 0 && !isMediaRejection(errorMessage))
        return undefined;
    return ladder[retries];
}
function isMediaRejection(errorMessage) {
    return (parseLLMMediaCountLimitMessage(errorMessage) !== undefined ||
        isLLMMediaContentRejectionMessage(errorMessage));
}
/** Media types to leave out, in order. */
function rejectedKinds(message) {
    if (/\bvideo/i.test(message))
        return ['video'];
    if (/\bimage/i.test(message))
        return ['image'];
    if (/\binvalid params?,\s*410\s*\(2013\)/i.test(message))
        return ['image', 'video'];
    return ['video', 'image'];
}
function applyRung(call, rung) {
    call.retriedOmissions.push(rung);
    for (const item of rung.omit)
        call.texts.set(item.key, rung.text(item));
    // A later rung names how many media went out together.
    for (const earlier of call.retriedOmissions) {
        if (earlier === rung || earlier.rejection !== 'content')
            continue;
        for (const item of earlier.omit)
            call.texts.set(item.key, rung.text(item));
    }
}
/** The provider accepted the request: remember what it took and what it did not. */
function settleAcceptedRequest(call, retries, provider) {
    for (const item of call.media) {
        if (!call.texts.has(item.key)) {
            call.registry.record(call.modelKey, item.fingerprint, { verdict: 'accepted' });
        }
    }
    if (retries === 0)
        return;
    for (const rung of call.retriedOmissions) {
        if (rung.countLimit) {
            call.registry.recordCountLimit(call.modelKey, rung.countLimit.kind, rung.countLimit.limit);
            continue;
        }
        for (const item of rung.omit) {
            call.registry.record(call.modelKey, item.fingerprint, {
                verdict: 'rejected',
                error: rung.error,
            });
        }
    }
    logRecovered(call, provider, retries);
}
function notify(observer) {
    try {
        observer?.();
    }
    catch {
        // Observers never change the request.
    }
}
function gatewayErrorSummary(message) {
    const summary = GATEWAY_ERROR_SUMMARY_RE.exec(message ?? '')?.[0];
    return summary === undefined ? 'invalid params (2013)' : summary.replace(/\\(["\\])/g, '$1');
}
function rejectionText(item, error, together) {
    const others = together - 1;
    const what = others === 0
        ? `the model provider rejected the request with "${error}" while this ${item.kind} was in it and accepted the request without it, so the ${item.kind} is likely damaged, incomplete or encoded in a way the provider cannot decode`
        : `the model provider rejected the request with "${error}" while this ${item.kind} and ${others} other attachment${others === 1 ? '' : 's'} were in it and accepted the request without them, so one or more of them is likely damaged, incomplete or encoded in a way the provider cannot decode`;
    return omittedText(item, `${what}. ${stayOutAdvice(item)}`);
}
function rememberedRejectionText(item, error) {
    const how = error ? ` with "${error}"` : '';
    return omittedText(item, `the model provider rejected an earlier request${how} while this ${item.kind} was in it and accepted the request without it, so the ${item.kind} is likely damaged, incomplete or encoded in a way the provider cannot decode. ${stayOutAdvice(item)}`);
}
function stayOutAdvice(item) {
    const example = item.kind === 'video' ? 'an H.264 MP4' : 'a PNG or JPEG';
    return `It is left out of every later request too, including when the same file is read again. If its content is needed, ask the user for a re-exported copy (for example ${example}) and read that`;
}
function overLimitText(item, limit) {
    const reason = `the model provider accepts at most ${limit} ${item.kind}s per request, so only the ${limit} most recent are kept. Read it again if it is still needed`;
    return item.path
        ? `[Earlier ${item.kind} omitted: ${reason}. Original file: ${item.path}]`
        : `[Earlier ${item.kind} omitted: ${reason}.]`;
}
function omittedText(item, reason) {
    return item.path
        ? `[${item.kind} omitted: ${reason}. Original file: ${item.path}]`
        : `[${item.kind} omitted: ${reason}.]`;
}
function countByKind(items) {
    const counts = { video: 0, image: 0 };
    for (const item of items)
        counts[item.kind] += 1;
    return counts;
}
function omittedMedia(call) {
    return call.media.filter((item) => call.texts.has(item.key));
}
function logFields(call, provider) {
    return {
        session_id: call.options.sessionId,
        turn_id: call.options.turnId,
        provider,
        model: call.modelKey,
    };
}
function logRememberedOmissions(call, provider) {
    if (call.texts.size === 0)
        return;
    const counts = countByKind(omittedMedia(call));
    safeLog(() => call.options.logger.warn?.({
        event: 'outbound_rejected_media_omitted',
        ...logFields(call, provider),
        omitted_video_count: counts.video,
        omitted_image_count: counts.image,
    }, '[pi-turn-runner] left provider-bound media out up front, by a rejection or count limit learned before'));
}
function logRetry(call, provider, retryAttempt, rung, errorMessage) {
    const counts = countByKind(omittedMedia(call));
    safeLog(() => call.options.logger.warn?.({
        event: 'llm_media_rejection_retry',
        ...logFields(call, provider),
        retry_attempt: retryAttempt,
        rejection: rung.rejection,
        omitted_video_count: counts.video,
        omitted_image_count: counts.image,
        error: gatewayErrorSummary(errorMessage),
    }, '[pi-turn-runner] provider rejected media the request carried; resending without it'));
}
function logRecovered(call, provider, retries) {
    const counts = countByKind(omittedMedia(call));
    safeLog(() => call.options.logger.warn?.({
        event: 'llm_media_rejection_recovered',
        ...logFields(call, provider),
        retries,
        omitted_video_count: counts.video,
        omitted_image_count: counts.image,
    }, '[pi-turn-runner] provider accepted the request without the media it rejected'));
}
function logUnrecovered(call, provider, retries, errorMessage) {
    safeLog(() => call.options.logger.warn?.({
        event: 'llm_media_rejection_unrecovered',
        ...logFields(call, provider),
        retries,
        error: gatewayErrorSummary(errorMessage),
    }, '[pi-turn-runner] no resend without the rejected media was accepted; ending with the first failure'));
}
function safeLog(write) {
    try {
        write();
    }
    catch {
        // Diagnostics never change the request.
    }
}
//# sourceMappingURL=rejected-media-retry.js.map