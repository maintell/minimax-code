import { resolveCanonicalSubagentRole, } from '@mavis/agent-tools/desktop/subagent-roles';
/**
 * Resolve one Task target using one read scope + write target + execution
 * target decision. No role is inferred from a manual/reserved name: the role
 * is emitted only when the scope itself is trusted bundled data.
 */
export async function resolveTaskTarget(resolver, requestedName) {
    const requested = requestedName.trim();
    const [scope, writeTarget] = await Promise.all([
        resolver.resolveAgentReadScope(requested),
        resolver.resolveAgentWriteTarget(requested),
    ]);
    const exactOwnerName = await resolver.requireExactAgentKey(scope.exactOwnerName?.trim() || writeTarget);
    const resolvedAgentName = await resolver.resolveAgentExecutionTarget(exactOwnerName);
    const trustedBuiltin = scope.trustedBuiltin === true;
    const canonicalRole = trustedBuiltin
        ? resolveCanonicalSubagentRole(scope.canonicalName)
        : undefined;
    return {
        requestedName: requested,
        exactOwnerName,
        resolvedAgentName,
        canonicalViewName: scope.canonicalName,
        ...(canonicalRole ? { canonicalRole } : {}),
        trustedBuiltin,
        source: scope.source,
    };
}
//# sourceMappingURL=port.js.map