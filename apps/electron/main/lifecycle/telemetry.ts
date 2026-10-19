import { REQUIRED_LIFECYCLE_MODULES } from "./application-modules";
const lifecycleOwners = new Set(REQUIRED_LIFECYCLE_MODULES);
const RENDERER_REASON_CLASSES = new Set([
    'clean-exit',
    'abnormal-exit',
    'killed',
    'crashed',
    'oom',
    'launch-failed',
    'integrity-failure',
    'unresponsive',
    'resume-health-failure',
]);
function safeOwner(owner) {
    if (!owner)
        return 'none';
    return lifecycleOwners.has(owner) ? owner : 'other';
}
function snake(value) {
    return value.replace(/-/g, '_');
}
function rendererReason(reason) {
    return RENDERER_REASON_CLASSES.has(reason) ? snake(reason) : 'other';
}
function rendererKind(kind) {
    switch (kind) {
        case 'render-process-gone':
            return 'render_process_gone';
        case 'resume-health-failure':
            return 'resume_health_failure';
        case 'unresponsive':
            return 'unresponsive';
    }
}
function phaseName(phase) {
    if (phase === 'beforeReady')
        return 'before_ready';
    if (phase === 'whenReady')
        return 'when_ready';
    return 'none';
}
function intentName(intent) {
    return snake(intent);
}
function cleanupCounts(observation) {
    const summary = observation.cleanupSummary;
    if (!summary) {
        return { available: false, failed: 0, timedOut: 0, firstProblemOwner: 'none' };
    }
    const failed = summary.results.filter((result) => result.status === 'failed').length;
    const timedOut = summary.results.filter((result) => result.status === 'timed-out').length;
    const firstResultProblem = summary.results.find((result) => result.status !== 'disposed');
    const firstProblemOwner = firstResultProblem?.name ??
        summary.unfinishedInitOwners[0] ??
        summary.unfinishedDisposeOwners[0] ??
        'none';
    return {
        available: true,
        failed,
        timedOut,
        firstProblemOwner: safeOwner(firstProblemOwner),
    };
}
function safeEnqueue(sink, eventName, payload) {
    try {
        sink.enqueue(eventName, payload);
    }
    catch {
        // Observability is deliberately fail-open: it must not affect lifecycle control.
    }
}
/** Owners are ranked by cost so a slow stage is visible without reading every entry. */
const SLOW_OWNER_REPORT_LIMIT = 5;
function slowestOwners(results) {
    return [...results]
        .sort((left, right) => right.durationMs - left.durationMs)
        .slice(0, SLOW_OWNER_REPORT_LIMIT)
        .map((result) => ({
        name: result.name,
        status: result.status,
        duration_ms: result.durationMs,
    }));
}
function safeLog(logger, fields, message) {
    try {
        logger?.info(fields, message);
    }
    catch {
        // Diagnostics are fail-open: they must not affect lifecycle control.
    }
}
export function createElectronLifecycleTelemetry(sink, logger) {
    return {
        observeStartup(observation) {
            const failed = observation.results.filter((result) => result.status === 'failed');
            const blocked = observation.results.filter((result) => result.status === 'blocked');
            const firstProblem = observation.results.find((result) => result.status !== 'initialized');
            const outcome = observation.outcome === 'ready' && (failed.length > 0 || blocked.length > 0)
                ? 'ready_degraded'
                : observation.outcome === 'aborted-by-quit'
                    ? 'aborted_by_quit'
                    : observation.outcome;
            safeEnqueue(sink, 'app.lifecycle_startup_summary', {
                outcome,
                duration_ms: observation.durationMs,
                failed_count: failed.length,
                blocked_count: blocked.length,
                first_problem_owner: safeOwner(firstProblem?.name),
                ...(firstProblem
                    ? {
                        first_problem_phase: phaseName(firstProblem.phase),
                        first_problem_status: firstProblem.status,
                    }
                    : {}),
            });
            safeLog(logger, {
                outcome,
                duration_ms: observation.durationMs,
                owner_count: observation.results.length,
                failed_count: failed.length,
                blocked_count: blocked.length,
                slowest_owners: slowestOwners(observation.results.map((result) => ({
                    name: result.name,
                    status: result.status,
                    durationMs: result.durationMs,
                }))),
            }, '[Lifecycle] Startup timings');
        },
        observeShutdown(observation) {
            const counts = cleanupCounts(observation);
            const summary = observation.cleanupSummary;
            safeEnqueue(sink, 'app.lifecycle_shutdown_summary', {
                intent: intentName(observation.intent),
                plan_kind: observation.plan.kind,
                cleanup_outcome: observation.cleanupOutcome,
                terminal_outcome: observation.terminalOutcome,
                renderer_ack: snake(observation.rendererAck),
                duration_ms: observation.durationMs,
                cleanup_summary_available: counts.available,
                ...(counts.available
                    ? {
                        failed_owner_count: counts.failed,
                        timed_out_owner_count: counts.timedOut,
                        first_problem_owner: counts.firstProblemOwner,
                        unfinished_init_owner_count: summary?.unfinishedInitOwners.length ?? 0,
                        unfinished_dispose_owner_count: summary?.unfinishedDisposeOwners.length ?? 0,
                    }
                    : {}),
                aborted: observation.cleanupOutcome === 'cutoff' || summary?.aborted === true,
            });
            safeLog(logger, {
                intent: intentName(observation.intent),
                plan_kind: observation.plan.kind,
                cleanup_outcome: observation.cleanupOutcome,
                terminal_outcome: observation.terminalOutcome,
                renderer_ack: snake(observation.rendererAck),
                duration_ms: observation.durationMs,
                ...(observation.phases?.rendererAckMs === undefined
                    ? {}
                    : { renderer_ack_ms: observation.phases.rendererAckMs }),
                ...(observation.phases?.cleanupMs === undefined
                    ? {}
                    : { cleanup_ms: observation.phases.cleanupMs }),
                ...(summary
                    ? {
                        owner_count: summary.results.length,
                        slowest_owners: slowestOwners(summary.results),
                    }
                    : { cleanup_summary_available: false }),
            }, '[Lifecycle] Shutdown timings');
        },
        observeInstallerHandoff(observation) {
            safeEnqueue(sink, 'app.lifecycle_installer_handoff', {
                outcome: observation.outcome,
                duration_ms: observation.durationMs,
            });
            safeLog(logger, { outcome: observation.outcome, duration_ms: observation.durationMs }, '[Lifecycle] Installer handoff');
        },
        observeRendererIncident(observation) {
            safeEnqueue(sink, 'app.renderer_incident', {
                incident_kind: rendererKind(observation.incident.kind),
                reason_class: rendererReason(observation.incident.reason),
                handling: snake(observation.handling),
                repeat_within_window: observation.repeatWithinWindow,
            });
        },
        observeRecoveryResult(observation) {
            safeEnqueue(sink, 'app.renderer_recovery', {
                action: observation.action,
                outcome: observation.outcome,
                duration_ms: observation.durationMs,
                incident_kind: rendererKind(observation.incident.kind),
                reason_class: rendererReason(observation.incident.reason),
            });
        },
    };
}
