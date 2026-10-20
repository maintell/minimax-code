import { miniAppErrorCode, miniAppFailureReasonCode } from '../errors.js';
import { sanitizeMiniAppRuntimeLogEvent } from '../runtime-log.js';
import { clearAfterSettlement } from './cleanup-settlement.js';
import { miniAppStartupFailureLogDetail } from './startup-failure-log.js';
const HOST_EVENTS = {
    'runtime.start_requested': 'Host requested a new Mini App runtime.',
    'runtime.ready': 'Mini App runtime passed Host readiness checks.',
    'runtime.exited': 'Host observed the Mini App process exit.',
    'runtime.failed': 'Host observed a Mini App runtime failure.',
};
const FAILURE_MESSAGES = {
    ACTIVATION_FAILED: 'Host could not activate the Mini App runtime.',
    BUSY: 'Mini App runtime capacity or an operation is busy.',
    CANDIDATE_CHANGED: 'Mini App package changed during preparation.',
    CLEANUP_UNPROVEN: 'Host could not confirm runtime cleanup.',
    CLOSED: 'Mini App Host closed during preparation.',
    DISABLED: 'Mini App was disabled during preparation.',
    EADDRINUSE: 'The selected runtime port is already in use.',
    ENTRY_OUTSIDE_ARTIFACT: 'Mini App entry is outside its package.',
    HOST_CONNECTOR_PROTOCOL_VIOLATION: 'Mini App violated the Host Connector protocol.',
    HOST_CONNECTOR_UNAVAILABLE: 'The required Host Connector is unavailable.',
    NO_CANDIDATE_PORT: 'No Host-approved runtime port is available.',
    PERSISTENCE_COMPENSATION_FAILED: 'Host could not restore the previous Mini App state.',
    PERSISTENCE_WRITE_FAILED: 'Host could not save Mini App state.',
    QUARANTINED: 'Mini App runtime is quarantined pending cleanup confirmation.',
    READINESS_TIMEOUT: 'Mini App runtime did not become ready before the deadline.',
    RUNNER_EXITED: 'Mini App process exited before becoming ready.',
    RUNNER_LIFECYCLE_INVALID: 'Mini App returned an invalid lifecycle implementation.',
    RUNNER_PROTOCOL_ERROR: 'Mini App runner violated the Host protocol.',
    RUNNER_START_FAILED: 'Mini App entry failed to start.',
    RUNTIME_EXITED: 'Mini App process exited without a Host shutdown request.',
    RUNTIME_START_FAILED: 'Mini App runtime preparation failed.',
    SERVICE_RESTARTED: 'Mini App runtime changed during the operation.',
    START_EXPORT_MISSING: 'Mini App entry does not export start().',
    SUPERSEDED: 'A newer Mini App operation superseded runtime preparation.',
    TCP_CONNECT_TIMEOUT: 'Host could not connect to the Mini App runtime before the deadline.',
};
/** Supervisor-owned, bounded run history. Arbitrary plugin text never enters public diagnostics. */
export class MiniAppSupervisorDiagnostics {
    options;
    records = new Map();
    runtimeLogs = new Map();
    observations = new Set();
    sequence = 0;
    capacity;
    constructor(options) {
        this.options = options;
        const requested = options.logCapacity ?? 200;
        this.capacity = Number.isFinite(requested)
            ? Math.max(1, Math.min(200, Math.floor(requested)))
            : 200;
    }
    async prepare(input, miniAppGeneration) {
        const record = {
            run: { runId: input.processGeneration, preparationStartedAtMs: this.options.nowMs() },
            logs: [],
            omittedCount: 0,
            truncated: false,
        };
        const pluginId = input.candidate.pluginId;
        this.records.set(pluginId, [...(this.records.get(pluginId) ?? []).slice(-1), record]);
        this.appendHostLog(record, 'runtime.start_requested');
        try {
            const runtime = await this.options.nodeRuntime.prepare({
                ...input,
                onLog: (event) => this.appendRuntimeLog(pluginId, miniAppGeneration, event, record),
            });
            record.run = { ...record.run, readyAtMs: this.options.nowMs() };
            this.appendHostLog(record, 'runtime.ready');
            const observed = clearAfterSettlement(this.observeExit(runtime, record), () => this.observations.delete(observed));
            this.observations.add(observed);
            return runtime;
        }
        catch (error) {
            this.recordFailure(record, error);
            this.logStartupFailure(input, miniAppGeneration, record, error);
            throw error;
        }
    }
    pluginIds() {
        return this.records.keys();
    }
    logs(pluginId) {
        return [...(this.runtimeLogs.get(pluginId) ?? [])];
    }
    inspect(pluginId, currentRunId, failureCode) {
        const records = this.records.get(pluginId) ?? [];
        const record = records.find(({ run }) => run.runId === currentRunId) ?? records.at(-1);
        return {
            scope: 'host',
            retention: 'runtime-memory',
            ...(failureCode ? { failure: publicFailure(failureCode) } : {}),
            ...(record ? { run: snapshotRun(record, currentRunId) } : {}),
            logs: {
                entries: record?.logs.map((entry) => ({ ...entry })) ?? [],
                truncated: record?.truncated ?? false,
                omittedCount: record?.omittedCount ?? 0,
            },
        };
    }
    async observeExit(runtime, record) {
        try {
            const exit = await runtime.closed;
            this.recordExit(record, exit);
        }
        catch (error) {
            this.recordFailure(record, error);
        }
    }
    recordExit(record, exit) {
        record.run = { ...record.run, exitedAtMs: this.options.nowMs(), exit: { ...exit } };
        this.appendHostLog(record, 'runtime.exited');
        if (!exit.shutdownRequested)
            this.recordFailure(record, { code: 'RUNTIME_EXITED' });
    }
    recordFailure(record, error) {
        const candidate = miniAppFailureReasonCode(error) ?? miniAppErrorCode(error);
        record.run = { ...record.run, failure: publicFailure(candidate) };
        this.appendHostLog(record, 'runtime.failed');
    }
    logStartupFailure(input, miniAppGeneration, record, error) {
        if (!this.options.logger)
            return;
        try {
            this.options.logger.error({
                event: 'miniapp.runtime_start_failed',
                pluginId: input.candidate.pluginId,
                miniAppGeneration,
                processGeneration: input.processGeneration,
                nodeDigest: input.candidate.nodeDigest,
                reasonCode: record.run.failure?.code,
                durationMs: Math.max(0, this.options.nowMs() - record.run.preparationStartedAtMs),
                ...miniAppStartupFailureLogDetail(error),
            }, 'Mini App runtime startup failed');
        }
        catch {
            // Diagnostic formatting or logging must never replace the startup failure.
        }
    }
    appendHostLog(record, code) {
        record.logs.push({
            sequence: (this.sequence += 1),
            atMs: this.options.nowMs(),
            code,
            message: HOST_EVENTS[code],
        });
        if (record.logs.length > this.capacity) {
            record.logs.splice(0, record.logs.length - this.capacity);
            record.truncated = true;
        }
    }
    appendRuntimeLog(pluginId, miniAppGeneration, event, record) {
        record.omittedCount += 1;
        const entries = this.runtimeLogs.get(pluginId) ?? [];
        entries.push({
            ...sanitizeMiniAppRuntimeLogEvent(event),
            sequence: (this.sequence += 1),
            atMs: this.options.nowMs(),
            miniAppGeneration,
        });
        if (entries.length > this.capacity)
            entries.splice(0, entries.length - this.capacity);
        this.runtimeLogs.set(pluginId, entries);
    }
}
function snapshotRun(record, currentRunId) {
    const { exit, failure } = record.run;
    return {
        ...record.run,
        current: record.run.runId === currentRunId && !exit,
        ...(exit ? { exit: { ...exit } } : {}),
        ...(failure ? { failure: { ...failure } } : {}),
    };
}
function publicFailure(candidate) {
    const code = Object.hasOwn(FAILURE_MESSAGES, candidate)
        ? candidate
        : 'RUNTIME_START_FAILED';
    return { code, message: FAILURE_MESSAGES[code] };
}
//# sourceMappingURL=supervisor-diagnostics.js.map