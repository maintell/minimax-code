import { sealHash } from './pool-state.js';
/**
 * Sealed reasoning another account wrote. Only a pool member's own fetch applies it, before any output: a refused seal is left out and
 * the same physical request is sent once more; what the member sealed itself is kept.
 */
const FOREIGN_REASONING = /invalid_encrypted_content|encrypted[ _]content.{0,80}could not be (verified|decrypted)|could not (decrypt|verify).{0,40}encrypted[ _]content/i;
const FOREIGN_SIGNATURE = /invalid.{0,40}signature|signature.{0,60}(invalid|could not be verified|verification failed|does not match)/i;
const RESPONSES_APIS = new Set([
    'openai-responses',
    'openai-codex-responses',
    'azure-openai-responses',
]);
const MESSAGES_APIS = new Set(['anthropic-messages']);
const COMPACTION_KINDS = new Set(['compaction', 'compaction_summary']);
const MAX_ERROR_BYTES = 64 * 1024;
export class ModelAccessFailoverError extends Error {
    code;
    reason;
    retryAt;
    constructor(code, reason, 
    /** Unix ms when the earliest member may serve again. */
    retryAt) {
        super(code === 'failover_unavailable'
            ? `failover_unavailable: no account in the pool can take this call (${reason ?? 'unavailable'}${retryAt ? `, earliest at ${new Date(retryAt).toISOString()}` : ''})`
            : 'failover_foreign_compaction: sealed compaction written by another account cannot be sent');
        this.code = code;
        this.reason = reason;
        this.retryAt = retryAt;
        this.name = 'ModelAccessFailoverError';
    }
}
function record(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}
function parse(body) {
    if (typeof body !== 'string')
        return undefined;
    try {
        return record(JSON.parse(body));
    }
    catch {
        return undefined;
    }
}
function sealOf(item) {
    const value = record(item)?.encrypted_content;
    return typeof value === 'string' && value ? value : undefined;
}
function signatureOf(block) {
    const item = record(block);
    if (item?.type === 'thinking' && typeof item.signature === 'string' && item.signature)
        return item.signature;
    if (item?.type === 'redacted_thinking' && typeof item.data === 'string' && item.data)
        return item.data;
    return undefined;
}
/** Responses input without the items `drop` selects; undefined when nothing was dropped. */
function withoutItems(body, drop) {
    if (!Array.isArray(body.input))
        return undefined;
    const kept = body.input.filter((item) => !(record(item) && drop(item)));
    return kept.length === body.input.length ? undefined : { ...body, input: kept };
}
/** Messages API messages without the thinking blocks `drop` selects (emptied messages go too). */
function withoutThinking(body, drop) {
    if (!Array.isArray(body.messages))
        return undefined;
    let changed = false;
    const messages = [];
    for (const message of body.messages) {
        const item = record(message);
        if (!item || !Array.isArray(item.content)) {
            messages.push(message);
            continue;
        }
        const content = item.content.filter((block) => !drop(block));
        if (content.length === item.content.length) {
            messages.push(message);
            continue;
        }
        changed = true;
        if (content.length > 0)
            messages.push({ ...item, content });
    }
    return changed ? { ...body, messages } : undefined;
}
async function boundedText(response) {
    const reader = response.body?.getReader();
    if (!reader)
        return '';
    const decoder = new TextDecoder();
    let size = 0;
    let text = '';
    try {
        for (;;) {
            const chunk = await reader.read();
            if (chunk.done)
                break;
            size += chunk.value.byteLength;
            if (size > MAX_ERROR_BYTES) {
                await abandon(reader);
                break;
            }
            text += decoder.decode(chunk.value, { stream: true });
        }
    }
    finally {
        reader.releaseLock();
    }
    return text + decoder.decode();
}
async function abandon(reader) {
    try {
        await reader.cancel();
    }
    catch {
        /* The error body is abandoned either way. */
    }
}
function replay(response, text) {
    return new Response(text, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
    });
}
/** Only a string body given beside the URL is read; a Request's own stream passes untouched. */
function bodyOf(input, init) {
    return input instanceof Request ? undefined : init?.body;
}
/**
 * The member's fetch in pool mode. Non-JSON bodies, other APIs and successful replies pass
 * through untouched; an error body is read (bounded) only to tell a refused seal.
 */
export function sealedFetch(input) {
    const responses = RESPONSES_APIS.has(input.api);
    const messages = MESSAGES_APIS.has(input.api);
    if (!responses && !messages)
        return input.fetch;
    const send = (url, init, body) => input.fetch(url, { ...init, body: JSON.stringify(body) });
    return (async (url, init) => {
        const body = parse(bodyOf(url, init));
        if (!body)
            return input.fetch(url, init);
        const request = responses ? responsesRequest(input, body) : messagesRequest(input, body);
        const first = request === body ? await input.fetch(url, init) : await send(url, init, request);
        if (first.ok)
            return first;
        const text = await boundedText(first);
        const retried = responses
            ? FOREIGN_REASONING.test(text) && withoutReasoningFor(input, request)
            : FOREIGN_SIGNATURE.test(text) && withoutThinkingFor(input, request);
        return retried ? send(url, init, retried) : replay(first, text);
    });
}
/** Leaves out what this member refused before; fails closed on a foreign sealed compaction. */
function responsesRequest(input, body) {
    const sealedCompaction = Array.isArray(body.input) &&
        body.input.some((item) => COMPACTION_KINDS.has(String(record(item)?.type)) && !!sealOf(item));
    if (sealedCompaction &&
        input.state.servedByOther(input.sessionId, input.primaryKey, input.member)) {
        const error = new ModelAccessFailoverError('failover_foreign_compaction');
        input.onFatal(error);
        throw error;
    }
    const refused = input.state.refusedSeals(input.sessionId, input.member);
    if (refused.size === 0)
        return body;
    return (withoutItems(body, (item) => {
        const seal = sealOf(item);
        return !!seal && refused.has(sealHash(seal));
    }) ?? body);
}
function messagesRequest(input, body) {
    const refused = input.state.refusedSeals(input.sessionId, input.member);
    if (refused.size === 0)
        return body;
    return (withoutThinking(body, (block) => {
        const seal = signatureOf(block);
        return !!seal && refused.has(sealHash(seal));
    }) ?? body);
}
/** The request without any sealed reasoning; what was left out is remembered for the session. */
function withoutReasoningFor(input, request) {
    const seals = [];
    const retried = withoutItems(request, (item) => {
        const seal = item.type === 'reasoning' ? sealOf(item) : undefined;
        if (seal)
            seals.push(sealHash(seal));
        return !!seal;
    });
    if (retried)
        input.state.addRefusedSeals(input.sessionId, input.member, seals);
    return retried;
}
function withoutThinkingFor(input, request) {
    const seals = [];
    const retried = withoutThinking(request, (block) => {
        const seal = signatureOf(block);
        if (seal)
            seals.push(sealHash(seal));
        const type = record(block)?.type;
        return type === 'thinking' || type === 'redacted_thinking';
    });
    if (retried)
        input.state.addRefusedSeals(input.sessionId, input.member, seals);
    return retried;
}
//# sourceMappingURL=sealed-content.js.map