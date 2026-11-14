import { isPtcMavisChildToolName } from '@mavis/agent-tools';
import { reportPtcStoreMetrics } from '../observability/ptc-store-metrics.js';
import { ptcScriptInvocation } from '../../execution/ptc/contracts.js';
/**
 * Classifies one settled child from its guest-facing result; never reads payloads.
 * `aborted` means the child settled after its Turn was cancelled or its program
 * was stopped. A child cut off mid-run then reports whatever its tool threw
 * (a killed Bash gives PTC_TOOL_EXECUTION_FAILED), so without this the user's
 * own stop would show up as a failing tool. A denial and the batch deadline
 * keep their own status. `blocked` is a child a host guard refused before it
 * ran (PTC_TOOL_BLOCKED, e.g. BROWSER_PTC_STOPPED or COMPUTER_USE_PTC_STOPPED
 * after an earlier call of the program failed); counting it as `error` would
 * report a tool failure for a call that never executed.
 */
export function ptcChildCallStatus(result, aborted = false) {
    if (result.isError !== true)
        return 'ok';
    switch (result.error?.code) {
        case 'PTC_PERMISSION_DENIED':
            return 'denied';
        case 'PTC_CANCELLED':
        case 'PTC_ABORTED':
            return 'cancelled';
        case 'PTC_BATCH_EXPIRED':
            return 'limit_exceeded';
        case 'PTC_TOOL_BLOCKED':
            return 'blocked';
        default:
            return aborted ? 'cancelled' : 'error';
    }
}
/** A finished program as the Turn observer counts it. */
function ptcProgramOutcome(result, durationMs, source = 'inline') {
    const completed = result.status === 'completed';
    return {
        status: completed ? 'ok' : 'error',
        errorCode: completed ? 'none' : result.error.code,
        durationMs,
        childCalls: result.details.child_calls.length,
        storeWrites: result.storeWrites?.keys.length ?? 0,
        storeLoads: result.storeLoads ?? 0,
        source,
    };
}
/** A run_code call that ran a saved script; every other one ran its own code. */
export function ptcRunCodeSource(args, scriptsEnabled) {
    // With saved scripts switched off, no call can have run one: `prepareArguments`
    // leaves a `path` alone, so a call that carried both `code` and `path` runs its
    // own program and must not be counted as a script run.
    if (!scriptsEnabled)
        return 'inline';
    // A call carrying a real `path` together with `code` is refused
    // (run-code-description.ts), so a script invocation here is always a call
    // that really ran the script. The rule itself lives in contracts.ts, shared
    // with the expander that acts on it.
    return ptcScriptInvocation(args).kind === 'script' ? 'path' : 'inline';
}
/**
 * Reports what one finished program did. The script loads go first, so a
 * failed program's `import()` attempts still reach the metric.
 */
export function reportPtcProgramFinished(observer, result, durationMs, 
/** From `ptcRunCodeSource`; the caller knows whether scripts are on. */
source) {
    for (const load of result.scriptLoads ?? [])
        observer?.scriptLoaded(load.scope, load.status);
    observer?.programFinished(ptcProgramOutcome(result, durationMs, source));
}
/**
 * A run_code call refused before any program ran (no Worker, no children).
 *
 * @internal Exported for tests; run_code logs it through logRunCodeRejected.
 */
export function ptcRejectedProgram(errorCode) {
    return {
        status: 'error',
        errorCode,
        durationMs: 0,
        childCalls: 0,
        storeWrites: 0,
        storeLoads: 0,
        source: 'inline',
    };
}
/** Program failure codes of the QuickJS executor (`PtcFailureCode`), reported as is. */
const PROGRAM_ERROR_LABELS = new Set([
    'guest_error',
    'wall_clock_exceeded',
    'compute_budget_exceeded',
    'cancelled',
    'worker_error',
    'worker_exit',
    'invalid_code',
    'invalid_tool_call',
    'invalid_tool_result',
    'bridge_limit_exceeded',
    'tool_call_limit_exceeded',
    'tool_result_delivery_failed',
    'guest_finished_with_pending_calls',
]);
/** run_code admission refusals (no program ran). */
const REJECTION_LABELS = {
    PTC_UNAVAILABLE: 'unavailable',
    PTC_PREVIOUS_CALL_PENDING: 'previous_call_pending',
    PTC_BATCH_EXPIRED: 'batch_expired',
};
/** Bounded `error_code` label: known codes as is, anything new as `other`. */
function programErrorLabel(code) {
    if (code === 'none' || PROGRAM_ERROR_LABELS.has(code))
        return code;
    return REJECTION_LABELS[code] ?? 'other';
}
/** Built-in tools whose names are reported as the metric `tool` label. */
const BUILTIN_TOOL_LABELS = new Set([
    'read',
    'write',
    'edit',
    'delete',
    'bash',
    'grep',
    'glob',
    'todowrite',
    'web_fetch',
    'web_search',
    'task',
    'task_append',
    'task_query',
    'task_output',
    'task_stop',
    'mcp_invoke',
    'mavis',
    'self_reminder',
    'workspace_semantic_search',
]);
/**
 * Metric `tool` label for this Turn: listed built-ins by name, the Turn's MCP
 * and App tools (from their capability bindings, or the `mcp__` prefix) as
 * `mcp` / `app`, Browser (`browser`, `mcp_browser`) as `browser`, every
 * `computer_*` action as `computer_use`, the mavis_* run_code tools as `mavis`
 * (each is one mavis command, the same tool as the top-level mavis),
 * everything else as `other`. MCP and App tool names, Computer Use actions
 * and mavis commands never reach a label, which also keeps the label set small.
 */
export function createPtcToolLabeler(bindings = []) {
    const kindByName = new Map(bindings.map((binding) => [binding.tool.def.name, binding.kind]));
    return (toolName) => {
        const kind = kindByName.get(toolName);
        if (kind === 'app')
            return 'app';
        if (kind === 'mcp' || toolName.startsWith('mcp__'))
            return 'mcp';
        if (toolName === 'browser' || toolName === 'mcp_browser')
            return 'browser';
        if (toolName.startsWith('computer_'))
            return 'computer_use';
        if (isPtcMavisChildToolName(toolName))
            return 'mavis';
        return BUILTIN_TOOL_LABELS.has(toolName) ? toolName : 'other';
    };
}
/**
 * Per-Turn accumulator behind `ptc turn summary`, created only on PTC Turns.
 * The per-program line answers "what did this program do"; the summary
 * answers "how did PTC go for this Turn" (programs, failures, denied
 * children, direct calls of hidden tools) without adding up lines by hand.
 * The same calls report the per-program, per-child and per-direct-call
 * metrics, so local lines and remote counts follow one definition.
 */
export function createPtcTurnObserver(options) {
    const metrics = options.metricsClient;
    const surface = options.surface ?? 'other';
    const scriptCaller = options.scriptCaller ?? 'root';
    const labelTool = options.labelTool ?? createPtcToolLabeler();
    const summary = {
        programs: 0,
        programs_failed: 0,
        child_calls: 0,
        child_failures: 0,
        child_denied: 0,
        direct_calls: 0,
        direct_sr_appended: 0,
        store_writes: 0,
        store_loads: 0,
        wall_clock_exceeded: 0,
        program_ms_total: 0,
        script_loads: 0,
        script_load_failures: 0,
        script_saves: 0,
    };
    const directCallValid = new Map();
    let finished = false;
    return {
        programFinished(outcome) {
            const durationMs = nonNegativeMs(outcome.durationMs);
            summary.programs += 1;
            if (outcome.status !== 'ok')
                summary.programs_failed += 1;
            if (outcome.errorCode === 'wall_clock_exceeded')
                summary.wall_clock_exceeded += 1;
            summary.child_calls += outcome.childCalls;
            summary.store_writes += outcome.storeWrites ?? 0;
            summary.store_loads += outcome.storeLoads ?? 0;
            summary.program_ms_total += durationMs;
            // Failure rate and causes, run time and children per program.
            report(() => {
                const status = outcome.status;
                const error_code = programErrorLabel(outcome.errorCode);
                const source = outcome.source;
                metrics?.counter('ptc_run_code_total', 1, { status, error_code, surface, source });
                metrics?.histogram('ptc_run_code_duration_ms', durationMs, { status });
                metrics?.histogram('ptc_run_code_child_calls', outcome.childCalls, { status });
                // Registered metrics: reported through the typed API, which lives
                // outside runner/ptc because this directory's dependencies are bounded.
                reportPtcStoreMetrics(metrics, { writes: outcome.storeWrites ?? 0, loads: outcome.storeLoads ?? 0 }, surface);
            });
        },
        childCallSettled(toolName, status) {
            if (status !== 'ok')
                summary.child_failures += 1;
            if (status === 'denied')
                summary.child_denied += 1;
            // Which tools programs use most and which fail.
            report(() => metrics?.counter('ptc_child_call_total', 1, { tool: labelTool(toolName), status }));
        },
        scriptLoaded(scope, status) {
            if (status === 'ok')
                summary.script_loads += 1;
            else
                summary.script_load_failures += 1;
            // Are saved scripts reused at all, and how often a load is refused.
            report(() => metrics?.counter('ptc_script_load_total', 1, { scope, status }));
        },
        scriptSaved(scope, status) {
            if (status === 'ok')
                summary.script_saves += 1;
            // How often the model saves, to which level, and how much of it is a subagent.
            report(() => metrics?.counter('ptc_script_save_total', 1, { scope, status, caller: scriptCaller }));
        },
        directCallResolved(toolCallId, valid) {
            summary.direct_calls += 1;
            directCallValid.set(toolCallId, valid);
        },
        directCallSettled(toolName, toolCallId, appended) {
            if (appended)
                summary.direct_sr_appended += 1;
            const valid = directCallValid.get(toolCallId) !== false;
            directCallValid.delete(toolCallId);
            // How often the model still calls hidden tools directly, and the reminder it gets.
            report(() => metrics?.counter('ptc_direct_call_total', 1, {
                tool: labelTool(toolName),
                sr: appended ? 'appended' : 'not_appended',
                validation: valid ? 'ok' : 'failed',
            }));
        },
        finishTurn() {
            if (finished)
                return;
            finished = true;
            writeLog(options.logger, 'ptc turn summary', {
                session_id: options.sessionId,
                turn_id: options.turnId,
                ...summary,
            });
            // Programs per PTC Turn, including Turns that never wrote one.
            report(() => metrics?.histogram('ptc_turn_programs', summary.programs, { surface }));
        },
    };
}
/**
 * Child-output fields of the `ptc run_code finished` line. Children skip the
 * model-visible output caps and only the return value is cut (agent-tools
 * isPtcChildCall), so these show how often that mattered: children a direct
 * call would have cut, the largest serialized child result, children over the
 * per-call bridge limit (PTC_RESULT_TOO_LARGE) and whether the return value
 * was saved to a file. Counts and a flag only; never arguments, content or
 * file paths.
 */
export function ptcChildOutputFields(result, uncappedChildren, returnSpilled) {
    return {
        uncapped_children: uncappedChildren,
        max_child_result_bytes: result.maxChildResultBytes ?? 0,
        oversized_children: result.oversizedChildren ?? 0,
        return_spilled: returnSpilled,
    };
}
/**
 * `store` / `load` fields of the `ptc run_code finished` line: how much this
 * program persisted, how often it read a value back, how many writes the host
 * refused and how large the Session's store file has become. Counts, keys and
 * byte totals only; a stored value never reaches a log line.
 */
function ptcStoreFields(result, sessionBytes) {
    const writes = result.storeWrites;
    return {
        store_writes: writes?.keys.length ?? 0,
        ...(writes && writes.keys.length > 0 ? { store_keys: [...writes.keys] } : {}),
        store_write_bytes: writes?.bytes ?? 0,
        store_loads: result.storeLoads ?? 0,
        store_rejected: result.storeRejected ?? 0,
        ...(sessionBytes === undefined ? {} : { store_session_bytes: sessionBytes }),
    };
}
/**
 * Display-preview fields of the `ptc run_code finished` line, read from the
 * host preview once per program. A Turn whose host wires no preview, or a
 * program none of whose children were shortened, reports zeros.
 */
function ptcChildDisplayFields(read, parentToolCallId) {
    const stats = read?.(parentToolCallId);
    return {
        display_preview_children: stats?.previewChildren ?? 0,
        display_spill_failed: stats?.spillFailed ?? 0,
        max_child_display_original_bytes: stats?.maxOriginalBytes ?? 0,
    };
}
/**
 * `timeout_ms` is the resolved request (default, as given, or capped);
 * `wall_clock_ms` is what the program actually had, which is less when an
 * earlier run_code in the same response used part of the shared deadline and
 * more when a foreground Bash child's long timeout extended it.
 */
function ptcTimeoutLogFields(wallClock, wallClockMs) {
    return {
        timeout_ms: wallClock.ms,
        timeout_ms_source: wallClock.source,
        timeout_ms_capped: wallClock.source === 'capped',
        ...(wallClockMs === undefined ? {} : { wall_clock_ms: Math.round(wallClockMs) }),
    };
}
/** Failure code or the incomplete flag; never guest messages, which may echo code. */
function ptcProgramOutcomeFields(result) {
    if (result.status !== 'completed')
        return { error_code: result.error.code };
    return result.incomplete ? { incomplete: true } : {};
}
/**
 * Aggregate child timing for the `ptc run_code finished` line, so a slow
 * program can be split into "one slow child", "children waiting for a slot"
 * or "little parallelism" without one log line per child.
 */
export function createPtcProgramTiming(now = Date.now) {
    const queuedAt = new Map();
    let inFlight = 0;
    let maxConcurrency = 0;
    let childMsMax = 0;
    let childMsTotal = 0;
    let queueWaitMsMax = 0;
    return {
        queued(requestId) {
            queuedAt.set(requestId, now());
        },
        async run(requestId, task) {
            const startedAt = now();
            const enqueuedAt = queuedAt.get(requestId);
            queuedAt.delete(requestId);
            if (enqueuedAt !== undefined)
                queueWaitMsMax = Math.max(queueWaitMsMax, nonNegativeMs(startedAt - enqueuedAt));
            inFlight += 1;
            maxConcurrency = Math.max(maxConcurrency, inFlight);
            try {
                return await task();
            }
            finally {
                inFlight -= 1;
                const childMs = nonNegativeMs(now() - startedAt);
                childMsMax = Math.max(childMsMax, childMs);
                childMsTotal += childMs;
            }
        },
        fields() {
            return {
                child_ms_max: childMsMax,
                child_ms_total: childMsTotal,
                queue_wait_ms_max: queueWaitMsMax,
                max_concurrency: maxConcurrency,
            };
        },
    };
}
/**
 * Maps one final `permission.enforcement` decision to the user-facing outcome.
 * Policy and Plugin auto-approvals asked nobody and are skipped. Every
 * blocked child is `deny`: a user denial, a Mini App denial and a policy
 * block all fail only that child, and the program keeps running.
 */
function ptcChildPermissionDecision(fields) {
    if (fields.gate_result === 'proceed')
        return fields.decision_source === 'user_reply' ? 'allow' : undefined;
    if (fields.gate_result !== 'blocked')
        return undefined;
    return 'deny';
}
/**
 * `ptc child permission` and `ptc_child_permission_total`: which child asked
 * and what the user (or policy) decided. Only run_code children carry
 * `parentToolCallId`, so ordinary Turns never reach either write.
 */
export function observePtcChildPermission(sinks, input, request, fields) {
    try {
        const parentToolCallId = input.toolContext?.parentToolCallId;
        if (!parentToolCallId)
            return;
        // A pending ask closed by a cancelled Turn or program was never answered.
        if (fields.decision_source === 'approval_or_abort' && input.signal?.aborted === true)
            return;
        const decision = ptcChildPermissionDecision(fields);
        if (!decision)
            return;
        writeLog(sinks.logger, 'ptc child permission', {
            session_id: input.sessionId,
            turn_id: input.turnId,
            tool: request.toolName,
            decision,
            decision_source: fields.decision_source,
            tool_call_id: request.toolCallId,
            parent_tool_call_id: parentToolCallId,
        });
        report(() => sinks.metricsClient?.counter('ptc_child_permission_total', 1, { decision }));
    }
    catch {
        // Diagnostics must not change the permission decision.
    }
}
export function writeLog(logger, message, fields) {
    try {
        logger?.info?.(fields, message);
    }
    catch {
        // Diagnostics must not affect the Turn.
    }
}
/** Metrics must not change or mask the product-path outcome. */
export function report(write) {
    try {
        write();
    }
    catch {
        // Same contract as the runner's other metrics.
    }
}
function nonNegativeMs(value) {
    return Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}
/** Admission failures also end a run_code call; record why no program ran. */
export function logRunCodeRejected(context, parentToolCallId, code, wallClock) {
    writeRunCodeLog(context, {
        parent_tool_call_id: parentToolCallId ?? null,
        program_status: 'rejected',
        error_code: code,
        child_calls: 0,
        ...ptcTimeoutLogFields(wallClock),
    });
    context.ptcObserver?.programFinished(ptcRejectedProgram(code));
}
/**
 * One line per finished program so every outer hint can be traced to its
 * rule: completeness classes with reason codes, failed children with their
 * host error codes, refused calls and dropped return fields. Child arguments,
 * outputs and raw third-party errors are never logged.
 */
export function logRunCodeFinished(context, parentToolCallId, result, children) {
    const { verdicts, failures, returnTruncated, wallClock, wallClockMs, admissionWaitMs } = children;
    const truncated = [];
    const unknown = [];
    const completeTools = [];
    const skipped = [];
    for (const call of result.details.child_calls) {
        // A call that never returned an outcome (budget stop, cancellation) has no verdict.
        const verdict = verdicts.get(call.child_tool_call_id) ?? {
            state: 'skipped',
            reason: 'not_completed',
        };
        const child = { child_tool_call_id: call.child_tool_call_id, tool: call.tool_name };
        if (verdict.state === 'truncated')
            truncated.push(child);
        else if (verdict.state === 'complete')
            completeTools.push(call.tool_name);
        else if (verdict.state === 'unknown')
            unknown.push({ ...child, reason: verdict.reason });
        else
            skipped.push({ ...child, reason: verdict.reason });
    }
    const failed = [...failures.entries()].map(([childToolCallId, failure]) => ({
        child_tool_call_id: childToolCallId,
        tool: failure.tool,
        code: failure.code,
    }));
    writeRunCodeLog(context, {
        parent_tool_call_id: parentToolCallId,
        program_status: result.status,
        ...ptcProgramOutcomeFields(result),
        child_calls: result.details.child_calls.length,
        truncated_count: truncated.length,
        truncated,
        unknown_count: unknown.length,
        unknown,
        complete_count: completeTools.length,
        complete_tools: completeTools,
        skipped_count: skipped.length,
        skipped,
        failed_count: failed.length,
        failed,
        refused_calls: result.refusedToolCalls ?? 0,
        dropped_undefined_fields: result.status === 'completed' ? (result.droppedUndefinedCount ?? 0) : 0,
        console_bytes: result.console?.bytes ?? 0,
        console_truncated: result.console?.truncated === true,
        return_truncated: returnTruncated,
        ...children.childOutput,
        ...ptcStoreFields(result, children.storeBytes),
        ...ptcChildDisplayFields(context.ptcChildDisplayStats, parentToolCallId),
        ...ptcTimeoutLogFields(wallClock, wallClockMs),
        admission_wait_ms: Math.round(admissionWaitMs),
        ...children.timing,
    });
}
function writeRunCodeLog(context, fields) {
    try {
        context.ptcLogger?.info?.({ session_id: context.sessionId, turn_id: context.turnId, ...fields }, 'ptc run_code finished');
    }
    catch {
        // Diagnostics must not change the run_code result.
    }
}
/** Child-level decisions that change what the guest receives (never payload content). */
export function writeRunCodeEvent(context, parentToolCallId, event, fields) {
    try {
        context.ptcLogger?.info?.({
            session_id: context.sessionId,
            turn_id: context.turnId,
            parent_tool_call_id: parentToolCallId,
            ...fields,
        }, event);
    }
    catch {
        // Diagnostics must not change the run_code result.
    }
}
//# sourceMappingURL=ptc-observability.js.map