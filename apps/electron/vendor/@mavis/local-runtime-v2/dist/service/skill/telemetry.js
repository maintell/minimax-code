export function emitResourceAmbiguityTelemetry(host, resourceKind, memberCount) {
    if (!host || memberCount === undefined || !Number.isFinite(memberCount) || memberCount < 2)
        return;
    const fields = {
        resource_kind: resourceKind,
        member_count_bucket: memberCount === 2 ? '2' : '3+',
    };
    try {
        host.emitBusEvent?.('agent_name_compat.resource_ambiguity', fields);
    }
    catch {
        /* Observational only. */
    }
    try {
        host.metrics?.incr('agent_name_compat_resource_ambiguity_total', fields);
    }
    catch {
        /* Observational only. */
    }
}
//# sourceMappingURL=telemetry.js.map