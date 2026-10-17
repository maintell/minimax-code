import { classifyHandoffStageError, SessionHandoffError, } from '../errors.js';
export function handoffConfirmationStages(ports, identity) {
    return (stage, operation) => handoffStage(ports, identity, stage, async () => {
        try {
            return await operation();
        }
        catch (error) {
            throw classifyHandoffStageError(stage, error);
        }
    });
}
/** Only allowlisted diagnostics; never serialize the exception, query, paths or credentials. */
export function observeHandoff(ports, observation) {
    try {
        const logger = ports.logger;
        const write = observation.outcome === 'failed' ? (logger?.error ?? logger?.info) : logger?.info;
        write?.call(logger, { ...observation }, '[handoff-attempt]');
    }
    catch {
        /* Diagnostic only. */
    }
    try {
        ports.metrics?.counter(`handoff.${observation.event}`, 1, {
            attempt_type: observation.attemptType,
            stage: observation.stage,
            outcome: observation.outcome,
            ...(observation.code ? { error_code: observation.code } : {}),
            ...(observation.diagnostic ? { reason: observation.diagnostic.reason } : {}),
        });
        if (observation.durationMs !== undefined)
            ports.metrics?.histogram?.('handoff.duration_ms', observation.durationMs, {
                attempt_type: observation.attemptType,
                stage: observation.stage,
                outcome: observation.outcome,
            });
    }
    catch {
        /* Diagnostic only. */
    }
}
export async function handoffStage(ports, identity, stage, operation) {
    const started = Date.now();
    try {
        const value = await operation();
        observeHandoff(ports, {
            ...identity,
            event: 'stage_finished',
            stage,
            outcome: 'success',
            durationMs: Date.now() - started,
        });
        return value;
    }
    catch (error) {
        observeHandoff(ports, {
            ...identity,
            event: 'stage_finished',
            stage,
            outcome: error instanceof Error && error.name === 'AbortError' ? 'aborted' : 'failed',
            durationMs: Date.now() - started,
            ...failureDiagnostic(error),
        });
        throw error;
    }
}
function failureDiagnostic(error) {
    const record = error && typeof error === 'object' ? error : {};
    const candidate = record.code ?? record.key;
    const code = typeof candidate === 'string' && /^(HANDOFF|WORKSPACE_REVISION)_[A-Z_]+$/u.test(candidate)
        ? candidate
        : undefined;
    return {
        ...(code ? { code } : {}),
        ...(typeof record.retryable === 'boolean' ? { retryable: record.retryable } : {}),
        ...(error instanceof SessionHandoffError ? { diagnostic: error.diagnostic } : {}),
    };
}
//# sourceMappingURL=observability.js.map