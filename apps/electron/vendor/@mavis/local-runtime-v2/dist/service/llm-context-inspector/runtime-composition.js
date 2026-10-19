import { join, relative, sep } from 'node:path';
import { composeLlmContextInspector } from './initialize.js';
export async function createRuntimeInspector(options) {
    let sessionSystem;
    const composition = composeLlmContextInspector({
        dataDir: options.dataDir,
        db: options.db,
        resolveSession: createInspectorSessionResolver(options.dataDir, () => sessionSystem),
        runtimeOwnerKind: options.runtimeOwnerKind,
    });
    const inspector = composition ? await composition : undefined;
    return {
        inspector,
        bindSessionSystem: (value) => {
            sessionSystem = value;
        },
    };
}
function createInspectorSessionResolver(dataDir, getSessionSystem) {
    return async (sessionId) => {
        const located = await getSessionSystem()?.historyLocations.resolveSession(sessionId);
        const session = located?.session;
        if (!session || !located)
            return undefined;
        return {
            sessionId: session.sessionId,
            ...(session.title ? { title: session.title } : {}),
            agentName: session.agentName,
            createdAtMs: session.createdAtMs,
            historyRelativeDir: relative(join(dataDir, 'v2', 'sessions'), located.paths.sessionDir)
                .split(sep)
                .join('/'),
        };
    };
}
//# sourceMappingURL=runtime-composition.js.map