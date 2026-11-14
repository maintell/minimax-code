/**
 * Coordinator capabilities of a profile rendered from the bundled built-in
 * catalog. A Custom, Plugin or legacy read-through owner never coordinates,
 * even if a value somehow reached its profile.
 */
export function trustedProfileCoordination(profile) {
    if (profile?.creationSource !== 'builtin' || profile.provenance.source !== 'builtin') {
        return undefined;
    }
    return profile.coordination;
}
//# sourceMappingURL=agent-coordination.js.map