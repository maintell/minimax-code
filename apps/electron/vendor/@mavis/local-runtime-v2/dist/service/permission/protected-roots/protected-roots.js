import path from 'node:path';
import { canonicalPath, isInside } from './canonical-paths.js';
import { scriptWritesInside } from './script-references.js';
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
                const trusted = trustedExactTargets(request);
                for (const root of roots) {
                    if (root.exempts?.(session))
                        continue;
                    const protects = exceptTrusted(root.protects ?? isInside, trusted);
                    if (writesInside(root.directory, session, request, protects) ||
                        (root.scripts === true &&
                            (await scriptWritesInside(root.directory, session, request, protects)))) {
                        return { behavior: 'deny', reason: root.reason };
                    }
                }
            }
            return decisions.check(request);
        },
    };
}
/** The exact files the turn's execution owner hands the Session to write, such as its Plan document. */
function trustedExactTargets(request) {
    return (request.trustedExactWritePaths ?? []).map((target) => canonicalPath(path.resolve(target)));
}
/** A trusted exact target is the Session's own file, whichever tool or script writes it. */
function exceptTrusted(protects, trusted) {
    if (trusted.length === 0)
        return protects;
    // `path.relative` compares Windows paths case-insensitively.
    return (root, target) => !trusted.some((exact) => path.relative(exact, target) === '') && protects(root, target);
}
//# sourceMappingURL=protected-roots.js.map