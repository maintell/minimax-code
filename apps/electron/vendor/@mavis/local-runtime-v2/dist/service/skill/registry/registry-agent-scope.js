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
//# sourceMappingURL=registry-agent-scope.js.map