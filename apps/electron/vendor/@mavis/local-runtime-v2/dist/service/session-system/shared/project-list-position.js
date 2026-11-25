import { and, asc, desc, eq, gt, lt, ne, or, sql } from 'drizzle-orm';
import { DEFAULT_PROJECT_ORDER_INDEX, projects } from '../../../infra/db/schema/projects.js';
/**
 * Position of a project in the sidebar list, the latest first: when it joined the list
 * (`listed_at_ms`, m0070), otherwise when it was created. Adding, moving or running tasks never
 * changes it, so the list stays where the user left it.
 */
export const projectListPositionExpression = sql `COALESCE(${projects.listedAtMs}, ${projects.createdAtMs})`;
/**
 * Column values that list a project first again, as a newly created one: a project the user
 * creates again, or a removed project that comes back. The position stays above every other
 * project even when a stored one is ahead of the clock; with `unhide` the project is shown again
 * too. Every write that brings a project back spreads these, so showing a project again always
 * lists it first.
 */
export function listedFirstValues(db, nowMs, { unhide = false } = {}) {
    const top = db
        .select({ position: sql `MAX(${projectListPositionExpression})` })
        .from(projects)
        .get()?.position;
    return {
        listedAtMs: Math.max(nowMs, Number(top ?? 0) + 1),
        ...(unhide ? { hidden: 0 } : {}),
    };
}
/** Room left between neighbouring positions when the list is renumbered. */
const RENUMBERED_POSITION_STEP = 1024;
/**
 * Places a project right below another one in the sidebar list (the user dragging it), or first
 * without one, as a newly created project. Only the moved project's position changes: it takes a
 * value halfway between its new neighbours. When they leave no room (equal or adjacent
 * positions), every project is first renumbered in its current order, `RENUMBERED_POSITION_STEP`
 * apart below the current top, so a project created later still lists first.
 */
export function moveProjectInList(db, projectId, afterProjectId, nowMs) {
    normalizeListedOrder(db);
    let listedAtMs;
    if (afterProjectId === null) {
        listedAtMs = listedFirstValues(db, nowMs).listedAtMs;
    }
    else {
        listedAtMs = positionBelow(db, projectId, afterProjectId);
        if (listedAtMs === undefined) {
            renumberProjectList(db);
            listedAtMs = positionBelow(db, projectId, afterProjectId);
        }
    }
    if (listedAtMs === undefined)
        return;
    db.update(projects).set({ listedAtMs }).where(eq(projects.projectId, projectId)).run();
}
/**
 * The position that lists a project right below `afterProjectId`, or undefined when the anchor is
 * gone or its neighbour below leaves no room. The list orders by position, then by project id.
 */
function positionBelow(db, projectId, afterProjectId) {
    const anchor = db
        .select({ position: projectListPositionExpression })
        .from(projects)
        .where(eq(projects.projectId, afterProjectId))
        .get();
    if (!anchor)
        return undefined;
    const upper = Number(anchor.position);
    const next = db
        .select({ position: projectListPositionExpression })
        .from(projects)
        .where(and(ne(projects.projectId, projectId), or(lt(projectListPositionExpression, upper), and(eq(projectListPositionExpression, upper), gt(projects.projectId, afterProjectId)))))
        .orderBy(desc(projectListPositionExpression), asc(projects.projectId))
        .limit(1)
        .get();
    if (!next)
        return upper - RENUMBERED_POSITION_STEP;
    const lower = Number(next.position);
    return upper - lower >= 2 ? Math.floor((upper + lower) / 2) : undefined;
}
/**
 * The list sorts by `order_index` before position, and an unpinned project keeps a pin order only
 * from older data: v1 left it when a project was unpinned, while v2 resets it. Such a project stays
 * on top whatever its position, so a drag would not stick. Before a drag, give every unpinned
 * project a position in the order the list shows them now, `RENUMBERED_POSITION_STEP` apart below
 * the current top, and reset its `order_index`: the list looks the same and positions alone order
 * it from then on. Pinned projects keep both, so they still return to their place when unpinned.
 */
function normalizeListedOrder(db) {
    const legacy = db
        .select({ projectId: projects.projectId })
        .from(projects)
        .where(and(eq(projects.pinned, 0), ne(projects.orderIndex, DEFAULT_PROJECT_ORDER_INDEX)))
        .limit(1)
        .get();
    if (!legacy)
        return;
    const rows = db
        .select({ projectId: projects.projectId, position: projectListPositionExpression })
        .from(projects)
        .where(eq(projects.pinned, 0))
        .orderBy(asc(projects.orderIndex), desc(projectListPositionExpression), asc(projects.projectId))
        .all();
    const top = Math.max(...rows.map(({ position }) => Number(position)));
    rows.forEach(({ projectId }, index) => {
        db.update(projects)
            .set({
            listedAtMs: top - index * RENUMBERED_POSITION_STEP,
            orderIndex: DEFAULT_PROJECT_ORDER_INDEX,
        })
            .where(eq(projects.projectId, projectId))
            .run();
    });
}
/** Spreads every project's position `RENUMBERED_POSITION_STEP` apart, keeping the order and top. */
function renumberProjectList(db) {
    const rows = db
        .select({ projectId: projects.projectId, position: projectListPositionExpression })
        .from(projects)
        .orderBy(desc(projectListPositionExpression), asc(projects.projectId))
        .all();
    const top = Number(rows[0]?.position ?? 0);
    rows.forEach(({ projectId }, index) => {
        db.update(projects)
            .set({ listedAtMs: top - index * RENUMBERED_POSITION_STEP })
            .where(eq(projects.projectId, projectId))
            .run();
    });
}
//# sourceMappingURL=project-list-position.js.map