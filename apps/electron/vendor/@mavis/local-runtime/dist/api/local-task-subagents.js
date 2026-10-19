import { resolveTaskTarget, } from '../agent/port.js';
import { SUBAGENT_TELEMETRY_EVENT, emitSubagentTelemetry, inferNameResolutionSource, telemetryErrorCode, } from '../agent/subagent-telemetry.js';
export async function resolveLocalTaskAgentTarget(host, agentName) {
    if (!agentName)
        return undefined;
    const requested = agentName.trim();
    if (!requested)
        return undefined;
    let source = inferNameResolutionSource(requested);
    try {
        const resolved = await resolveTaskTarget(host.agentResolver, requested);
        source = inferNameResolutionSource(requested, resolved.resolvedAgentName);
        emitSubagentTelemetry(host, SUBAGENT_TELEMETRY_EVENT.resolve, { source, success: true });
        return resolved;
    }
    catch (error) {
        emitSubagentTelemetry(host, SUBAGENT_TELEMETRY_EVENT.resolve, {
            source,
            success: false,
            ...(telemetryErrorCode(error) ? { error_code: telemetryErrorCode(error) } : {}),
        });
        if (error &&
            typeof error === 'object' &&
            'code' in error &&
            (error.code === 'UNKNOWN_AGENT_NAME' ||
                error.code === 'AGENT_NOT_FOUND')) {
            return undefined;
        }
        throw error;
    }
}
export async function resolveLocalTaskAgentName(host, agentName) {
    return (await resolveLocalTaskAgentTarget(host, agentName))?.resolvedAgentName;
}
//# sourceMappingURL=local-task-subagents.js.map