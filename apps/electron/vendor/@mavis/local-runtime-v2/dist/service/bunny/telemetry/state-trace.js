import { createHash } from 'node:crypto';
import { estimateCharsToTokensCjkAware } from '@mavis/context-manager';
/** Session Clio runtime events of Bunny's main conversation (spec 17.1). */
const BUNNY_STATE_INJECTED_EVENT = 'bunny.state_injected';
const BUNNY_STATE_INJECTED_SCHEMA = 'mavis.bunny_state_injected.v2';
const BUNNY_TURN_ENDED_EVENT = 'bunny.turn_ended';
const BUNNY_TURN_ENDED_SCHEMA = 'mavis.bunny_turn_ended.v1';
const BUNNY_STEER_PRECHECK_EVENT = 'bunny.steer_precheck';
const BUNNY_STEER_PRECHECK_SCHEMA = 'mavis.bunny_steer_precheck.v1';
const SEARCH_TOOLS = ['conversation_search', 'conversation_read'];
/** Task IDs a `bunny.turn_ended` lists at most. */
const MAX_DELIVERED_TASK_IDS = 20;
/** Turns whose end never arrives are dropped oldest first past this many. */
const MAX_TRACKED_TURNS = 64;
/** Sessions whose prefix estimates are kept; the one used longest ago is dropped first. */
const MAX_ESTIMATED_SESSIONS = 16;
/**
 * Bunny's main-conversation trajectory (spec 17.1): what each Turn was given and how it
 * ended. Uploads follow the trajectory's own consent switch and masking. Recording never
 * changes what a Turn receives, and it never runs before the Turn's model request: the
 * injection is only noted when the prefix is applied, and its trace is built once the main
 * request has gone out (or at the Turn's end, if it never did).
 */
export class BunnyStateTrace {
    sink;
    options;
    turns = new Map();
    estimates = new Map();
    constructor(sink, options = {}) {
        this.sink = sink;
        this.options = options;
    }
    /**
     * The Turn's delta block and prefix. Idle periods are traced by the segment
     * compaction coordinator as `bunny.idle` (10.3), not here.
     */
    injected(input) {
        this.turns.set(turnKey(input.sessionId, input.turnId), {
            wakeReasons: input.wakeReasons,
            firstMeeting: input.firstMeeting === true,
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            toolCalls: new Map(),
            deliveredTaskIds: [],
            injection: input,
        });
        if (this.turns.size > MAX_TRACKED_TURNS)
            dropOldest(this.turns);
    }
    /** Whether the Turn's injection waits for its main request to go out. */
    awaitsRequest(turn) {
        const stats = this.turns.get(turnKey(turn.sessionId, turn.turnId));
        return stats?.injection !== undefined && stats.requestSent !== true;
    }
    /** The Turn's main model request went out: its injection is traced after that, once. */
    requestSent(turn) {
        const stats = this.turns.get(turnKey(turn.sessionId, turn.turnId));
        if (!stats?.injection || stats.requestSent)
            return;
        stats.requestSent = true;
        (this.options.defer ?? defaultDefer)(() => this.emitInjection(turn.sessionId, turn.turnId));
    }
    /** The recall precheck of a user message steered into a running Turn (spec 15.7). */
    steeredPrecheck(input) {
        this.report(input.sessionId, input.turnId, BUNNY_STEER_PRECHECK_EVENT, () => ({
            schema: BUNNY_STEER_PRECHECK_SCHEMA,
            precheck: input.precheck,
        }));
    }
    /**
     * A recall tool call of a traced Turn finished, called directly or from `run_code`: counted
     * where the tool runs, since a `run_code` child call has no assistant tool call of its own.
     */
    toolFinished(sessionId, turnId, tool) {
        const stats = this.turns.get(turnKey(sessionId, turnId));
        if (stats)
            stats.toolCalls.set(tool, (stats.toolCalls.get(tool) ?? 0) + 1);
    }
    /** Committed messages of a traced Turn: first output and usage. */
    committed(sessionId, turnId, messages) {
        const stats = this.turns.get(turnKey(sessionId, turnId));
        if (!stats)
            return;
        for (const message of messages) {
            if (!isRecord(message) || message['role'] !== 'assistant')
                continue;
            observeAssistant(stats, message);
        }
    }
    /** Tasks whose state this Turn's delta block delivered (the baseline moved for them). */
    delivered(sessionId, turnId, taskSessionIds) {
        const stats = this.turns.get(turnKey(sessionId, turnId));
        if (!stats || !taskSessionIds.length)
            return;
        const taskIdOf = this.options.taskIdOf ?? ((id) => id);
        stats.deliveredTaskIds = [
            ...new Set([...stats.deliveredTaskIds, ...taskSessionIds.map(taskIdOf)]),
        ];
    }
    /** Reports the Turn's end; returns what it counted, or undefined for an untraced Turn. */
    ended(facts) {
        const key = turnKey(facts.sessionId, facts.turnId);
        const stats = this.turns.get(key);
        if (!stats)
            return undefined;
        // What the Turn was given must be read before the injection is traced and dropped.
        const recallPointers = pointerCount(stats.injection?.rendered.precheck);
        // A Turn that never sent its main request still reports what it was given, first.
        this.emitInjection(facts.sessionId, facts.turnId);
        this.turns.delete(key);
        this.report(facts.sessionId, facts.turnId, BUNNY_TURN_ENDED_EVENT, () => ({
            schema: BUNNY_TURN_ENDED_SCHEMA,
            status: facts.status,
            wake_reasons: stats.wakeReasons,
            silent: facts.silent,
            consumed_user_input: facts.consumedUserInput,
            // Kept in the schema; no Turn forces its first tool any more.
            forced_first_tool: null,
            first_output_block: stats.firstOutputBlock ?? null,
            first_visible_text_ms: facts.firstVisibleTextMs ?? null,
            input_tokens: stats.inputTokens,
            output_tokens: stats.outputTokens,
            cache_read_tokens: stats.cacheReadTokens,
            cache_write_tokens: stats.cacheWriteTokens,
            conversation_search_calls: stats.toolCalls.get(SEARCH_TOOLS[0]) ?? 0,
            conversation_read_calls: stats.toolCalls.get(SEARCH_TOOLS[1]) ?? 0,
            recall_pointers: recallPointers,
            segment_id: facts.segmentId ?? null,
            delivered_task_ids: stats.deliveredTaskIds.slice(0, MAX_DELIVERED_TASK_IDS),
        }));
        return {
            wakeReasons: stats.wakeReasons,
            firstMeeting: stats.firstMeeting,
            inputTokens: stats.inputTokens,
            outputTokens: stats.outputTokens,
            cacheReadTokens: stats.cacheReadTokens,
            cacheWriteTokens: stats.cacheWriteTokens,
            searchCalls: stats.toolCalls.get(SEARCH_TOOLS[0]) ?? 0,
            readCalls: stats.toolCalls.get(SEARCH_TOOLS[1]) ?? 0,
            recallPointers,
            deliveredTaskIds: stats.deliveredTaskIds,
        };
    }
    emitInjection(sessionId, turnId) {
        const stats = this.turns.get(turnKey(sessionId, turnId));
        const input = stats?.injection;
        if (!stats || !input)
            return;
        stats.injection = undefined;
        this.report(sessionId, turnId, BUNNY_STATE_INJECTED_EVENT, () => {
            const { rendered, prefix } = input;
            return {
                schema: BUNNY_STATE_INJECTED_SCHEMA,
                wake_reasons: input.wakeReasons,
                mode: rendered.mode,
                content_sha256: createHash('sha256').update(rendered.content).digest('hex'),
                content_bytes: Buffer.byteLength(rendered.content, 'utf8'),
                content: rendered.content,
                injected_tokens: this.injectedTokens(sessionId, prefix, rendered.content),
                history_messages: prefix.historyMessages,
                prefix_refreshed: prefix.refreshed,
                shown_task_count: rendered.shownTaskCount,
                undelivered_count: rendered.undeliveredTaskCount,
                open_task_count: rendered.openTaskCount,
                ledger_lines: rendered.ledgerLineCount,
                space_lines: rendered.spaceLineCount,
                space_read_ms: rendered.spaceReadMs,
                view_stale: rendered.stale,
                view_as_of_ms: rendered.asOfMs,
                // Kept in the schema; no Turn forces its first tool any more.
                forced_first_tool: null,
                precheck: rendered.precheck ?? null,
            };
        });
    }
    /**
     * Estimated tokens of each layer the Turn resends (spec 17.1): ① system prompt and tools,
     * ② memory, ③ handoff header, ④ retained text, ⑤ the segment's own conversation, and the
     * delta block. A layer the Turn cannot tell is null. A frozen prefix hands the same system
     * prompt, memory and tool definitions to every Turn until it refreshes, and the conversation
     * only grows between compactions, so each estimate is reused while its input is the same:
     * a Turn serializes only what changed since the last one.
     */
    injectedTokens(sessionId, prefix, deltaBlock) {
        const layers = prefix.layers;
        const cached = this.frozenPrefixTokens(sessionId, prefix);
        const messages = this.messageEstimator(sessionId);
        const tokens = {
            system_prompt: cached.systemPrompt,
            tools: cached.tools,
            memory: cached.memory ?? null,
            handoff_header: layers
                ? messages.estimate(layers.handoffHeader ? [layers.handoffHeader] : [])
                : null,
            retained_text: layers?.retainedText ? messages.estimate(layers.retainedText) : null,
            segment_conversation: layers?.segmentConversation
                ? messages.estimate(layers.segmentConversation)
                : null,
            delta_block: estimateCharsToTokensCjkAware(deltaBlock),
        };
        messages.keep();
        return tokens;
    }
    /**
     * Estimates conversation messages one by one, reusing the estimate of a message the last
     * Turn already had; `keep` then remembers only the messages this Turn had.
     */
    messageEstimator(sessionId) {
        const cache = this.prefixEstimates(sessionId);
        const previous = cache.messages;
        const current = new Map();
        return {
            estimate: (records) => {
                let total = 0;
                for (const record of records) {
                    const key = messageKey(record);
                    const known = key === undefined ? undefined : (current.get(key) ?? previous?.get(key));
                    const tokens = known ?? estimateCharsToTokensCjkAware(JSON.stringify(record) ?? '');
                    if (key !== undefined)
                        current.set(key, tokens);
                    total += tokens;
                }
                return total;
            },
            keep: () => {
                cache.messages = current;
            },
        };
    }
    /** The system prompt, tools and memory estimates, estimated again only when they changed. */
    frozenPrefixTokens(sessionId, prefix) {
        const cached = this.prefixEstimates(sessionId);
        const systemPrompt = prefix.layers?.systemPrompt ?? prefix.systemPrompt;
        if (cached.systemPrompt?.text !== systemPrompt)
            cached.systemPrompt = {
                text: systemPrompt,
                tokens: estimateCharsToTokensCjkAware(systemPrompt),
            };
        if (!cached.tools || !sameItems(cached.tools.definitions, prefix.toolDefinitions))
            cached.tools = {
                definitions: prefix.toolDefinitions,
                tokens: estimateCharsToTokensCjkAware(JSON.stringify(prefix.toolDefinitions)),
            };
        const memory = prefix.layers?.memory;
        if (memory === undefined)
            return { systemPrompt: cached.systemPrompt.tokens, tools: cached.tools.tokens };
        if (cached.memory?.text !== memory)
            cached.memory = { text: memory, tokens: estimateCharsToTokensCjkAware(memory) };
        return {
            systemPrompt: cached.systemPrompt.tokens,
            tools: cached.tools.tokens,
            memory: cached.memory.tokens,
        };
    }
    prefixEstimates(sessionId) {
        const existing = this.estimates.get(sessionId);
        // Re-inserting keeps the map ordered by last use, oldest first.
        if (existing)
            this.estimates.delete(sessionId);
        const estimates = existing ?? {};
        this.estimates.set(sessionId, estimates);
        if (this.estimates.size > MAX_ESTIMATED_SESSIONS)
            dropOldest(this.estimates);
        return estimates;
    }
    report(sessionId, turnId, eventType, payload) {
        if (!this.sink?.reportRuntimeEvent)
            return;
        const startedAt = performance.now();
        try {
            this.sink.reportRuntimeEvent(sessionId, {
                eventType,
                payload: { ...payload(), session_id: sessionId, turn_id: turnId },
                origin: { turnId },
            });
        }
        catch {
            // Trace capture must never change what the turn receives.
        }
        try {
            this.options.measured?.(eventType, performance.now() - startedAt);
        }
        catch {
            // Neither does measuring it.
        }
    }
}
function defaultDefer(run) {
    setImmediate(run).unref?.();
}
function observeAssistant(stats, message) {
    addUsage(stats, isRecord(message['usage']) ? message['usage'] : {});
    const content = Array.isArray(message['content']) ? message['content'] : [];
    const first = content.find(isRecord);
    if (stats.firstOutputBlock === undefined && typeof first?.['type'] === 'string')
        stats.firstOutputBlock = first['type'];
}
function addUsage(stats, usage) {
    stats.inputTokens += numberOf(usage['input']);
    stats.outputTokens += numberOf(usage['output']);
    stats.cacheReadTokens += numberOf(usage['cacheRead']);
    stats.cacheWriteTokens += numberOf(usage['cacheWrite']);
}
/** A frozen prefix hands each Turn a new list of the same tool definition objects. */
function sameItems(left, right) {
    return left.length === right.length && left.every((item, index) => item === right[index]);
}
/**
 * What tells a conversation message apart without serializing it: its role, its time, the tool
 * call it answers, and the size of its content. A message without a time has no key and is
 * estimated every Turn.
 */
function messageKey(record) {
    if (!isRecord(record) || typeof record['timestamp'] !== 'number')
        return undefined;
    const content = record['content'];
    const size = typeof content === 'string' || Array.isArray(content) ? content.length : '';
    const toolCallId = typeof record['toolCallId'] === 'string' ? record['toolCallId'] : '';
    return `${String(record['role'])}:${record['timestamp']}:${toolCallId}:${size}`;
}
function numberOf(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
/** How many earlier-conversation pointers the delta block carried, from the precheck's trace. */
function pointerCount(precheck) {
    return isRecord(precheck) ? numberOf(precheck['pointers']) : 0;
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function turnKey(sessionId, turnId) {
    return `${sessionId}\0${turnId}`;
}
/** Drops a map's oldest entry: maps here are kept in insertion order, oldest first. */
function dropOldest(map) {
    const oldest = map.keys().next();
    if (!oldest.done)
        map.delete(oldest.value);
}
//# sourceMappingURL=state-trace.js.map