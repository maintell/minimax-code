import { matchesAgentResourceInstance } from '@mavis/shared/local-runtime-agent-resource-instance';
export function createAgentResourceScopeReader(dataDir) {
    return async (scope, read) => {
        const { expectedAgentInstanceId } = scope;
        if (!expectedAgentInstanceId || scope.excludeAgentResources)
            return read(scope);
        const matches = () => matchesAgentResourceInstance(dataDir(), scope.agentName, expectedAgentInstanceId);
        const unavailable = () => read({ ...scope, excludeAgentResources: true });
        if (!(await matches()))
            return unavailable();
        try {
            const result = await read(scope);
            // A cached URI or registry is not proof that the original Agent still owns the files.
            return (await matches()) ? result : unavailable();
        }
        catch (error) {
            if (!(await matches()))
                return unavailable();
            throw error;
        }
    };
}
/**
 * The configured roots minus the ones a single Agent owns: its
 * `agents/<name>/skills` directory and the builtin roots scoped to that Agent.
 *
 * One definition of the registry's `excludeAgentResources` filter, so every
 * reader that resolves its own roots answers the same question the same way.
 * PTC's script roots are the second reader
 * (`application/session/ptc-script-skill-roots.ts`); when the two drift,
 * `run_code` keeps importing an Agent's private scripts that the `skill` tool
 * already refuses.
 *
 * The constraint is the two fields the rule reads, so the element type the
 * caller passes survives the filter.
 */
export function withoutAgentResourceRoots(roots) {
    return roots.filter((root) => root.kind !== 'agent' && !(root.kind === 'builtin' && root.scope));
}
//# sourceMappingURL=registry-agent-scope.js.map