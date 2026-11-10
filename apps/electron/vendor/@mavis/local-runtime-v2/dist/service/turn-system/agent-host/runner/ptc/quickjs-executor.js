import { Worker } from 'node:worker_threads';
import { mergedPtcLimits, parsePtcToolArgs, PTC_RESULT_TOO_LARGE, ptcResultTooLargeFailure, ptcToolCallLimitRefusal, ptcUnconsumedResultsTooLargeFailure, PtcSerializationError, serializePtcValue, } from '../../execution/ptc/contracts.js';
import { ptcWorkerUrl } from './worker-path.js';
/**
 * Shortest wait before the wall clock checks a paused deadline again. The
 * time left does not shrink during the pause, so with only a few ms left the
 * timer would otherwise wake almost continuously until the user answers.
 */
const PAUSED_DEADLINE_RECHECK_MS = 1_000;
/** The host owns time limits, bridge admission and every execution record. */
export async function executePtcQuickJs(input) {
    const limits = mergedPtcLimits(input.limits);
    if (new TextEncoder().encode(input.code).byteLength > limits.maxCodeBytes) {
        return failed('invalid_code', `PTC source exceeds the ${limits.maxCodeBytes}-byte limit.`, false, [{ kind: 'budget_exceeded', budget: 'code' }]);
    }
    return await new PtcQuickJsExecution(input, limits).run();
}
/** One concrete Worker lifetime; no state is shared with another guest program. */
class PtcQuickJsExecution {
    input;
    limits;
    worker;
    controller = new AbortController();
    childCalls = new Map();
    childFacts = new Map();
    globalFacts = [];
    persisted = new Map();
    provisionalChildIds = new Map();
    mediaByChild = new Map();
    unownedMedia = [];
    pendingReplyBytes = new Map();
    pendingBridgeBytes = 0;
    toolCalls = 0;
    /** Calls refused by the call budget (guest-side or host-side) without running. */
    refusedToolCalls = 0;
    /** Largest serialized child result, for the run_code log. */
    maxChildResultBytes = 0;
    /** Children that failed with PTC_RESULT_TOO_LARGE, for the run_code log. */
    oversizedChildren = 0;
    consoleText = '';
    consoleBytes = 0;
    consoleTruncated = false;
    finished = false;
    acceptingCalls = true;
    stopReason;
    resultAfterGrace;
    computeElapsedMs = 0;
    computeStartedAtMs;
    wallTimer;
    computeTimer;
    graceTimer;
    resolveResult;
    pendingWork = new Map();
    pendingHostCalls = new Map();
    constructor(input, limits) {
        this.input = input;
        this.limits = limits;
        this.worker = (input.workerFactory ?? createNodePtcWorker)(ptcWorkerUrl());
    }
    run() {
        return new Promise((resolve) => {
            this.resolveResult = resolve;
            this.input.signal?.addEventListener('abort', this.onExternalAbort, { once: true });
            this.worker.on('message', this.onMessage);
            this.worker.on('error', this.onError);
            this.worker.on('exit', this.onExit);
            this.wallTimer = setTimeout(this.onWallClock, this.limits.maxWallClockMs);
            if (this.input.signal?.aborted)
                this.onExternalAbort();
        });
    }
    onExternalAbort = () => this.stop('cancelled');
    onWallClock = () => {
        let deadlineAtMs;
        let paused = false;
        try {
            deadlineAtMs = this.input.readDeadlineAtMs?.();
            paused = this.input.readDeadlinePaused?.() === true;
        }
        catch {
            // An unreadable deadline keeps the limit the program started with.
        }
        const remainingMs = deadlineAtMs === undefined ? 0 : deadlineAtMs - Date.now();
        if (remainingMs > 0 && !this.finished && !this.stopReason) {
            // Admission time does not count against the program, so a paused
            // deadline keeps the same time left; checking it again after that small
            // remainder would spin the timer for as long as an approval stays open.
            // At most one recheck interval of program time can pass the deadline.
            const delayMs = paused ? Math.max(remainingMs, PAUSED_DEADLINE_RECHECK_MS) : remainingMs;
            this.wallTimer = setTimeout(this.onWallClock, delayMs);
            return;
        }
        this.stop('wall_clock_exceeded');
    };
    onMessage = (message) => {
        if (this.ignoreMessage(message))
            return;
        switch (message.type) {
            case 'ready':
                this.startGuest();
                break;
            case 'activity':
                this.observeComputeActivity(message.active);
                break;
            case 'tool_call':
                this.startWork(this.handleToolCall(message), true);
                break;
            case 'tool_consumed':
                this.consumeReply(message.requestId);
                break;
            case 'console':
                this.appendConsole(message.text, message.truncated === true);
                break;
            case 'limit_rejected':
                // The worker already answered the refused call; the program continues
                // and only the count reaches the outer result and its durable fact.
                this.refusedToolCalls += 1;
                break;
            case 'completed':
                this.completeGuest(message);
                break;
            case 'failed':
                this.failGuest(message);
                break;
        }
    };
    failGuest(message) {
        const pending = message.pendingRequestIds.length > 0;
        this.endGuest({
            status: failureStatus(message.error.code),
            error: message.error,
            childCalls: [],
            details: emptyDetails(),
            media: [],
            incomplete: pending,
        }, pending ? 'guest_finished_with_pending_calls' : undefined);
    }
    ignoreMessage(message) {
        // Console lines printed before a stop are still shown, like the facts of
        // children that settled before it.
        return (this.finished ||
            Boolean(this.stopReason && message.type !== 'activity' && message.type !== 'console'));
    }
    /** The Worker enforces the console budget; this host-side cap holds even if it did not. */
    appendConsole(text, truncated) {
        if (this.consoleTruncated)
            return;
        const bytes = new TextEncoder().encode(text).byteLength;
        const room = this.limits.maxConsoleBytes - this.consoleBytes;
        if (bytes > room) {
            this.consoleText += new TextDecoder().decode(new TextEncoder().encode(text).slice(0, Math.max(0, room)), { stream: true });
            this.consoleBytes = this.limits.maxConsoleBytes;
            this.consoleTruncated = true;
            return;
        }
        this.consoleText += text;
        this.consoleBytes += bytes;
        if (truncated)
            this.consoleTruncated = true;
    }
    /** Node event callbacks cannot await; retain and settle their actual async work. */
    startWork(operation, hostCall = false) {
        const work = {};
        const pending = (async () => {
            try {
                await operation;
            }
            catch (error) {
                this.onError(error);
            }
            finally {
                this.pendingWork.delete(work);
                this.pendingHostCalls.delete(work);
            }
        })();
        this.pendingWork.set(work, pending);
        if (hostCall)
            this.pendingHostCalls.set(work, pending);
    }
    startGuest() {
        this.worker.postMessage({
            type: 'start',
            code: this.input.code,
            toolNames: this.input.bridge.toolNames,
            limits: {
                maxHeapBytes: this.limits.maxHeapBytes,
                maxComputeMs: this.limits.maxComputeMs,
                maxToolCalls: this.limits.maxToolCalls,
                maxConsoleBytes: this.limits.maxConsoleBytes,
            },
        });
    }
    consumeReply(requestId) {
        const bytes = this.pendingReplyBytes.get(requestId);
        if (bytes === undefined)
            return;
        this.pendingReplyBytes.delete(requestId);
        this.pendingBridgeBytes -= bytes;
    }
    /**
     * A return value larger than the outer result is no longer an error: the
     * children already ran, so run_code shows its beginning with a note rather
     * than discarding all of it. Only values the bridge could carry are parsed
     * to validate them; larger ones are only ever shown as a text prefix.
     */
    completeGuest(message) {
        const pending = message.pendingRequestIds.length > 0;
        const reason = pending ? 'guest_finished_with_pending_calls' : undefined;
        const valueJson = typeof message.valueJson === 'string' ? message.valueJson : undefined;
        let value;
        if (valueJson !== undefined &&
            new TextEncoder().encode(valueJson).byteLength <= this.limits.maxBridgeMessageBytes) {
            try {
                value = JSON.parse(valueJson);
            }
            catch {
                this.endGuest(failed('guest_error', 'PTC returned invalid JSON.', pending), reason);
                return;
            }
        }
        this.endGuest({
            status: 'completed',
            value,
            ...(valueJson === undefined ? {} : { valueJson }),
            childCalls: [],
            details: emptyDetails(),
            media: [],
            incomplete: pending,
            ...returnValueDrops(message),
        }, reason);
    }
    endGuest(result, reason) {
        this.startWork(this.finishAfterDrain(result, reason));
    }
    async finishAfterDrain(result, reason) {
        this.acceptingCalls = false;
        if (reason) {
            this.stop(reason, result);
            return;
        }
        await this.input.bridge.stop('guest_finished_with_pending_calls');
        let drainTimer;
        try {
            await Promise.race([
                this.drainHostCalls(),
                new Promise((resolve) => {
                    drainTimer = setTimeout(resolve, this.limits.shutdownGraceMs);
                }),
            ]);
        }
        finally {
            clearTimeout(drainTimer);
        }
        this.markOutstandingUnknown();
        await this.finish(result);
    }
    async drainHostCalls() {
        await this.input.bridge.drain();
        // Scheduler drainage can precede the continuation that records the final facts.
        // Only invocation work belongs here; cleanup work would wait on itself.
        await Promise.all(this.pendingHostCalls.values());
    }
    async finish(result) {
        if (this.finished)
            return;
        this.finished = true;
        this.clearTimers();
        this.input.signal?.removeEventListener('abort', this.onExternalAbort);
        let finalResult = result;
        try {
            await this.worker.terminate();
        }
        catch (error) {
            finalResult = failed('worker_error', `PTC Worker termination failed: ${safeMessage(error)}`, true);
        }
        this.resolveResult(this.withDetails(finalResult));
    }
    stop(reason, plannedResult) {
        if (this.stopReason || this.finished)
            return;
        this.acceptingCalls = false;
        this.stopReason = reason;
        this.resultAfterGrace = plannedResult;
        this.controller.abort(reason);
        try {
            this.worker.postMessage({ type: 'stop', reason });
        }
        catch {
            // A stuck or exited guest is terminated independently below.
        }
        this.startWork(this.finishStoppedAfterDrain(reason));
        this.graceTimer = setTimeout(() => {
            this.markOutstandingUnknown();
            this.startWork(this.finish(this.resultAfterGrace ?? stoppedResult(reason)));
        }, this.limits.shutdownGraceMs);
    }
    async finishStoppedAfterDrain(reason) {
        await Promise.all([
            this.stopBridge(reason),
            this.terminateStoppedWorker(),
            this.drainHostCalls(),
        ]);
        this.markOutstandingUnknown();
        await this.finish(this.resultAfterGrace ?? stoppedResult(reason));
    }
    async stopBridge(reason) {
        try {
            await this.input.bridge.stop(reason);
        }
        catch (error) {
            this.resultAfterGrace ??= failed('worker_error', `PTC bridge cancellation failed: ${safeMessage(error)}`, true);
        }
    }
    async terminateStoppedWorker() {
        try {
            await this.worker.terminate();
        }
        catch (error) {
            this.resultAfterGrace ??= failed('worker_error', `PTC Worker termination failed: ${safeMessage(error)}`, true);
        }
    }
    onError = (error) => {
        if (this.finished || this.stopReason)
            return;
        this.endGuest(failed('worker_error', safeMessage(error), true), 'worker_error');
    };
    onExit = (code) => {
        if (this.finished || this.stopReason)
            return;
        this.endGuest(failed('worker_exit', `PTC Worker exited with code ${code}.`, true), 'worker_error');
    };
    async handleToolCall(message) {
        const initial = {
            requestId: message.requestId,
            name: message.name,
            state: 'accepted',
            retainedFacts: [],
        };
        this.childCalls.set(message.requestId, initial);
        let invocationSettled = false;
        try {
            const args = this.admitToolCall(message);
            if (args === REFUSED_BY_CALL_BUDGET) {
                // Never a child call: no record, no fact, nothing to mark unknown later.
                this.childCalls.delete(message.requestId);
                this.sendReply(message.requestId, JSON.stringify(ptcToolCallLimitRefusal(message.requestId, this.limits.maxToolCalls)));
                return;
            }
            const result = await this.input.bridge.invoke({
                requestId: message.requestId,
                name: message.name,
                args,
                signal: this.controller.signal,
            });
            const childToolCallId = result.record?.child_tool_call_id ?? this.provisionalChildIds.get(message.requestId);
            this.recordOutcome(message, result, childToolCallId);
            invocationSettled = true;
            const guestResult = guestResultFor(result, childToolCallId ?? message.requestId);
            const resultJson = this.serializeChildResult(message, guestResult, childToolCallId);
            this.sendReply(message.requestId, resultJson, childToolCallId ?? message.requestId);
        }
        catch (error) {
            if (!invocationSettled)
                this.childCalls.set(message.requestId, { ...initial, state: 'failed' });
            this.sendFailure(message.requestId, toToolFailure(error, this.provisionalChildIds.get(message.requestId) ?? message.requestId));
        }
    }
    admitToolCall(message) {
        if (!this.acceptingCalls || this.stopReason || this.controller.signal.aborted)
            throw new Error('PTC execution was stopped.');
        if (++this.toolCalls > this.limits.maxToolCalls) {
            // The worker refuses over-budget calls itself; this host-side count keeps
            // the budget in force even if a guest reaches the bridge another way.
            this.refusedToolCalls += 1;
            return REFUSED_BY_CALL_BUDGET;
        }
        if (new TextEncoder().encode(message.argsJson).byteLength > this.limits.maxBridgeMessageBytes) {
            this.recordBudgetExceeded('bridge');
            this.stop('bridge_limit_exceeded');
            throw new Error('PTC tool arguments exceed the bridge message limit.');
        }
        const args = parsePtcToolArgs(message.argsJson);
        const provisional = this.input.bridge.describe?.({
            requestId: message.requestId,
            name: message.name,
            args,
        });
        if (provisional) {
            this.persisted.set(provisional.child_tool_call_id, provisional);
            this.provisionalChildIds.set(message.requestId, provisional.child_tool_call_id);
        }
        return args;
    }
    recordOutcome(message, result, childToolCallId) {
        const facts = result.retainedFacts ? [...result.retainedFacts] : [];
        if (childToolCallId)
            this.addChildFacts(childToolCallId, facts);
        else
            this.globalFacts.push(...facts);
        this.recordMedia(message.requestId, result, childToolCallId);
        if (result.record)
            this.persisted.set(result.record.child_tool_call_id, result.record);
        this.childCalls.set(message.requestId, {
            requestId: message.requestId,
            name: message.name,
            state: childOutcomeState(result),
            retainedFacts: facts,
        });
    }
    recordMedia(requestId, result, childToolCallId) {
        if (!result.media)
            return;
        const entries = result.media.map((content) => ({
            childToolCallId: childToolCallId ?? requestId,
            content,
            refs: result.refs ?? [],
        }));
        if (!childToolCallId) {
            this.unownedMedia.push(...entries);
            return;
        }
        this.mediaByChild.set(childToolCallId, [
            ...(this.mediaByChild.get(childToolCallId) ?? []),
            ...entries,
        ]);
    }
    serializeChildResult(message, result, childToolCallId) {
        try {
            return serializePtcValue(result, this.limits.maxBridgeMessageBytes);
        }
        catch (error) {
            if (error instanceof PtcSerializationError && error.code === 'bridge_limit_exceeded') {
                // Child results are no longer cut to the model caps, so one can be
                // larger than a bridge message. The tool already ran: fail only this
                // call so the program can narrow its arguments, instead of stopping.
                return this.oversizedChildResult(childToolCallId ?? message.requestId, error.bytes);
            }
            const failure = {
                code: error instanceof PtcSerializationError ? error.code : 'invalid_tool_result',
                message: `PTC child result delivery failed: ${safeMessage(error)}`,
                toolCallId: childToolCallId ?? message.requestId,
            };
            this.recordDeliveryFailure(childToolCallId ?? message.requestId, failure);
            throw new PtcChildFailure(failure);
        }
    }
    oversizedChildResult(childToolCallId, bytes) {
        const size = bytes ?? this.limits.maxBridgeMessageBytes + 1;
        this.recordResultTooLarge(childToolCallId, size);
        return JSON.stringify(ptcResultTooLargeFailure(childToolCallId, size, this.limits.maxBridgeMessageBytes));
    }
    /** Fact, log count and largest size for a child result that was not delivered. */
    recordResultTooLarge(childToolCallId, bytes) {
        this.maxChildResultBytes = Math.max(this.maxChildResultBytes, bytes);
        this.oversizedChildren += 1;
        const fact = {
            kind: 'child_error',
            child_tool_call_id: childToolCallId,
            code: PTC_RESULT_TOO_LARGE,
        };
        if (this.persisted.has(childToolCallId))
            this.addChildFacts(childToolCallId, [fact]);
        else
            this.globalFacts.push(fact);
    }
    recordDeliveryFailure(childToolCallId, failure) {
        const fact = {
            kind: 'child_error',
            child_tool_call_id: childToolCallId,
            code: 'PTC_RESULT_DELIVERY_FAILED',
        };
        if (this.persisted.has(childToolCallId))
            this.addChildFacts(childToolCallId, [fact]);
        else
            this.globalFacts.push(fact);
        const reason = failure.code === 'bridge_limit_exceeded'
            ? 'bridge_limit_exceeded'
            : 'tool_result_delivery_failed';
        if (reason === 'bridge_limit_exceeded')
            this.recordBudgetExceeded('bridge');
        this.endGuest(failed(failure.code, failure.message, false), reason);
    }
    sendReply(requestId, resultJson, childToolCallId) {
        const bytes = new TextEncoder().encode(resultJson).byteLength;
        if (this.pendingBridgeBytes + bytes > this.limits.maxBridgeResultBytes) {
            // The Worker has not taken earlier results yet (parallel large calls
            // while the guest is busy). Fail only this call, uncounted, and keep the
            // program running; a call-budget refusal is tiny and goes as it is.
            this.postReply(requestId, childToolCallId === undefined
                ? resultJson
                : this.unconsumedResultsTooLarge(childToolCallId, bytes));
            return;
        }
        this.pendingReplyBytes.set(requestId, bytes);
        this.pendingBridgeBytes += bytes;
        this.maxChildResultBytes = Math.max(this.maxChildResultBytes, bytes);
        this.postReply(requestId, resultJson);
    }
    unconsumedResultsTooLarge(childToolCallId, bytes) {
        this.recordResultTooLarge(childToolCallId, bytes);
        return JSON.stringify(ptcUnconsumedResultsTooLargeFailure(childToolCallId, bytes, this.pendingBridgeBytes, this.limits.maxBridgeResultBytes));
    }
    postReply(requestId, resultJson) {
        if (!this.acceptingCalls || this.finished || this.stopReason)
            return;
        this.worker.postMessage({ type: 'tool_result', requestId, resultJson });
    }
    sendFailure(requestId, failure) {
        if (!this.acceptingCalls || this.finished || this.stopReason)
            return;
        try {
            this.worker.postMessage({ type: 'tool_result', requestId, error: failure });
        }
        catch {
            // Termination may race a rejected child. Admission has already stopped.
        }
    }
    observeComputeActivity(active) {
        if (this.finished || this.stopReason)
            return;
        if (active) {
            if (this.computeStartedAtMs !== undefined)
                return;
            this.computeStartedAtMs = performance.now();
            this.computeTimer = setTimeout(() => this.stop('compute_budget_exceeded'), Math.max(0, this.limits.maxComputeMs - this.computeElapsedMs));
            return;
        }
        if (this.computeStartedAtMs === undefined)
            return;
        this.computeElapsedMs += performance.now() - this.computeStartedAtMs;
        this.computeStartedAtMs = undefined;
        clearTimeout(this.computeTimer);
        this.computeTimer = undefined;
        if (this.computeElapsedMs >= this.limits.maxComputeMs)
            this.stop('compute_budget_exceeded');
    }
    markOutstandingUnknown() {
        for (const [requestId, call] of this.childCalls) {
            if (call.state !== 'accepted')
                continue;
            this.childCalls.set(requestId, { ...call, state: 'unknown' });
            const childToolCallId = this.provisionalChildIds.get(requestId);
            if (!childToolCallId)
                continue;
            const record = this.persisted.get(childToolCallId);
            if (record)
                this.persisted.set(childToolCallId, {
                    ...record,
                    status: 'unknown',
                    outcome_unknown: true,
                });
            if (!(this.childFacts.get(childToolCallId) ?? []).some((fact) => fact.kind === 'outcome_unknown')) {
                this.addChildFacts(childToolCallId, [
                    { kind: 'outcome_unknown', child_tool_call_id: childToolCallId },
                ]);
            }
        }
    }
    recordBudgetExceeded(budget) {
        if (!this.globalFacts.some((fact) => fact.kind === 'budget_exceeded' && fact.budget === budget))
            this.globalFacts.push({ kind: 'budget_exceeded', budget });
    }
    addChildFacts(childToolCallId, facts) {
        if (facts.length > 0)
            this.childFacts.set(childToolCallId, [
                ...(this.childFacts.get(childToolCallId) ?? []),
                ...facts,
            ]);
    }
    withDetails(result) {
        const childIds = [...this.persisted.keys()];
        // Refusals no longer stop the program, so the durable budget fact carries
        // how many calls were refused; older facts without the count meant "stopped".
        const refusalFacts = this.refusedToolCalls > 0
            ? [{ kind: 'budget_exceeded', budget: 'tool_calls', refused_calls: this.refusedToolCalls }]
            : [];
        return {
            ...result,
            refusedToolCalls: this.refusedToolCalls,
            maxChildResultBytes: this.maxChildResultBytes,
            oversizedChildren: this.oversizedChildren,
            ...(this.consoleBytes > 0 || this.consoleTruncated
                ? {
                    console: {
                        text: this.consoleText,
                        bytes: this.consoleBytes,
                        truncated: this.consoleTruncated,
                    },
                }
                : {}),
            childCalls: [...this.childCalls.values()],
            details: {
                version: 1,
                child_calls: [...this.persisted.values()].map((record) => ({
                    ...record,
                    input: { ...record.input },
                })),
                retained_facts: [
                    ...childIds.flatMap((id) => this.childFacts.get(id) ?? []),
                    ...this.globalFacts,
                    ...refusalFacts,
                ].map((fact) => ({ ...fact })),
            },
            media: [...childIds.flatMap((id) => this.mediaByChild.get(id) ?? []), ...this.unownedMedia],
        };
    }
    clearTimers() {
        clearTimeout(this.wallTimer);
        clearTimeout(this.computeTimer);
        clearTimeout(this.graceTimer);
    }
}
function createNodePtcWorker(url) {
    return new Worker(url, {
        execArgv: process.execArgv.filter((argument) => !argument.startsWith('--input-type')),
    });
}
function emptyDetails() {
    return { version: 1, child_calls: [], retained_facts: [] };
}
function failed(code, message, incomplete, retainedFacts = []) {
    return {
        status: failureStatus(code),
        error: { code, message },
        childCalls: [],
        details: { version: 1, child_calls: [], retained_facts: retainedFacts },
        media: [],
        incomplete,
    };
}
function failureStatus(code) {
    if (code === 'cancelled')
        return 'cancelled';
    if (code === 'compute_budget_exceeded' || code === 'wall_clock_exceeded')
        return 'timed_out';
    return 'failed';
}
function stoppedResult(reason) {
    if (reason === 'cancelled')
        return failed('cancelled', 'PTC execution was cancelled.', true);
    return failed(reason, `PTC stopped: ${reason}.`, true);
}
const REFUSED_BY_CALL_BUDGET = Symbol('refused-by-call-budget');
/**
 * The guest payload of one settled child. A tool failure resolves with
 * `isError: true` and an `error` object instead of rejecting, so one failing
 * call inside Promise.all no longer discards its siblings. `isError` is always
 * present and always the host's verdict. Only a settled call that produced no
 * guest payload at all (an internal error) still rejects.
 */
function guestResultFor(result, toolCallId) {
    const isFailure = result.isError === true ||
        result.record?.status === 'failed' ||
        result.record?.status === 'unknown';
    if (result.result === undefined) {
        if (!isFailure) {
            throw new PtcChildFailure({
                code: 'invalid_tool_result',
                message: 'PTC child call did not produce a completed guest result.',
            });
        }
        return {
            status: 'failed',
            isError: true,
            truncation: { truncated: 'unknown' },
            error: guestError(result.error, toolCallId),
        };
    }
    if (!isRecord(result.result))
        return result.result;
    const projected = result.result;
    const rest = Object.fromEntries(Object.entries(projected).filter(([key]) => key !== 'status' && key !== 'isError' && key !== 'error'));
    // status and isError come from this one verdict, so "failed" is exactly isError.
    return {
        status: isFailure ? 'failed' : completedGuestStatus(projected.status),
        isError: isFailure,
        ...rest,
        ...(isFailure
            ? {
                error: isRecord(projected.error) ? projected.error : guestError(result.error, toolCallId),
            }
            : {}),
    };
}
/** The projection's status of a completed call; an unrecognised one cannot claim completeness. */
function completedGuestStatus(status) {
    return status === 'complete' ||
        status === 'truncated' ||
        status === 'resized' ||
        status === 'omitted'
        ? status
        : 'unverified';
}
function guestError(error, toolCallId) {
    return {
        code: error?.code ?? 'PTC_TOOL_FAILED',
        message: error?.message ?? 'Tool execution failed.',
        ...(error?.retryable === undefined ? {} : { retryable: error.retryable }),
        toolCallId: error?.toolCallId ?? toolCallId,
    };
}
function returnValueDrops(message) {
    const paths = Array.isArray(message.droppedUndefinedPaths)
        ? message.droppedUndefinedPaths.filter((path) => typeof path === 'string')
        : [];
    const count = typeof message.droppedUndefinedCount === 'number' &&
        Number.isSafeInteger(message.droppedUndefinedCount)
        ? Math.max(message.droppedUndefinedCount, paths.length)
        : paths.length;
    return count > 0 ? { droppedUndefinedPaths: paths, droppedUndefinedCount: count } : {};
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function childOutcomeState(result) {
    if (result.record?.status === 'unknown')
        return 'unknown';
    if (result.record?.status === 'failed')
        return 'failed';
    return 'completed';
}
function toToolFailure(error, toolCallId) {
    if (error instanceof PtcChildFailure)
        return error.failure;
    const message = safeMessage(error);
    return { code: toolFailureCode(message), message, toolCallId };
}
function toolFailureCode(message) {
    if (message.includes('bridge message limit'))
        return 'bridge_limit_exceeded';
    if (message.includes('call limit'))
        return 'tool_call_limit_exceeded';
    if (message.includes('stopped') || message.includes('cancelled'))
        return 'cancelled';
    return 'invalid_tool_call';
}
class PtcChildFailure extends Error {
    failure;
    constructor(failure) {
        super(failure.message);
        this.failure = failure;
        this.name = 'PtcChildFailure';
    }
}
function safeMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
//# sourceMappingURL=quickjs-executor.js.map