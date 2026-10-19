/** Product bus event name (kept in sync with v1 SUBAGENT_TELEMETRY_EVENT). */
const RESOURCE_AMBIGUITY_EVENT = 'agent_name_compat.resource_ambiguity';
/** Prometheus-compatible counter for the same observation. */
const RESOURCE_AMBIGUITY_METRIC = 'agent_name_compat_resource_ambiguity_total';
function memberCountBucket(value) {
    if (!Number.isFinite(value) || value < 2)
        return undefined;
    return value === 2 ? '2' : '3+';
}
/** Report a bounded ambiguity observation for a local channel request. */
export function reportChannelResourceAmbiguity(options, memberCount) {
    // v1 gate: only 2+ members are an ambiguity worth reporting.
    if (!Number.isFinite(memberCount) || memberCount < 2)
        return;
    const bucket = memberCountBucket(memberCount);
    const fields = {
        resource_kind: 'channel',
        ...(bucket ? { member_count_bucket: bucket } : {}),
    };
    try {
        options.emitBusEvent?.(RESOURCE_AMBIGUITY_EVENT, { ...fields });
    }
    catch {
        // Telemetry is observational and must never affect the product path.
    }
    try {
        options.metrics?.incr(RESOURCE_AMBIGUITY_METRIC, fields);
    }
    catch {
        // Metrics reporters are host-provided and may fail independently.
    }
}
//# sourceMappingURL=channel-resource-ambiguity.js.map