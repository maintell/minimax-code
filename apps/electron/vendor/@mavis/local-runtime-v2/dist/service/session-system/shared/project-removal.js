import { and, eq, ne, sql } from 'drizzle-orm';
import { projects } from '../../../infra/db/schema/projects.js';
import { sessions } from '../../../infra/db/schema/sessions.js';
// The boundary IDs distinguish old and new sessions created in the same millisecond.
export function recordProjectRemoval(db, project, atMs, newlyCreatedSessionId) {
    const boundaryIds = db
        .select({ id: sessions.sessionId })
        .from(sessions)
        .where(and(eq(sessions.projectId, project.projectId), eq(sessions.createdAtMs, atMs), newlyCreatedSessionId ? ne(sessions.sessionId, newlyCreatedSessionId) : undefined))
        .all()
        .map((row) => row.id);
    db.update(projects)
        .set({
        extraDataJson: sql `json_set(${projects.extraDataJson}, '$.sidebarRemoval', json(${JSON.stringify({ atMs, boundaryIds })}))`,
    })
        .where(eq(projects.projectId, project.projectId))
        .run();
}
/**
 * Brings one task that predates the latest removal back into the sidebar, for
 * example when the user unpins it. Other old tasks stay removed, and the
 * project becomes visible again only when that task is itself listable.
 * A later removal rewrites `sidebarRemoval` and drops these exceptions.
 * Returns whether the task was hidden by a removal.
 */
export function restoreSessionAfterProjectRemoval(db, sessionId, nowMs, isListable) {
    const row = db
        .select({
        projectId: projects.projectId,
        hidden: projects.hidden,
        updatedAtMs: projects.updatedAtMs,
        extraDataJson: projects.extraDataJson,
        afterRemoval: sql `${sessionAfterProjectRemoval()}`,
    })
        .from(sessions)
        .innerJoin(projects, eq(projects.projectId, sessions.projectId))
        .where(eq(sessions.sessionId, sessionId))
        .get();
    if (!row || (row.hidden === 0 && row.afterRemoval))
        return false;
    // Older removals predate the boundary field; keep the rest of that project removed.
    if (!readSidebarRemoval(row.extraDataJson))
        recordProjectRemoval(db, row, row.updatedAtMs);
    db.update(projects)
        .set({
        extraDataJson: sql `json_set(${projects.extraDataJson}, '$.sidebarRemoval.restoredIds',
        json(${JSON.stringify(restoredIdsWith(db, row.projectId, sessionId))}))`,
    })
        .where(eq(projects.projectId, row.projectId))
        .run();
    if (row.hidden !== 0 && isListable()) {
        db.update(projects)
            .set({ hidden: 0, updatedAtMs: nowMs })
            .where(eq(projects.projectId, row.projectId))
            .run();
    }
    return true;
}
function readSidebarRemoval(extraDataJson) {
    try {
        const removal = JSON.parse(extraDataJson).sidebarRemoval;
        return removal && typeof removal === 'object' ? removal : undefined;
    }
    catch {
        return undefined;
    }
}
function restoredIdsWith(db, projectId, sessionId) {
    const extra = db
        .select({ extraDataJson: projects.extraDataJson })
        .from(projects)
        .where(eq(projects.projectId, projectId))
        .get()?.extraDataJson;
    const current = readSidebarRemoval(extra ?? '{}')?.restoredIds;
    const ids = Array.isArray(current)
        ? current.filter((id) => typeof id === 'string')
        : [];
    return ids.includes(sessionId) ? ids : [...ids, sessionId];
}
export function sessionAfterProjectRemoval() {
    return sql `(json_extract(${projects.extraDataJson}, '$.sidebarRemoval.atMs') IS NULL
    OR ${sessions.createdAtMs} > json_extract(${projects.extraDataJson}, '$.sidebarRemoval.atMs')
    OR (${sessions.createdAtMs} = json_extract(${projects.extraDataJson}, '$.sidebarRemoval.atMs')
      AND ${sessions.sessionId} NOT IN (
        SELECT value FROM json_each(${projects.extraDataJson}, '$.sidebarRemoval.boundaryIds')
      ))
    OR ${sessions.sessionId} IN (
      SELECT value FROM json_each(${projects.extraDataJson}, '$.sidebarRemoval.restoredIds')
    ))`;
}
export function sessionNotRemovedFromProject() {
    return sql `NOT EXISTS (SELECT 1 FROM ${projects}
    WHERE ${projects.projectId} = ${sessions.projectId} AND NOT ${sessionAfterProjectRemoval()})`;
}
/**
 * Session 在侧栏能看到：所在项目没有隐藏（侧栏「移除项目」），Session 也不早于最近一次移除。
 * 和侧栏 `eligible` 的项目条件一致；移除后在同一项目新建任务会取消隐藏，但更早的任务仍然不算，
 * 只有取消置顶时恢复的任务（`sidebarRemoval.restoredIds`）例外。
 */
export function sessionInVisibleProject() {
    return sql `NOT EXISTS (SELECT 1 FROM ${projects}
    WHERE ${projects.projectId} = ${sessions.projectId}
      AND (${projects.hidden} <> 0 OR NOT ${sessionAfterProjectRemoval()}))`;
}
//# sourceMappingURL=project-removal.js.map