import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import { SEARCH_ERROR, searchDateInvalid } from '../../coordinator-text/index.js';
import { backfillMessageSearchBatch, clearMessageSearchIndex, currentMainSessionId, defaultSearchTokenizer, isSearchIndexedSession, purgeMessageSearchOutside, readMessageContext, syncMessageSearchIndex, searchMessages, } from '../../session-system/index.js';
import { precheckConversation } from './precheck.js';
/** @internal Exported only for focused tests. */
export class ConversationSearchScopeError extends Error {
    name = 'ConversationSearchScopeError';
    constructor() {
        super(SEARCH_ERROR.scope);
    }
}
/**
 * Original-text retrieval over Bunny's current main conversation (spec 15): the tools'
 * search and read, the runtime pre-check, the background backfill and the reset clear.
 */
export class BunnyConversationSearch {
    options;
    tokenizer;
    backfill;
    /**
     * Per session, the display message IDs of the user message the runtime pre-checked
     * last: the one a search in this Turn is answering, which is already indexed and
     * would otherwise come back as its own newest, best-matching hit (15.5).
     */
    askedMessageIds = new Map();
    closed = false;
    constructor(options) {
        this.options = options;
        this.tokenizer = options.tokenizer ?? defaultSearchTokenizer();
    }
    isMainSession(sessionId) {
        return isSearchIndexedSession(this.options.db, sessionId);
    }
    /**
     * `inTurn: false` is a search outside any Turn (the memory consolidator): no message is
     * being answered, so the last pre-checked one is not left out.
     */
    search(sessionId, args, options = {}) {
        this.requireMain(sessionId);
        const asked = options.inTurn === false ? [] : (this.askedMessageIds.get(sessionId) ?? []);
        return searchMessages(this.options.db, {
            sessionId,
            query: args.query,
            ...(asked.length > 0 ? { excludeMessageIds: asked } : {}),
            ...(args.cursor ? { cursor: args.cursor } : {}),
            ...optionalTime('since', args.since, false),
            ...optionalTime('until', args.until, true),
            ...(args.role ? { role: args.role } : {}),
            ...(args.taskId ? { taskId: args.taskId } : {}),
            ...(args.spaceId ? { spaceId: args.spaceId } : {}),
            nowMs: this.options.nowMs(),
            tokenizer: this.tokenizer,
            ...(this.options.spaces ? { spaces: this.options.spaces } : {}),
        });
    }
    read(sessionId, args) {
        this.requireMain(sessionId);
        return readMessageContext(this.options.db, {
            sessionId,
            messageId: args.messageId,
            ...(args.around !== undefined ? { around: args.around } : {}),
            ...(args.offset !== undefined ? { offset: args.offset } : {}),
            ...(this.options.descriptions ? { descriptions: this.options.descriptions } : {}),
        });
    }
    /**
     * Pre-check of one arriving user message; never throws. Outside the main
     * conversation (forks, task sessions) it finds nothing.
     */
    precheck(input) {
        try {
            if (!this.isMainSession(input.sessionId))
                return noPointers();
        }
        catch {
            return { ...noPointers(), trace: { ...noPointers().trace, failed: true } };
        }
        if (input.currentMessageIds?.length) {
            this.askedMessageIds.set(input.sessionId, [...input.currentMessageIds]);
        }
        return precheckConversation(this.options.db, input, this.tokenizer);
    }
    /** Whether Bunny has a current main conversation, i.e. the user has entered Bunny. */
    hasMainConversation() {
        return this.currentMainSessionId() !== undefined;
    }
    /** Bunny's current main conversation, the one search and read cover. */
    currentMainSessionId() {
        return currentMainSessionId(this.options.db);
    }
    /** Starts the background backfill once; it never blocks startup or turn assembly. */
    startBackfill() {
        this.backfill ??= this.runBackfill();
    }
    /** Settles when the started backfill has finished or stopped; for tests and shutdown. */
    async backfillSettled() {
        await this.backfill;
    }
    /**
     * Re-indexes messages whose attachment descriptions were just written, so the
     * attachment lines carry the description instead of the file name (12.6).
     */
    indexMessages(sessionId, messageIds) {
        for (const messageId of new Set(messageIds)) {
            syncMessageSearchIndex(this.options.db, sessionId, messageId, {
                tokenizer: this.tokenizer,
                nowMs: this.options.nowMs,
                ...this.indexSources(),
            });
        }
    }
    /** Bunny initialization empties the index (spec 2.3). */
    clear() {
        clearMessageSearchIndex(this.options.db);
    }
    async close() {
        this.closed = true;
        await this.backfill;
    }
    indexSources() {
        return {
            ...(this.options.descriptions ? { descriptions: this.options.descriptions } : {}),
            ...(this.options.spaces ? { spaces: this.options.spaces } : {}),
        };
    }
    requireMain(sessionId) {
        if (!this.isMainSession(sessionId))
            throw new ConversationSearchScopeError();
    }
    async runBackfill() {
        const pause = this.options.betweenBatches ?? (() => yieldToEventLoop());
        try {
            await pause();
            const db = this.options.db;
            const main = currentMainSessionId(db);
            while (!this.closed && purgeMessageSearchOutside(db, main) > 0)
                await pause();
            while (main && !this.closed) {
                const result = backfillMessageSearchBatch(db, main, {
                    tokenizer: this.tokenizer,
                    nowMs: this.options.nowMs,
                    ...this.indexSources(),
                    ...(this.options.backfillBatchSize ? { batchSize: this.options.backfillBatchSize } : {}),
                });
                if (result.done)
                    return;
                await pause();
            }
        }
        catch (error) {
            this.options.warn?.(error);
        }
    }
}
function noPointers() {
    return {
        pointers: [],
        trace: { extractedTerms: 0, rareTerms: 0, trusted: false, pointers: 0 },
    };
}
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/u;
/** `YYYY-MM-DD` is a local day (its start, or its end for `until`); anything else is ISO. */
function optionalTime(key, value, endOfDay) {
    if (!value?.trim())
        return {};
    const date = DATE_ONLY.exec(value.trim());
    const ms = date
        ? new Date(Number(date[1]), Number(date[2]) - 1, Number(date[3]) + (endOfDay ? 1 : 0)).getTime() - (endOfDay ? 1 : 0)
        : Date.parse(value);
    if (!Number.isFinite(ms))
        throw new Error(searchDateInvalid(key));
    return { [key]: ms };
}
//# sourceMappingURL=conversation-search.service.js.map