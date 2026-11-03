import { join } from 'node:path';
import { isLocalChildWorkerSession, isLocalSidebarTreeSession } from '../session-policy.js';
import { toDaemonSession } from './serialization.js';
export async function serializeLocalSessionTree(input) {
    const { archivedOnly, includeArchivedRoots, excludePurposePrefix, includeHidden } = sessionTreeOptions(input.url);
    const visible = input.sessions.filter((session) => (!archivedOnly || session.archived) &&
        (includeHidden || isLocalSidebarTreeSession(session)) &&
        (!excludePurposePrefix ||
            !session.purpose ||
            !session.purpose.startsWith(excludePurposePrefix)));
    const visibleById = new Map(visible.map((session) => [session.sessionId, session]));
    const fullById = new Map(input.sessions.map((session) => [session.sessionId, session]));
    const rootAgentNames = new Set(input.agentNames && input.agentNames.length > 0 ? input.agentNames : [input.agentName]);
    const childrenByParent = new Map();
    for (const session of visible) {
        const parentSessionId = session.parentSessionId;
        if (!parentSessionId)
            continue;
        const parent = visibleById.get(parentSessionId);
        if (!parent || (!includeArchivedRoots && parent.archived))
            continue;
        const children = childrenByParent.get(parentSessionId) ?? [];
        children.push(session);
        childrenByParent.set(parentSessionId, children);
    }
    const roots = visible.filter((session) => {
        if (!rootAgentNames.has(session.agentName))
            return false;
        if (!includeArchivedRoots && session.archived)
            return false;
        if (!session.parentSessionId)
            return true;
        if (!includeHidden && isLocalChildWorkerSession(session))
            return false;
        const parentAll = fullById.get(session.parentSessionId);
        if (parentAll && parentAll.agentName !== session.agentName)
            return false;
        return !isVisibleTreeParent(visibleById.get(session.parentSessionId), includeArchivedRoots);
    });
    const serializeNode = async (session, ancestors = new Set()) => {
        const nextAncestors = new Set(ancestors);
        nextAncestors.add(session.sessionId);
        const children = (childrenByParent.get(session.sessionId) ?? []).filter((child) => !nextAncestors.has(child.sessionId));
        return {
            ...(await serializeLocalSession({
                session,
                dataDir: input.dataDir,
                getSessionById: input.getSessionById,
            })),
            childSessions: await Promise.all(children.map((child) => serializeNode(child, nextAncestors))),
        };
    };
    return Promise.all(roots.map((session) => serializeNode(session)));
}
function sessionTreeOptions(url) {
    const archivedOnly = url.searchParams.get('onlyCompressed') === 'true' ||
        url.searchParams.get('only_archived') === 'true';
    return {
        archivedOnly,
        includeArchivedRoots: archivedOnly ||
            url.searchParams.get('includeCompressed') === 'true' ||
            url.searchParams.get('include_archived') === 'true',
        excludePurposePrefix: url.searchParams.get('excludePurposePrefix') ?? '',
        includeHidden: url.searchParams.get('includeHidden') === 'true' ||
            url.searchParams.get('include_hidden') === 'true',
    };
}
function isVisibleTreeParent(parent, includeArchived) {
    return parent !== undefined && (includeArchived || !parent.archived);
}
export async function serializeLocalSession(input) {
    const rootSessionId = await resolveLocalRootSessionId(input.session, input.getSessionById);
    return {
        ...toDaemonSession(input.session),
        scratchpadPath: join(input.dataDir, 'scratchpads', rootSessionId, 'scratchpad.md'),
    };
}
async function resolveLocalRootSessionId(session, getSessionById) {
    const visited = new Set([session.sessionId]);
    let current = session;
    while (current.parentSessionId && !visited.has(current.parentSessionId)) {
        visited.add(current.parentSessionId);
        const parent = await getSessionById(current.parentSessionId);
        if (!parent)
            break;
        current = parent;
    }
    return current.sessionId;
}
//# sourceMappingURL=session-compat-serialization.js.map