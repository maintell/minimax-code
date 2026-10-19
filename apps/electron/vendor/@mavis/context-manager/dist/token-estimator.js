/**
 * Token estimation for {@link ContextLifecycleManager}.
 *
 * Why this exists
 * ---------------
 * pi-agent-core's `estimateTokens` / `estimateContextTokens` use `Math.ceil(chars / 4)`,
 * which severely under-counts CJK text — Chinese characters consume 1–2 BPE tokens each,
 * so chars/4 (≈0.25 tokens/char) under-reports by 4–8×. Under-reporting moves the
 * compaction trigger to the right, past the point at which Messages-compatible
 * providers reject the request (e.g. minimax's MiniMax-M2.7: rejects when
 * input > contextWindow - max_tokens).
 *
 * Pluggable interface
 * -------------------
 * {@link TokenEstimator} is the seam we own at the cloud-runtime layer.
 * {@link ContextLifecycleManager.evaluateTrigger} and selectFirstKeptIndex both
 * route through it. A future `count_tokens`-API-backed estimator can drop in
 * via constructor injection without touching manager logic.
 *
 * Ground-truth-aware estimate
 * ---------------------------
 * `estimateContextTokens` preserves pi-agent-core's good pattern:
 *  1. Find the last successful assistant message with usage for the current context;
 *  2. Trust its provider-reported total as the prefix sum;
 *  3. Estimate only the trailing messages after that point.
 * This bounds estimator error to the trailing window — typically a handful of
 * messages — rather than the entire conversation.
 *
 * Default implementation
 * ----------------------
 * {@link BpeTokenEstimator} uses gpt-tokenizer's `o200k_base` (GPT-4o BPE) for
 * bounded word runs and a UTF-8 byte upper bound for oversized word runs or
 * tokenizer failures. o200k_base is not the provider tokenizer, but for MiniMax /
 * Messages-compatible endpoints it consistently over-estimates a touch (safe:
 * earlier trigger), which is the direction we want when capacity
 * miscalculation means a hard 4xx.
 *
 * Per-message structural overhead (4 tokens) accounts for role wrappers and
 * delimiters the provider injects around each turn — exact count varies by API
 * (Messages-compatible API vs. OpenAI ChatCompletions), but 4 is in the right
 * ballpark and again biased to over-estimate.
 *
 * Visual content (`image` and legacy/raw `video` blocks) is charged 4_800
 * tokens to match pi-agent-core's image stand-in; real visual-token counts
 * depend on media dimensions and the active provider.
 */
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { countTokens as countO200kBase } from 'gpt-tokenizer/model/gpt-4o';
/** Per-message structural overhead (role wrapper + delimiters). */
const MESSAGE_STRUCTURAL_OVERHEAD = 4;
/** Stand-in token count for an image or legacy/raw video block. */
const VISUAL_TOKEN_STAND_IN = 4_800;
const MAX_EXACT_TOKENIZER_CHARS = 4_096;
const UNICODE_LETTER_OR_NUMBER = /[\p{L}\p{N}]/u;
function hasOversizedAlphanumericRun(text) {
    let runLength = 0;
    for (const character of text) {
        const codePoint = character.codePointAt(0) ?? 0;
        const isLetterOrNumber = codePoint <= 0x7f
            ? (codePoint >= 0x30 && codePoint <= 0x39) ||
                (codePoint >= 0x41 && codePoint <= 0x5a) ||
                (codePoint >= 0x61 && codePoint <= 0x7a)
            : UNICODE_LETTER_OR_NUMBER.test(character);
        if (!isLetterOrNumber) {
            runLength = 0;
            continue;
        }
        runLength += 1;
        if (runLength > MAX_EXACT_TOKENIZER_CHARS)
            return true;
    }
    return false;
}
function estimateTextTokensUpperBound(text) {
    return Buffer.byteLength(text, 'utf8');
}
function safeJsonStringify(value) {
    try {
        return JSON.stringify(value) ?? 'undefined';
    }
    catch {
        return '[unserializable]';
    }
}
function isVisualContentBlock(block) {
    return block.type === 'image' || block.type === 'video';
}
function calculateContextTokens(usage) {
    return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}
function getAssistantUsage(message) {
    if (message.role !== 'assistant')
        return undefined;
    const m = message;
    if (m.stopReason === 'aborted' || m.stopReason === 'error')
        return undefined;
    return m.usage;
}
function getLastAssistantUsageInfo(messages) {
    let firstFreshIndex = 0;
    let compactedAt;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        if (messages[i].role !== 'compactionSummary')
            continue;
        const summary = messages[i];
        const keptCount = summary.keptMessageCount;
        if (keptCount !== undefined) {
            // Kept assistants appear AFTER the summary too. Only appended responses
            // describe the replacement context; their wall-clock timestamps may tie
            // or precede the summary if the clock changed.
            if (!Number.isSafeInteger(keptCount) || keptCount < 0)
                return undefined;
            firstFreshIndex = i + 1 + keptCount;
        }
        else {
            // Legacy persisted transcripts have no explicit retained-tail boundary.
            // Match the local runtime's conservative timestamp freshness rule.
            if (!Number.isFinite(summary.timestamp))
                return undefined;
            compactedAt = summary.timestamp;
            firstFreshIndex = i + 1;
        }
        break;
    }
    for (let i = messages.length - 1; i >= firstFreshIndex; i -= 1) {
        const message = messages[i];
        if (compactedAt !== undefined &&
            (!Number.isFinite(message.timestamp) || message.timestamp <= compactedAt)) {
            continue;
        }
        const usage = getAssistantUsage(message);
        if (usage)
            return { usage, index: i };
    }
    return undefined;
}
const MAX_INLINE_CACHE_KEY_UNITS = 256;
const MAX_CACHED_TEXT_ENTRIES = 2_048;
export class BpeTokenEstimator {
    countExactTokens;
    // Bounded content keys survive detached histories without retaining long
    // message bodies. Hash UTF-16 units so lone surrogates stay distinct.
    textTokens = new Map();
    /**
     * @param encoder Override the default o200k_base tokenizer. Tests inject
     * deterministic encoders (e.g. `text => text.split(' ')`); production passes
     * no argument so the default GPT-4o BPE token counter is used.
     *
     * The default wraps gpt-tokenizer with `allowedSpecial: 'all'`. Without it,
     * gpt-tokenizer defaults to `disallowedSpecial: 'all'` and THROWS on any
     * special-token literal (e.g. `<|endoftext|>`) appearing in transcript text.
     * Since this estimator runs inside the fail-closed `beforeLlmCall` checkpoint,
     * such a throw would abort the whole turn. We only count tokens, so treating
     * special-token literals as ordinary text is correct here.
     */
    constructor(encoder) {
        this.countExactTokens = encoder
            ? (text) => encoder(text).length
            : (text) => countO200kBase(text, { allowedSpecial: 'all' });
    }
    estimateTextTokens(text) {
        if (!text)
            return 0;
        const key = text.length <= MAX_INLINE_CACHE_KEY_UNITS
            ? `text:${text}`
            : `sha256:${createHash('sha256').update(text, 'utf16le').digest('hex')}`;
        const cached = this.textTokens.get(key);
        if (cached !== undefined) {
            this.textTokens.delete(key);
            this.textTokens.set(key, cached);
            return cached;
        }
        try {
            if (text.length > MAX_EXACT_TOKENIZER_CHARS && hasOversizedAlphanumericRun(text)) {
                return estimateTextTokensUpperBound(text);
            }
            const tokens = this.countExactTokens(text);
            if (!Number.isFinite(tokens) || tokens < 0)
                return estimateTextTokensUpperBound(text);
            if (this.textTokens.size >= MAX_CACHED_TEXT_ENTRIES) {
                const oldest = this.textTokens.keys().next().value;
                if (oldest !== undefined)
                    this.textTokens.delete(oldest);
            }
            this.textTokens.set(key, tokens);
            return tokens;
        }
        catch {
            return estimateTextTokensUpperBound(text);
        }
    }
    estimateVisualTokens() {
        return VISUAL_TOKEN_STAND_IN;
    }
    estimateMessage(message) {
        let tokens = MESSAGE_STRUCTURAL_OVERHEAD;
        switch (message.role) {
            case 'user': {
                const content = message.content;
                if (typeof content === 'string') {
                    tokens += this.estimateTextTokens(content);
                }
                else if (Array.isArray(content)) {
                    for (const block of content) {
                        if (block.type === 'text' && block.text) {
                            tokens += this.estimateTextTokens(block.text);
                        }
                        else if (isVisualContentBlock(block)) {
                            tokens += this.estimateVisualTokens();
                        }
                    }
                }
                return tokens;
            }
            case 'assistant': {
                const assistant = message;
                for (const block of assistant.content) {
                    if (block.type === 'text') {
                        tokens += this.estimateTextTokens(block.text);
                    }
                    else if (block.type === 'thinking') {
                        tokens += this.estimateTextTokens(block.thinking);
                    }
                    else if (block.type === 'toolCall') {
                        tokens += this.estimateTextTokens(block.name);
                        tokens += this.estimateTextTokens(safeJsonStringify(block.arguments));
                    }
                }
                return tokens;
            }
            case 'toolResult':
            case 'custom': {
                const content = message.content;
                if (typeof content === 'string') {
                    tokens += this.estimateTextTokens(content);
                }
                else if (Array.isArray(content)) {
                    for (const block of content) {
                        if (block.type === 'text' && typeof block.text === 'string') {
                            tokens += this.estimateTextTokens(block.text);
                        }
                        else if (isVisualContentBlock(block)) {
                            tokens += this.estimateVisualTokens();
                        }
                    }
                }
                return tokens;
            }
            case 'bashExecution': {
                const m = message;
                tokens += this.estimateTextTokens(m.command ?? '');
                tokens += this.estimateTextTokens(m.output ?? '');
                return tokens;
            }
            case 'branchSummary':
            case 'compactionSummary': {
                const m = message;
                tokens += this.estimateTextTokens(m.summary ?? '');
                return tokens;
            }
        }
        return tokens;
    }
    estimateMessages(messages) {
        let total = 0;
        for (const message of messages) {
            total += this.estimateMessage(message);
        }
        return total;
    }
    estimateContextTokens(messages) {
        const info = getLastAssistantUsageInfo(messages);
        if (!info) {
            const trailing = this.estimateMessages(messages);
            return {
                tokens: trailing,
                usageTokens: 0,
                trailingTokens: trailing,
                lastUsageIndex: null,
            };
        }
        const usageTokens = calculateContextTokens(info.usage);
        let trailingTokens = 0;
        for (let i = info.index + 1; i < messages.length; i += 1) {
            trailingTokens += this.estimateMessage(messages[i]);
        }
        return {
            tokens: usageTokens + trailingTokens,
            usageTokens,
            trailingTokens,
            lastUsageIndex: info.index,
        };
    }
}
/**
 * Default factory — single shared {@link BpeTokenEstimator} instance reusing
 * the module-loaded token counter.
 */
let defaultInstance;
export function createDefaultTokenEstimator() {
    defaultInstance ??= new BpeTokenEstimator();
    return defaultInstance;
}
export function createDefaultContextTokenEstimator() {
    return createDefaultTokenEstimator();
}
//# sourceMappingURL=token-estimator.js.map