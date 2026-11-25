import { createHash } from 'node:crypto';
function createContextUsageAnchorKey(input) {
    const context = JSON.stringify({ systemPrompt: input.systemPrompt ?? '', tools: input.tools ?? [] }, sortKeys);
    if (context === undefined)
        throw new TypeError('Context usage anchor input is not serializable.');
    const key = {
        scope: input.scope,
        provider: input.provider,
        api: input.api,
        model: input.model,
        contextFingerprint: createHash('sha256').update(context).digest('hex'),
    };
    if (!isValidKey(key))
        throw new TypeError('Context usage anchor key is invalid.');
    return key;
}
/** Sessions remembered per harness instance; the least recently observed one is dropped first. */
const MAX_TRACKED_SESSIONS = 512;
/** Process-local trigger optimization. A miss always falls back to a full local footprint. */
export class ContextUsageAnchorState {
    anchorsByScope = new Map();
    epochsByScope = new Map();
    keysByScope = new Map();
    bind(input) {
        const key = createContextUsageAnchorKey(input);
        this.keysByScope.set(key.scope, key);
        this.touch(key.scope);
        return {
            state: this,
            key,
            historyEpoch: this.epochsByScope.get(key.scope) ?? 0,
        };
    }
    recordBound(scope, messages) {
        const key = this.keysByScope.get(scope);
        if (!key)
            return false;
        const historyEpoch = this.epochsByScope.get(scope) ?? 0;
        for (let index = messages.length - 1; index >= 0; index -= 1) {
            const assistant = messages[index];
            if (isAssistantMessage(assistant) && this.record({ key, historyEpoch, assistant }))
                return true;
        }
        return false;
    }
    advanceHistory(scope) {
        this.epochsByScope.set(scope, (this.epochsByScope.get(scope) ?? 0) + 1);
        this.touch(scope);
    }
    invalidate(scope) {
        this.anchorsByScope.delete(scope);
    }
    /** Drops the scope's binding, history epoch and anchor; a deleted Session has no next Turn. */
    reset(scope) {
        this.anchorsByScope.delete(scope);
        this.epochsByScope.delete(scope);
        this.keysByScope.delete(scope);
    }
    record(input) {
        const absoluteTokens = readAbsoluteTokens(input.assistant);
        const assistantIdentity = identifyAssistant(input.assistant);
        if (!isValidKey(input.key) ||
            !Number.isSafeInteger(input.historyEpoch) ||
            input.historyEpoch < 0 ||
            !assistantMatchesKey(input.assistant, input.key) ||
            absoluteTokens === undefined ||
            assistantIdentity === undefined) {
            return false;
        }
        this.anchorsByScope.set(input.key.scope, {
            key: { ...input.key },
            historyEpoch: input.historyEpoch,
            assistantIdentity,
            absoluteTokens,
        });
        this.touch(input.key.scope);
        return true;
    }
    resolve(input) {
        const anchor = this.anchorsByScope.get(input.key.scope);
        if (!anchor || anchor.historyEpoch !== input.historyEpoch || !sameKey(anchor.key, input.key)) {
            return undefined;
        }
        let anchoredIndex = -1;
        for (let index = 0; index < input.messages.length; index += 1) {
            const message = input.messages[index];
            if (!message || identifyAssistant(message) !== anchor.assistantIdentity)
                continue;
            if (anchoredIndex !== -1)
                return undefined;
            anchoredIndex = index;
        }
        if (anchoredIndex === -1)
            return undefined;
        const anchoredMessage = input.messages[anchoredIndex];
        if (!matchesAnchorUsage(anchoredMessage, anchor))
            return undefined;
        return {
            absoluteTokens: anchor.absoluteTokens,
            anchoredMessage,
            trailingMessages: input.messages.slice(anchoredIndex + 1),
        };
    }
    /** Every tracked scope has an epoch entry; their insertion order is the recency order. */
    touch(scope) {
        const epoch = this.epochsByScope.get(scope) ?? 0;
        this.epochsByScope.delete(scope);
        this.epochsByScope.set(scope, epoch);
        this.evictOldest();
    }
    evictOldest() {
        while (this.epochsByScope.size > MAX_TRACKED_SESSIONS) {
            const oldest = this.epochsByScope.keys().next();
            if (oldest.done)
                return;
            this.reset(oldest.value);
        }
    }
}
/** JSON fingerprints map non-finite numbers to null, so matching also checks raw usage. */
function matchesAnchorUsage(message, anchor) {
    return message !== undefined && readAbsoluteTokens(message) === anchor.absoluteTokens;
}
function isAssistantMessage(value) {
    return (typeof value === 'object' &&
        value !== null &&
        !Array.isArray(value) &&
        Reflect.get(value, 'role') === 'assistant');
}
function isValidKey(key) {
    return [key.scope, key.provider, key.api, key.model, key.contextFingerprint].every((value) => typeof value === 'string' && value.length > 0);
}
function sameKey(left, right) {
    return (left.scope === right.scope &&
        left.provider === right.provider &&
        left.api === right.api &&
        left.model === right.model &&
        left.contextFingerprint === right.contextFingerprint);
}
function assistantMatchesKey(message, key) {
    return (message.role === 'assistant' &&
        message.provider === key.provider &&
        message.api === key.api &&
        message.model === key.model);
}
function readAbsoluteTokens(message) {
    if (message.role !== 'assistant')
        return undefined;
    if (message.stopReason === 'error' || message.stopReason === 'aborted')
        return undefined;
    const usage = readUsage(message);
    if (!usage)
        return undefined;
    const absoluteTokens = usage.contextTokens !== undefined
        ? readContextPromptTokens(usage)
        : readDirectPromptTokens(usage);
    return absoluteTokens !== undefined && Number.isSafeInteger(absoluteTokens) && absoluteTokens > 0
        ? absoluteTokens
        : undefined;
}
/**
 * Multi-hop continuation accumulates input/cacheRead across hops while contextTokens
 * records the single-turn total (single-turn prompt + output). Subtract output so the
 * anchor stays a prompt-only baseline matching {@link readDirectPromptTokens}.
 */
function readContextPromptTokens(usage) {
    const contextTokens = readUsageNumber(usage.contextTokens);
    if (!isNonNegativeSafeInteger(contextTokens))
        return undefined;
    if (contextTokens === 0)
        return readDirectPromptTokens(usage);
    const output = readUsageNumber(usage.output);
    return isNonNegativeSafeInteger(output) ? contextTokens - output : undefined;
}
function readDirectPromptTokens(usage) {
    // Only the three fields that actually make up absoluteTokens are validated. The gate
    // must not depend on output billing: hidden reasoning may not be replayed, and
    // missing or malformed output does not invalidate an otherwise measured prompt.
    const input = readUsageNumber(usage.input);
    const cacheRead = readUsageNumber(usage.cacheRead);
    const cacheWrite = readUsageNumber(usage.cacheWrite);
    if (!isNonNegativeSafeInteger(input) ||
        !isNonNegativeSafeInteger(cacheRead) ||
        !isNonNegativeSafeInteger(cacheWrite)) {
        return undefined;
    }
    // Prompt tokens only: input + cacheRead + cacheWrite, the same quantity the
    // context-usage donut reports. The response and trailing messages are estimated
    // separately from the content actually replayed, never from usage.output.
    return input + cacheRead + cacheWrite;
}
/** A persisted assistant can predate usage entirely; read it without throwing. */
function readUsage(message) {
    const usage = message.usage;
    if (!usage || typeof usage !== 'object' || Array.isArray(usage))
        return undefined;
    return usage;
}
/** Narrow an unvalidated usage field to a number. Absent and non-numeric stay undefined. */
function readUsageNumber(value) {
    return typeof value === 'number' ? value : undefined;
}
function isNonNegativeSafeInteger(value) {
    return value !== undefined && Number.isSafeInteger(value) && value >= 0;
}
/**
 * Prefer the provider ID; providers without one retain a content-and-usage fingerprint.
 * Rewrites invalidate that fallback instead of silently reusing stale measurements.
 */
function identifyAssistant(message) {
    if (message.role !== 'assistant')
        return undefined;
    if (typeof message.responseId === 'string' && message.responseId.length > 0) {
        return `response:${message.provider}:${message.api}:${message.model}:${message.responseId}`;
    }
    try {
        const serialized = JSON.stringify({
            api: message.api,
            provider: message.provider,
            model: message.model,
            timestamp: message.timestamp,
            content: message.content,
            usage: message.usage,
            stopReason: message.stopReason,
        });
        return `message:${createHash('sha256').update(serialized).digest('hex')}`;
    }
    catch {
        return undefined;
    }
}
function sortKeys(_key, value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return value;
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
}
//# sourceMappingURL=usage-anchor.js.map