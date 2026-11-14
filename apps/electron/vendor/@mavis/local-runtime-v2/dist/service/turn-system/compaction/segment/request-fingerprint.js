import { createHash } from 'node:crypto';
/** Payload keys that carry thinking or effort settings, by protocol. */
const THINKING_KEYS = ['thinking', 'output_config', 'reasoning', 'reasoning_effort'];
/** Chat-style protocols open their message list with the system prompt. */
const SYSTEM_ROLES = new Set(['system', 'developer']);
/**
 * Digests of a provider payload's sections. Cache breakpoints are markers, not
 * content: `cache_control` is left out, so moving the breakpoint to the new
 * last message does not read as a difference. Undefined when the payload
 * cannot be read.
 */
export function fingerprintRequest(payload) {
    try {
        return sectionDigests(payload);
    }
    catch {
        // A diagnostic never changes the request it describes.
        return undefined;
    }
}
function sectionDigests(payload) {
    const body = isRecord(payload) ? payload : {};
    const listed = messageList(body);
    const separate = body.system ?? body.instructions;
    const leading = listed.findIndex((message) => !isSystemMessage(message));
    // Without a separate system prompt, the leading system messages are it.
    const systemCount = separate !== undefined || leading < 0 ? 0 : leading;
    return {
        systemPrompt: digest(separate ?? listed.slice(0, systemCount)),
        tools: digest(body.tools ?? []),
        thinking: digest(Object.fromEntries(THINKING_KEYS.map((key) => [key, body[key] ?? null]))),
        messages: listed.slice(systemCount).map(digest),
    };
}
/** `messages` in chat-style and Messages protocol bodies, `input` in responses-style ones. */
function messageList(body) {
    if (Array.isArray(body.messages))
        return body.messages;
    return Array.isArray(body.input) ? body.input : [];
}
/** The first section of `compaction` that differs from `main`; messages are compared in order. */
export function firstRequestDifference(main, compaction) {
    if (!main)
        return { section: 'main_request_unknown' };
    if (main.systemPrompt !== compaction.systemPrompt)
        return { section: 'system_prompt' };
    if (main.tools !== compaction.tools)
        return { section: 'tools' };
    if (main.thinking !== compaction.thinking)
        return { section: 'thinking' };
    const mainMessageCount = main.messages.length;
    const shorter = Math.min(mainMessageCount, compaction.messages.length);
    let index = 0;
    while (index < shorter && main.messages[index] === compaction.messages[index])
        index += 1;
    if (index === mainMessageCount && index === compaction.messages.length) {
        return { section: 'identical', mainMessageCount };
    }
    return { section: 'messages', messageIndex: index, mainMessageCount };
}
function isSystemMessage(message) {
    return isRecord(message) && typeof message.role === 'string' && SYSTEM_ROLES.has(message.role);
}
function digest(value) {
    return createHash('sha256').update(canonicalJson(value)).digest('hex').slice(0, 32);
}
/** JSON with sorted keys and without `cache_control`, so equal content digests equally. */
function canonicalJson(value) {
    return JSON.stringify(value, (key, item) => {
        if (!isRecord(item))
            return item;
        return Object.fromEntries(Object.keys(item)
            .filter((name) => name !== 'cache_control')
            .sort()
            .map((name) => [name, item[name]]));
    });
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=request-fingerprint.js.map