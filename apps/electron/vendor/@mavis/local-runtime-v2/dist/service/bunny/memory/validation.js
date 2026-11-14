import { classifyLLMError } from '@mavis/shared/llm-error-classifier';
import { BunnyMemoryFormatError, entryTokens, MAX_MEMORY_TOKENS, normalizeDailyBasis, parseForgotten, parseMemory, sourcesIn, validateFiles, } from './format.js';
import { memoryEntryTooLarge } from '../../coordinator-text/index.js';
// Memory failures and their `bunny.failure` codes.
/**
 * A memory writer broke a rule of the memory files: the recorder changed an existing entry,
 * cited a message that is not new user words, restored a deleted memory, reused an ID, or the
 * consolidator rewrote daily evidence.
 */
export class BunnyMemoryRuleError extends Error {
    constructor(message) {
        super(message);
        this.name = 'BunnyMemoryRuleError';
    }
}
/** One entry alone is over the main memory limit, so no eviction can make room for it. */
class BunnyMemoryEntryTooLargeError extends Error {
    constructor(message) {
        super(message);
        this.name = 'BunnyMemoryEntryTooLargeError';
    }
}
/** The memory changed while a background run worked on its snapshot; the newer change wins. */
export class BunnyMemoryChangedError extends Error {
    constructor() {
        super('Bunny memory changed during processing');
        this.name = 'BunnyMemoryChangedError';
    }
}
/** `.memory-state.json` cannot be read back; a settings save rebuilds it. */
export class BunnyMemoryStateError extends Error {
    constructor(message, cause) {
        super(message, { cause });
        this.name = 'BunnyMemoryStateError';
    }
}
/** A failure carrying its memory code, for `bunny.failure`; the message is the original one. */
class BunnyMemoryFailure extends Error {
    code;
    constructor(code, cause) {
        super(cause instanceof Error ? cause.message : String(cause), { cause });
        this.code = code;
        this.name = 'BunnyMemoryFailure';
    }
}
/** Login the model needs is not there yet: no credentials, or the managed bearer not synced. */
const AUTH_NOT_READY = /login required|no OAuth credentials|OAuth bearer is not synced|api_key not configured/iu;
const FILE_ERROR_CODE = /^E[A-Z]+$/u;
/** A failure of the memory model's run: login not ready, network, or the model call itself. */
export function memoryModelFailure(error) {
    if (error instanceof BunnyMemoryFailure)
        return error;
    const message = error instanceof Error ? error.message : String(error);
    if (AUTH_NOT_READY.test(message))
        return new BunnyMemoryFailure('memory_auth_not_ready', error);
    const reason = classifyLLMError(error);
    if (reason === 'network' || reason === 'timeout')
        return new BunnyMemoryFailure('memory_network', error);
    return new BunnyMemoryFailure('memory_model_error', error);
}
/** Any memory failure with its code where the kind is known; others pass through unchanged. */
export function memoryFailure(error) {
    if (error instanceof BunnyMemoryFailure)
        return error;
    const code = knownCode(error);
    return code ? new BunnyMemoryFailure(code, error) : error;
}
const CODE_BY_CLASS = [
    [BunnyMemoryFormatError, 'memory_format_invalid'],
    [BunnyMemoryRuleError, 'memory_rule_violation'],
    [BunnyMemoryEntryTooLargeError, 'memory_entry_too_large'],
    [BunnyMemoryChangedError, 'memory_changed_during_processing'],
    [BunnyMemoryStateError, 'memory_state_invalid'],
];
function knownCode(error) {
    const known = CODE_BY_CLASS.find(([type]) => error instanceof type);
    if (known)
        return known[1];
    const code = typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : undefined;
    if (typeof code === 'string' && FILE_ERROR_CODE.test(code))
        return 'memory_file_io';
    if (error instanceof Error && error.message === 'Memory symlink rejected')
        return 'memory_file_io';
    return undefined;
}
/**
 * Checks a memory model's files against its rules. `final` adds what only holds once the run is
 * over (a consolidation change needs its change record); the other checks run on every file
 * write too, so the model sees an error where it made it.
 */
export function validateModelChanges(kind, before, after, { batch, final = true } = {}) {
    validateFiles(after);
    const forgotten = parseForgotten(before['forgotten.md'] ?? '');
    const previous = parseMemory(before['MEMORY.md']);
    const entries = parseMemory(after['MEMORY.md']);
    for (const entry of entries) {
        const unchanged = previous.some((old) => old.id === entry.id && old.content === entry.content);
        if (forgotten.some((rule) => rule.content === entry.content ||
            (!unchanged && entry.sources.some((source) => rule.sources.includes(source)))))
            throw new BunnyMemoryRuleError('Forgotten memory cannot be restored');
    }
    assertEntriesFit(previous, entries);
    if (kind === 'capture')
        validateCapture(before, after, batch);
    else
        validateLint(before, after, final);
}
/**
 * A new or changed entry that alone is over the main memory limit is refused: evicting every
 * other entry would still not make room for it. Entries already there are left to eviction.
 */
export function assertEntriesFit(before, after) {
    for (const entry of after) {
        const old = before.find((value) => value.id === entry.id);
        if (old && JSON.stringify(old) === JSON.stringify(entry))
            continue;
        const tokens = entryTokens(entry);
        if (tokens > MAX_MEMORY_TOKENS)
            throw new BunnyMemoryEntryTooLargeError(memoryEntryTooLarge({ id: entry.id, tokens, limit: MAX_MEMORY_TOKENS }));
    }
}
function validateCapture(before, after, batch) {
    const oldEntries = parseMemory(before['MEMORY.md']);
    const entries = parseMemory(after['MEMORY.md']);
    const newSources = new Set(batch.messages
        .filter((message) => !message.processed && message.role === 'user')
        .map((message) => `${message.sessionId}/${message.messageId}`));
    for (const entry of oldEntries)
        if (JSON.stringify(entries.find((value) => value.id === entry.id)) !== JSON.stringify(entry))
            throw new BunnyMemoryRuleError(`Recorder cannot modify existing main memory: ${entry.id} must stay exactly as it was`);
    for (const entry of entries.filter((value) => !oldEntries.some((old) => old.id === value.id)))
        if (entry.basis !== '用户原话' ||
            entry.status !== '待整理' ||
            !entry.sources.every((source) => newSources.has(source)))
            throw new BunnyMemoryRuleError(`Recorder may only add explicit user corrections: ${entry.id} needs basis 用户原话, status 待整理 and sources from new user messages`);
    validateCaptureDaily(before, after, newSources);
}
function validateCaptureDaily(before, after, newSources) {
    for (const [name, text] of Object.entries(before)) {
        if (!name.startsWith('daily/'))
            continue;
        const oldBody = normalizeDailyBasis(text.split('\n## 整理记录')[0].trimEnd());
        const next = after[name];
        if (next !== text && !(next && normalizeDailyBasis(next).startsWith(oldBody)))
            throw new BunnyMemoryRuleError('Recorder cannot rewrite daily history');
    }
    for (const [name, text] of Object.entries(after)) {
        if (!name.startsWith('daily/'))
            continue;
        const added = sourcesIn(text).filter((source) => !sourcesIn(before[name] ?? '').includes(source));
        const cited = added.filter((source) => !newSources.has(source));
        if (cited.length)
            throw new BunnyMemoryRuleError(`Recorder cited a non-user or processed message: ${cited.join(', ')}`);
    }
}
/**
 * The consolidator's rules. The main memory limit is not one of them: a write over it is told to
 * the model, and what is still over at publication leaves oldest first.
 */
function validateLint(before, after, final) {
    if (final) {
        const changed = Object.keys(after).some((name) => name !== 'forgotten.md' && before[name] !== after[name]);
        const logged = Object.entries(after).some(([name, text]) => name.startsWith('daily/') && text.includes('## 整理记录') && text !== before[name]);
        if (changed && !logged)
            throw new BunnyMemoryRuleError('Lint changes require a daily change record');
    }
    // Daily evidence is immutable. Lint can change status and append new observations/logs.
    for (const [name, text] of Object.entries(before)) {
        if (!name.startsWith('daily/'))
            continue;
        for (const record of dailyBodies(text))
            if (!dailyBodies(after[name] ?? '').includes(record))
                throw new BunnyMemoryRuleError('Lint cannot rewrite daily evidence');
    }
}
function dailyBodies(text) {
    return normalizeDailyBasis(text)
        .split(/(?=^- \[d-)/mu)
        .slice(1)
        .map((block) => block
        .split('\n## 整理记录')[0]
        .replace(/^(- \[d-\d{4}-\d+\] (?:画像|倾向|做法|去处) · (?:用户原话|用户确认|AI 推断)) · [^\n]+/u, '$1')
        .trim());
}
//# sourceMappingURL=validation.js.map