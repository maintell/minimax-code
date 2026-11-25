import { and, eq, lte, sql } from 'drizzle-orm';
import { projects } from '../../../../../infra/db/schema/projects.js';
import { sessions } from '../../../../../infra/db/schema/sessions.js';
import { eligible, listedProjectPredicate, ordinarySidebarSession, } from '../../../projects/sidebar/predicate.js';
import { listInternalDefaultRootIds } from '../../../shared/internal-default-roots.js';
import { listedFirstValues } from '../../../shared/project-list-position.js';
/** The newest Project row before a Session insert; rows the insert creates get higher ids. */
export function latestProjectId(db) {
    return (db
        .select({ id: sql `MAX(${projects.projectId})` })
        .from(projects)
        .get()?.id ?? 0);
}
/**
 * A workspace Project leaves the sidebar list when it no longer lists a task (all of them
 * deleted, say, or only ones the sidebar does not show are left) and comes back with a new one.
 * It is then listed first, like a Project the user adds. Whether it was listed is the sidebar's
 * own rule (`listedProjectPredicate`), except that Bunny-created tasks count as listed: their ids
 * are known to the sidebar query, not to this repository. Projects that still list a task,
 * set-up and pinned Projects (they never left the sidebar) and the rows this insert created keep
 * their position.
 */
export function relistReturningProject(db, { sessionId, lastProjectId, nowMs, agentInternalWorkspaceDir, }) {
    const project = db
        .select({ projectId: projects.projectId })
        .from(sessions)
        .innerJoin(projects, eq(projects.projectId, sessions.projectId))
        .where(and(eq(sessions.sessionId, sessionId), eq(projects.projectKind, 'workspace'), eq(projects.pinned, 0), lte(projects.projectId, lastProjectId), eligible(), ordinarySidebarSession))
        .get();
    if (!project)
        return;
    const internalRootIds = listInternalDefaultRootIds(db, agentInternalWorkspaceDir);
    // An internal root is not listed and does not bring its Project back.
    if (internalRootIds.includes(sessionId))
        return;
    const listedBefore = db
        .select({ projectId: projects.projectId })
        .from(projects)
        .where(and(eq(projects.projectId, project.projectId), listedProjectPredicate(db, { internalRootIds, excludedSessionId: sessionId })))
        .get();
    if (listedBefore)
        return;
    db.update(projects)
        .set(listedFirstValues(db, nowMs))
        .where(eq(projects.projectId, project.projectId))
        .run();
}
//# sourceMappingURL=project-relist.js.map