import { isInside } from './canonical-paths.js';
import { writesInside, writesPaths, } from './write-targets.js';
/**
 * Checks registered roots first, in order, then hands the request on. Only file
 * write tools and bash read the Session, for the directories relative targets
 * resolve from; other tools go straight on.
 */
export function createProtectedRootDecisions(options, decisions) {
    const { sessions, roots } = options;
    return {
        check: async (request) => {
            if (roots.length > 0 && writesPaths(request.toolName)) {
                const session = await sessions.get(request.sessionId);
                const denied = roots.find((root) => !root.exempts?.(session) &&
                    writesInside(root.directory, session, request, root.protects ?? isInside));
                if (denied)
                    return { behavior: 'deny', reason: denied.reason };
            }
            return decisions.check(request);
        },
    };
}
//# sourceMappingURL=protected-roots.js.map