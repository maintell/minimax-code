import { executeToolCall, } from '@earendil-works/pi-agent-core';
import { readImageEncodedContent, readProgrammaticErrorData, readProgrammaticErrorRaw, } from '../tools/programmatic.js';
import { isPtcToolErrorCode, PTC_DEFAULT_WALL_CLOCK_MS, PTC_MAX_WALL_CLOCK_MS, resolvePtcWallClock, } from '../tools/ptc.js';
import { newRuntimeTool, runtimeToolResultIsError } from './tools.js';
/** Default batch wall clock; run_code raises it per batch through `timeout_ms`. */
export const PTC_BATCH_WALL_CLOCK_MS = PTC_DEFAULT_WALL_CLOCK_MS;
/** Table 1 of the PTC guest contract: `error.message` carries at most 1000 characters. */
const MAX_PTC_ERROR_MESSAGE_CHARS = 1_000;
/**
 * Builds the turn-local capability exposed to a run_code tool. It resolves
 * the parent against Pi's real assistant message, so guest code cannot forge
 * another session, tool catalog, hook chain, or event sequence.
 */
export function createPtcToolExecutor(options) {
    const batches = new WeakMap();
    let nextBatchId = 0;
    const findParent = (parentToolCallId) => findAssistantMessage(options.agent, parentToolCallId);
    const getClock = (parentToolCallId, wallClockMs) => {
        if (!options.turn.input.toolConfig.ptcTools)
            return undefined;
        const parent = findParent(parentToolCallId);
        if (!parent)
            return undefined;
        // Re-resolved here too, so no caller can push the deadline past the maximum.
        const requested = wallClockMs === undefined ? undefined : resolvePtcWallClock(wallClockMs).ms;
        const existing = batches.get(parent);
        if (existing) {
            // Raise, never restart: the batch keeps its first start, so splitting
            // work across several run_code calls in one response gains no time.
            if (requested !== undefined && requested > existing.wallClockMs) {
                existing.wallClockMs = requested;
            }
            return existing;
        }
        const created = {
            id: `ptc_batch_${++nextBatchId}`,
            startedAtMs: options.nowMs(),
            wallClockMs: requested ?? PTC_DEFAULT_WALL_CLOCK_MS,
            pauseCount: 0,
            pausedSinceMs: undefined,
            pausedMs: 0,
        };
        batches.set(parent, created);
        return created;
    };
    return {
        getBatch(parentToolCallId, wallClockMs) {
            const clock = getClock(parentToolCallId, wallClockMs);
            return clock ? batchView(clock, options.nowMs()) : undefined;
        },
        getToolExecutionMode(toolName) {
            const tool = findRuntimeTool(options.turn, toolName);
            return tool?.def.executionMode ?? (tool ? 'sequential' : undefined);
        },
        async execute(request) {
            const baseRecord = {
                child_tool_call_id: request.toolCallId,
                parent_tool_call_id: request.parentToolCallId,
                tool_name: request.toolName,
            };
            const parent = findParent(request.parentToolCallId);
            if (!parent) {
                return failedOutcome(baseRecord, 'PTC_PARENT_NOT_FOUND', 'PTC parent tool call is unavailable.');
            }
            if (!options.turn.input.toolConfig.ptcTools) {
                return failedOutcome(baseRecord, 'PTC_NOT_AVAILABLE', 'PTC is unavailable for this turn.');
            }
            const clock = getClock(request.parentToolCallId);
            if (!clock || isExpired(clock, options.nowMs())) {
                return failedOutcome(baseRecord, 'PTC_BATCH_EXPIRED', 'PTC batch deadline has expired.');
            }
            if (request.signal?.aborted) {
                return failedOutcome(baseRecord, 'PTC_ABORTED', 'PTC execution was cancelled before dispatch.');
            }
            const runtimeTool = findRuntimeTool(options.turn, request.toolName);
            // The tool's own return value or thrown error, seen before Pi hooks run.
            const own = {};
            const childTool = runtimeTool
                ? newRuntimeTool(runtimeTool, {
                    ...options.turn.input.toolConfig.context,
                    parentToolCallId: request.parentToolCallId,
                    ...(request.parentDescription?.trim()
                        ? { ptcParentDescription: request.parentDescription.trim() }
                        : {}),
                    // LocalBashTool reads this host capability. Other tools ignore it.
                    // Always false, even when the Turn itself may auto-promote: a
                    // program waits for its tools.bash to finish. Moving a long one
                    // to the background left the model polling task_output from the
                    // top level, one full request per poll, while waiting inside the
                    // program costs no tokens.
                    allowBashAutoPromotion: false,
                    // Same deadline as the dispatch check above and the guest wall
                    // clock, so a foreground Bash child cannot outlive its program;
                    // a longer Bash timeout extends this one clock instead.
                    ptcDeadline: childDeadline(clock, options.nowMs, () => readTurnLogger(options.turn), baseRecord),
                }, () => options.turn.bridge.getActiveAssistantMessageId(), {
                    // Recorded now, before Pi runs the after-tool hooks: the hooks
                    // receive this same content array, so an in-place edit such as
                    // `result.content[0].text = '[redacted]'` would otherwise still
                    // compare as the tool's own content.
                    onResult: (result) => {
                        own.returned = {
                            result,
                            isError: runtimeToolResultIsError(result),
                            contentJson: contentJson(result.content),
                        };
                    },
                    onError: (error) => {
                        own.thrown = { error };
                    },
                })
                : undefined;
            const childContext = {
                systemPrompt: options.agent.state.systemPrompt,
                messages: [...options.agent.state.messages],
                tools: childTool ? [childTool] : [],
            };
            const toolCall = {
                type: 'toolCall',
                id: request.toolCallId,
                name: request.toolName,
                arguments: { ...request.args },
            };
            const beforeToolCall = options.agent.beforeToolCall;
            const lifecycleConfig = {
                ...(beforeToolCall
                    ? {
                        beforeToolCall: pauseClockDuringAdmission(beforeToolCall, clock, options.nowMs, () => readTurnLogger(options.turn), baseRecord),
                    }
                    : {}),
                ...(options.agent.onToolExecutionStart
                    ? { onToolExecutionStart: options.agent.onToolExecutionStart }
                    : {}),
                ...(options.agent.afterToolCall ? { afterToolCall: options.agent.afterToolCall } : {}),
            };
            let startAcknowledged = false;
            let deferredTerminalEvent;
            let terminalEmissionAttempted = false;
            let finalizedOutcome;
            const emitChildLifecycleEvent = async (event) => {
                options.observeChildLifecycle?.(event);
                if (event.type === 'tool_execution_end') {
                    deferredTerminalEvent = event;
                    return;
                }
                await options.emit(event);
                if (event.type === 'tool_execution_start')
                    startAcknowledged = true;
            };
            try {
                const finalized = await executeToolCall(childContext, parent, toolCall, lifecycleConfig, request.signal, emitChildLifecycleEvent, {
                    parentToolCallId: request.parentToolCallId,
                    ...(request.parentDescription?.trim()
                        ? { parentDescription: request.parentDescription.trim() }
                        : {}),
                });
                const outcome = completedOutcome(baseRecord, finalized.args, finalized.result, finalized.isError, finalized.failure, finalized.isErrorOrigin, finalized.terminateAgent === true, outcomeSources(runtimeTool, request), options.turn.input.toolConfig.context.ptcResultProjection, own, readTurnLogger(options.turn));
                finalizedOutcome = outcome;
                terminalEmissionAttempted = true;
                await emitPtcChildTerminalEvent(options, deferredTerminalEvent, request, outcome);
                return outcome;
            }
            catch {
                const unknown = unknownOutcome(baseRecord, 'PTC_OUTCOME_UNKNOWN', 'PTC execution did not report a terminal outcome.');
                const outcome = finalizedOutcome
                    ? {
                        ...finalizedOutcome,
                        ...unknown,
                        record: { ...finalizedOutcome.record, ...unknown.record },
                        retainedFacts: [...finalizedOutcome.retainedFacts, ...unknown.retainedFacts],
                        terminateAgent: finalizedOutcome.terminateAgent,
                    }
                    : unknown;
                if (startAcknowledged && !terminalEmissionAttempted) {
                    try {
                        terminalEmissionAttempted = true;
                        await emitPtcChildTerminalEvent(options, deferredTerminalEvent, request, outcome);
                    }
                    catch {
                        // A failed durable end is itself unknown; the persisted start lets recovery mark it so.
                    }
                }
                return outcome;
            }
        },
    };
}
async function emitPtcChildTerminalEvent(options, terminal, request, outcome) {
    const rawResult = terminal?.result ?? unknownPtcChildResult(outcome);
    const event = {
        type: 'tool_execution_end',
        toolCallId: terminal?.toolCallId ?? request.toolCallId,
        toolName: terminal?.toolName ?? request.toolName,
        result: withPtcChildExecutionDetails(rawResult, outcome),
        isError: outcome.isError === true,
        parentToolCallId: terminal?.parentToolCallId ?? request.parentToolCallId,
    };
    // The observer already saw Pi's own end; a synthesized end is new to it.
    if (!terminal)
        options.observeChildLifecycle?.(event);
    await options.emit(event);
}
function withPtcChildExecutionDetails(result, outcome) {
    const details = isRecord(result.details)
        ? result.details
        : result.details === undefined
            ? {}
            : { original_tool_details: result.details };
    return {
        ...result,
        details: {
            ...details,
            ptc_child: {
                version: 1,
                record: outcome.record,
                retained_facts: outcome.retainedFacts,
            },
        },
    };
}
function unknownPtcChildResult(outcome) {
    return {
        content: [
            {
                type: 'text',
                text: outcome.error?.message ?? 'PTC execution did not report a terminal outcome.',
            },
        ],
        details: {},
    };
}
function findRuntimeTool(turn, toolName) {
    return turn.input.toolConfig.ptcTools?.find((tool) => tool.def.name === toolName);
}
function outcomeSources(runtimeTool, request) {
    const evidenceSource = runtimeTool && request.evidenceSource?.tool === runtimeTool
        ? request.evidenceSource.source
        : runtimeTool?.source;
    return {
        ...(runtimeTool?.source === undefined ? {} : { source: runtimeTool.source }),
        ...(evidenceSource === undefined ? {} : { evidenceSource }),
    };
}
function findAssistantMessage(agent, parentToolCallId) {
    if (!agent.state.pendingToolCalls.has(parentToolCallId))
        return undefined;
    for (const message of [...agent.state.messages].reverse()) {
        if (message.role !== 'assistant')
            continue;
        const assistant = message;
        if (assistant.content.some((block) => block.type === 'toolCall' && block.id === parentToolCallId && block.name === 'run_code')) {
            return assistant;
        }
    }
    return undefined;
}
function failedOutcome(baseRecord, code, message) {
    return {
        isError: true,
        error: { code, message },
        record: { ...baseRecord, status: 'failed', is_error: true },
        retainedFacts: [
            {
                kind: 'child_error',
                child_tool_call_id: baseRecord.child_tool_call_id,
                code,
                ...(code === 'PTC_ABORTED' ? { cancelled: true } : {}),
            },
        ],
        terminateAgent: false,
    };
}
function unknownOutcome(baseRecord, code, message) {
    return {
        isError: true,
        error: { code, message },
        record: { ...baseRecord, status: 'unknown', is_error: true, outcome_unknown: true },
        retainedFacts: [
            { kind: 'outcome_unknown', child_tool_call_id: baseRecord.child_tool_call_id },
            { kind: 'child_error', child_tool_call_id: baseRecord.child_tool_call_id, code },
        ],
        terminateAgent: false,
    };
}
function completedOutcome(baseRecord, args, result, isError, failure, isErrorOrigin, terminateAgent, sources, projection, own, logger) {
    const defaultStatus = isError ? 'failed' : 'completed';
    const ownership = resolveToolOwnership(own, result, isError, failure, isErrorOrigin);
    const programmatic = ownership.owned ? ownership.programmatic : undefined;
    if (!ownership.owned)
        logWithheldPayload(logger, baseRecord, own, ownership.reason);
    const projected = projection?.project({
        childToolCallId: baseRecord.child_tool_call_id,
        parentToolCallId: baseRecord.parent_tool_call_id,
        toolName: baseRecord.tool_name,
        ...(sources.evidenceSource === undefined ? {} : { source: sources.evidenceSource }),
        ...(args === undefined ? {} : { args }),
        result,
        isError,
        ...(isErrorOrigin === undefined ? {} : { isErrorOrigin }),
        status: defaultStatus,
        ...(programmatic ? { programmatic } : {}),
    });
    const status = projected?.status ?? defaultStatus;
    const effectiveIsError = projected?.isError ?? isError;
    const error = effectiveIsError ? outcomeError(failure, result, ownership.owned) : undefined;
    const toolErrorCode = error ? thrownToolErrorCode(own, failure) : undefined;
    const retainedFacts = [
        ...(projected?.retainedFacts ?? []),
        ...(error
            ? [
                {
                    kind: 'child_error',
                    child_tool_call_id: baseRecord.child_tool_call_id,
                    code: error.code,
                    ...(failure?.kind === 'cancelled' ? { cancelled: true } : {}),
                    ...(toolErrorCode === undefined ? {} : { tool_error_code: toolErrorCode }),
                },
            ]
            : []),
        ...(failure?.kind === 'blocked' && failure.approvalStatus !== undefined
            ? [
                {
                    kind: 'approval',
                    child_tool_call_id: baseRecord.child_tool_call_id,
                    status: failure.approvalStatus,
                },
            ]
            : []),
        ...(terminateAgent ? [{ kind: 'terminate_agent' }] : []),
    ];
    return {
        result,
        isError: effectiveIsError,
        ...sources,
        ...(error ? { error } : {}),
        ...(programmatic ? { programmatic } : {}),
        ...(ownership.owned ? {} : { resultRewritten: true }),
        ...(!ownership.owned && ownership.imageEncoding
            ? { imageEncoding: ownership.imageEncoding }
            : {}),
        record: {
            ...baseRecord,
            ...(projected?.input ? { input: projected.input } : {}),
            status,
            ...(effectiveIsError ? { is_error: true } : {}),
            ...(projected?.resultRef ? { result_ref: projected.resultRef } : {}),
        },
        // A user denial of a child approval is native: only this call fails
        // (PTC_PERMISSION_DENIED) and the program keeps running, so the whole
        // result goes back to the model once the program ends. Stopping the
        // whole program is the Turn's stop button, not the deny button.
        retainedFacts,
        terminateAgent,
    };
}
/**
 * Whether the final Pi result is still exactly what the tool produced. Only
 * then may PTC expose the tool's programmatic payload (data, completeness,
 * raw error) or quote its error text: a hook that redacted, replaced or
 * re-classified a result, or a safety check that intercepted it (it fails the
 * after-hook chain), must not be bypassed through that side channel.
 * Immediate failures (unknown tool, invalid arguments, blocked call) never ran
 * an after-hook, so their final text is Pi's own and stays quotable.
 */
function resolveToolOwnership(own, result, isError, failure, isErrorOrigin) {
    if (failure?.kind === 'after_hook')
        return { owned: false, reason: 'after_hook_failed' };
    if (own.returned) {
        if (failure !== undefined)
            return { owned: false, reason: 'after_hook_failed' };
        if (isErrorOrigin === 'hook' || isError !== own.returned.isError) {
            return { owned: false, reason: 'hook_changed_error_state' };
        }
        // Content and error state only, as the proposal defines ownership.
        // details are not compared because the host itself adds fields such as
        // `is_error` there, so a hook that rewrites only details does not change
        // `data` (for MCP, structuredContent is also in details.mcp; README §4.13).
        const same = sameToolContent(result.content, own.returned.contentJson);
        if (same !== true)
            return { owned: false, reason: same, ...encodedOnly(own.returned, result) };
        const programmatic = own.returned.result.programmatic;
        return { owned: true, ...(programmatic ? { programmatic } : {}) };
    }
    if (own.thrown && failure?.kind === 'execution') {
        // Pi replaced the throw with `createErrorToolResult(message)` before the hooks ran.
        if (isErrorOrigin === 'hook' || !isError) {
            return { owned: false, reason: 'hook_changed_error_state' };
        }
        const expected = contentJson([{ type: 'text', text: failure.message }]);
        const same = sameToolContent(result.content, expected);
        if (same !== true)
            return { owned: false, reason: same };
        const errorRaw = readProgrammaticErrorRaw(own.thrown.error);
        const data = readProgrammaticErrorData(own.thrown.error);
        const programmatic = {
            ...(errorRaw === undefined ? {} : { errorRaw }),
            ...(data === undefined ? {} : { data }),
        };
        return { owned: true, ...(Object.keys(programmatic).length > 0 ? { programmatic } : {}) };
    }
    return { owned: true };
}
/**
 * The result stays rewritten (no completeness, no details projection), but
 * when the host's request image encoder alone turned the tool's own content
 * into the final one, its facts and the tool's own data go with it, so the
 * projection can say how the image was sent. Any other hook change, before or
 * after the encoder, breaks the digest check and leaves nothing.
 */
function encodedOnly(own, result) {
    const images = readImageEncodedContent(result.content, own.contentJson);
    if (!images)
        return {};
    const data = own.result.programmatic?.data;
    return { imageEncoding: { images, ...(data ? { data } : {}) } };
}
/** JSON text of tool content; undefined when it cannot be serialized (cycles, BigInt). */
function contentJson(content) {
    try {
        return JSON.stringify(content);
    }
    catch {
        // Reported by the caller as `content_unreadable`, never as unchanged.
        return undefined;
    }
}
/**
 * Compares the final content with the tool's own content as JSON text, never
 * by reference. Content that cannot be serialized cannot be proven unchanged,
 * so it counts as rewritten.
 */
function sameToolContent(actual, expectedJson) {
    const actualJson = contentJson(actual);
    if (expectedJson === undefined || actualJson === undefined)
        return 'content_unreadable';
    return actualJson === expectedJson ? true : 'hook_changed_content';
}
/** Records why the tool's payload was withheld; never logs the payload or content itself. */
function logWithheldPayload(logger, record, own, reason) {
    const payload = own.returned?.result.programmatic;
    const hasRaw = own.thrown !== undefined && readProgrammaticErrorRaw(own.thrown.error) !== undefined;
    const hasThrownData = own.thrown !== undefined && readProgrammaticErrorData(own.thrown.error) !== undefined;
    if (!payload && !hasRaw && !hasThrownData && reason !== 'after_hook_failed')
        return;
    try {
        logger?.info?.({
            child_tool_call_id: record.child_tool_call_id,
            parent_tool_call_id: record.parent_tool_call_id,
            tool_name: record.tool_name,
            reason,
            had_data: payload?.data !== undefined || hasThrownData,
            had_completeness: payload?.completeness !== undefined,
            had_error_raw: payload?.errorRaw !== undefined || hasRaw,
        }, 'ptc child programmatic payload withheld');
    }
    catch {
        // Diagnostics must not change the child outcome.
    }
}
function readTurnLogger(turn) {
    // Unit-test turns may omit the logger; production turns always carry one.
    return turn.logger;
}
/** Ended pauses plus the one in progress, if any. */
function pausedTotalMs(clock, nowMs) {
    const ongoingMs = clock.pausedSinceMs === undefined ? 0 : Math.max(0, nowMs - clock.pausedSinceMs);
    return clock.pausedMs + ongoingMs;
}
/** While a pause is in progress the deadline moves with the clock, so the time left stays the same. */
function deadlineOf(clock, nowMs) {
    return clock.startedAtMs + clock.wallClockMs + pausedTotalMs(clock, nowMs);
}
function isExpired(clock, nowMs) {
    return nowMs >= deadlineOf(clock, nowMs);
}
function batchView(clock, nowMs) {
    return {
        id: clock.id,
        deadlineAtMs: deadlineOf(clock, nowMs),
        pausedMs: pausedTotalMs(clock, nowMs),
        paused: clock.pauseCount > 0,
    };
}
/**
 * Starts one child's pause; returns its start, or undefined for a batch that
 * had already expired. Pausing an expired batch would keep moving its
 * deadline, and the program is not revived by a late admission.
 */
function beginPause(clock, nowMs) {
    if (isExpired(clock, nowMs))
        return undefined;
    if (clock.pauseCount === 0)
        clock.pausedSinceMs = nowMs;
    clock.pauseCount += 1;
    return nowMs;
}
/** Several children may be paused at once; the clock runs again only after the last one. */
function endPause(clock, nowMs) {
    clock.pauseCount = Math.max(0, clock.pauseCount - 1);
    if (clock.pauseCount > 0 || clock.pausedSinceMs === undefined)
        return;
    clock.pausedMs += Math.max(0, nowMs - clock.pausedSinceMs);
    clock.pausedSinceMs = undefined;
}
/** Pauses at least this long are logged; shorter ones are routine policy checks. */
const LOGGED_ADMISSION_PAUSE_MS = 1_000;
/**
 * The program clock stands still while a child is in Pi's beforeToolCall
 * chain: PTC child policy, tool safety checks, plugin PreToolUse hooks, plan
 * mode and the permission gate, whose approval card waits for the user. A
 * native tool call starts timing only after that chain (Pi runs the whole
 * chain before `tool.execute`, where Bash computes its timeouts), so an
 * approval left open for minutes used to stop the program with
 * wall_clock_exceeded, while the same call outside a program just waited.
 * The pause ends in `finally`, so a chain that throws or is cancelled also
 * restarts the clock.
 */
function pauseClockDuringAdmission(beforeToolCall, clock, nowMs, logger, record) {
    return async (context, signal) => {
        const pausedAtMs = beginPause(clock, nowMs());
        try {
            return await beforeToolCall(context, signal);
        }
        finally {
            if (pausedAtMs !== undefined) {
                const resumedAtMs = nowMs();
                endPause(clock, resumedAtMs);
                const pausedMs = resumedAtMs - pausedAtMs;
                if (pausedMs >= LOGGED_ADMISSION_PAUSE_MS) {
                    logAdmissionPause(logger(), record, pausedMs, deadlineOf(clock, resumedAtMs) - resumedAtMs);
                }
            }
        }
    };
}
/** One line per long admission (usually an approval); never logs arguments. */
function logAdmissionPause(logger, record, pausedMs, remainingMs) {
    try {
        logger?.info?.({
            child_tool_call_id: record.child_tool_call_id,
            parent_tool_call_id: record.parent_tool_call_id,
            tool_name: record.tool_name,
            paused_ms: Math.round(pausedMs),
            remaining_ms: Math.round(remainingMs),
        }, 'ptc wall clock paused for tool admission');
    }
    catch {
        // Diagnostics must not change the child outcome.
    }
}
/**
 * The deadline one child sees. This batch clock is the only place the
 * deadline is computed or extended: `atMs` reads it live, the dispatch check
 * reads it, and run_code reads it again through getBatch when the guest wall
 * clock fires, so the three never disagree.
 */
function childDeadline(clock, nowMs, logger, record) {
    return {
        get atMs() {
            return deadlineOf(clock, nowMs());
        },
        extendForTimeout: (timeoutSeconds) => {
            const atMs = nowMs();
            const extension = extendForChildTimeout(clock, atMs, timeoutSeconds);
            if (extension)
                logWallClockExtended(logger(), record, timeoutSeconds, extension);
            return deadlineOf(clock, atMs);
        },
        reportTimeout: (decision) => logChildTimeout(logger(), record, decision),
    };
}
/**
 * Room after a Bash child's own timeout: a command that runs to its timeout
 * still has its result delivered and the program can return. Without it the
 * program deadline would land on the same moment and report a wall clock stop.
 */
const CHILD_TIMEOUT_MARGIN_MS = 5_000;
/**
 * A foreground Bash child asked for a `timeout` longer than the program has
 * left. In the 969645 eval 59 programs hit the 120s wall clock this way (a
 * long tools.bash timeout but no run_code timeout_ms): the command was cut
 * short and the next round ran it again. So the deadline moves to now plus
 * that timeout plus a margin, never past one hour from the batch start (the
 * timeout_ms maximum; a millisecond value written into the seconds argument
 * stops there) and never earlier. An expired program is not revived.
 */
function extendForChildTimeout(clock, nowMs, timeoutSeconds) {
    if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0)
        return undefined;
    // The deadline already includes the admission pauses, and `wallClockMs`
    // excludes them. The one-hour cap counts program time only, so it moves by
    // the pauses too; and the pauses are taken back out when the extended
    // deadline is written into `wallClockMs`, so it lands exactly on now +
    // timeout + margin instead of being pushed later by the pauses a second time.
    const pausedMs = pausedTotalMs(clock, nowMs);
    const deadlineAtMs = clock.startedAtMs + clock.wallClockMs + pausedMs;
    const remainingMs = deadlineAtMs - nowMs;
    if (remainingMs <= 0 || timeoutSeconds * 1_000 <= remainingMs)
        return undefined;
    const wantedAtMs = nowMs + timeoutSeconds * 1_000 + CHILD_TIMEOUT_MARGIN_MS;
    const maxAtMs = clock.startedAtMs + PTC_MAX_WALL_CLOCK_MS + pausedMs;
    const extendedAtMs = Math.min(wantedAtMs, maxAtMs);
    if (extendedAtMs <= deadlineAtMs)
        return undefined;
    clock.wallClockMs = extendedAtMs - clock.startedAtMs - pausedMs;
    return { remainingMs, extendedRemainingMs: extendedAtMs - nowMs, capped: wantedAtMs > maxAtMs };
}
/** One line per extension; never logs the command or other arguments. */
function logWallClockExtended(logger, record, timeoutSeconds, extension) {
    try {
        logger?.info?.({
            child_tool_call_id: record.child_tool_call_id,
            parent_tool_call_id: record.parent_tool_call_id,
            tool_name: record.tool_name,
            requested_timeout_s: timeoutSeconds,
            remaining_ms: Math.round(extension.remainingMs),
            extended_remaining_ms: Math.round(extension.extendedRemainingMs),
            capped: extension.capped,
        }, 'ptc wall clock extended for bash timeout');
    }
    catch {
        // Diagnostics must not change the child outcome.
    }
}
/**
 * Records how a child tool bounded its timeout by the program deadline, so a
 * command that stopped early can be traced to this rule. Never logs arguments.
 */
function logChildTimeout(logger, record, decision) {
    try {
        logger?.info?.({
            child_tool_call_id: record.child_tool_call_id,
            parent_tool_call_id: record.parent_tool_call_id,
            tool_name: record.tool_name,
            timeout_source: decision.source,
            timeout_s: decision.timeoutSeconds,
            remaining_ms: decision.remainingMs,
        }, 'ptc child timeout bounded by program deadline');
    }
    catch {
        // Diagnostics must not change the child outcome.
    }
}
/**
 * Guest-facing error for a failed child. `code` always comes from the host's
 * enumeration below. `message` is the tool's own error text when the tool
 * returned an error result that no hook rewrote (MCP/plugin `isError`);
 * otherwise it stays the host or Pi message used before.
 */
function outcomeError(failure, result, owned) {
    const base = errorFromFailure(failure);
    if (failure === undefined) {
        const text = owned ? boundErrorMessage(resultText(result)) : '';
        return text ? { code: base.code, message: text, quotable: true } : base;
    }
    return {
        code: base.code,
        message: boundErrorMessage(base.message),
        ...(owned && failure.kind !== 'after_hook' ? { quotable: true } : {}),
    };
}
function errorFromFailure(failure) {
    if (!failure)
        return { code: 'PTC_TOOL_FAILED', message: 'Tool execution failed.' };
    const codeByKind = {
        tool_not_found: 'PTC_TOOL_NOT_FOUND',
        argument_preparation: 'PTC_ARGUMENT_PREPARATION_FAILED',
        argument_validation: 'PTC_ARGUMENT_VALIDATION_FAILED',
        before_hook: 'PTC_BEFORE_TOOL_HOOK_FAILED',
        blocked: failure.blockedBy === 'permission' ? 'PTC_PERMISSION_DENIED' : 'PTC_TOOL_BLOCKED',
        cancelled: 'PTC_CANCELLED',
        execution: 'PTC_TOOL_EXECUTION_FAILED',
        after_hook: 'PTC_AFTER_TOOL_HOOK_FAILED',
    };
    return { code: codeByKind[failure.kind], message: failure.message };
}
/**
 * Pi's failure keeps only the message of a thrown error, so the tool's own
 * code (for example `computer_aborted`) is read from the object the tool
 * threw. It is host metadata only: the guest and the model keep seeing the
 * PTC_* code and the unchanged message.
 */
function thrownToolErrorCode(own, failure) {
    if (failure?.kind !== 'execution' || !own.thrown || !isRecord(own.thrown.error)) {
        return undefined;
    }
    const code = own.thrown.error.code;
    return isPtcToolErrorCode(code) ? code : undefined;
}
function resultText(result) {
    return (Array.isArray(result.content) ? result.content : [])
        .flatMap((block) => (isRecord(block) && typeof block.text === 'string' ? [block.text] : []))
        .join('\n')
        .trim();
}
function boundErrorMessage(message) {
    const characters = Array.from(message);
    if (characters.length <= MAX_PTC_ERROR_MESSAGE_CHARS)
        return message;
    return `${characters.slice(0, MAX_PTC_ERROR_MESSAGE_CHARS - 1).join('')}…`;
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=ptc-tool-executor.js.map