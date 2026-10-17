/**
 * Compare a persisted Channel/Session owner fence with the currently resolved
 * owner. Custom Agents always require the exact name + incarnation. Builtins
 * may cross names only when the shared resolver proves both names belong to
 * the same trusted primary family (for example historical `main` and current
 * `mavis`).
 */
export async function isCompatibleChannelAgentOwner(input) {
    if (input.current.ownerKind === 'custom') {
        return (input.current.exactOwnerName === input.persisted.exactOwnerName &&
            input.current.ownerInstanceId === input.persisted.ownerInstanceId);
    }
    if (input.persisted.ownerInstanceId !== undefined)
        return false;
    if (input.current.exactOwnerName === input.persisted.exactOwnerName)
        return true;
    if (!input.resolveAgentReadScope)
        return false;
    try {
        const scope = await input.resolveAgentReadScope(input.current.exactOwnerName);
        const family = trustedPrimaryFamilyNames(scope);
        if (!family)
            return false;
        return family.has(input.current.exactOwnerName) && family.has(input.persisted.exactOwnerName);
    }
    catch {
        return false;
    }
}
/**
 * The set of names proven to belong to the same trusted primary family, or
 * undefined when the resolved scope is not a trusted canonical primary.
 */
function trustedPrimaryFamilyNames(scope) {
    const canonicalName = scope.canonicalName.trim();
    const primaryName = scope.primaryName?.trim();
    if (scope.trustedBuiltin !== true ||
        !canonicalName ||
        !primaryName ||
        canonicalName !== primaryName) {
        return undefined;
    }
    return new Set([canonicalName, primaryName, scope.exactOwnerName, ...(scope.compatibleNames ?? [])].filter((name) => typeof name === 'string' && name.length > 0));
}
/** Keep one unreadable legacy Agent local to its route; storage failures still propagate. */
export function historicalChannelAgentReadErrorCode(error) {
    if (!error || typeof error !== 'object')
        return undefined;
    const { code, reason } = error;
    if (reason === 'agent-not-found')
        return 'AGENT_NOT_FOUND';
    if (typeof code === 'string' &&
        [
            'AGENT_NOT_FOUND',
            'AGENT_CONFIG_NOT_FOUND',
            'AGENT_CONFIG_INVALID',
            'AGENT_CONFIG_UNSTABLE',
            'AGENT_CONFIG_INSTANCE_CONFLICT',
            'CANONICAL_AGENT_NOT_AVAILABLE',
        ].includes(code))
        return code;
    return undefined;
}
//# sourceMappingURL=agent-owner-compatibility.js.map