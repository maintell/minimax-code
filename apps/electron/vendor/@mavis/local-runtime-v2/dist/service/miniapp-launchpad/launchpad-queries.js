import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { miniAppCreationSummary, } from '@mavis/shared/miniapp-launchpad';
import { miniAppCreations } from '../../infra/db/schema/miniapp-launchpad.js';
const { status, pluginId, sessionId, sourceSessionId } = miniAppCreations;
const unfinishedStatuses = ['building', 'waiting', 'interrupted', 'failed'];
function creationScope(accountId, deployment) {
    return and(eq(miniAppCreations.accountId, accountId), eq(miniAppCreations.deployment, deployment));
}
/** Detail reads are bounded; successful history never enters background reconciliation. */
export function readCreationRecords(db, accountId, deployment, selection) {
    let condition = inArray(status, unfinishedStatuses);
    if (selection.kind === 'id' || selection.kind === 'create')
        condition = eq(miniAppCreations.id, selection.id);
    else if (selection.kind === 'session')
        condition = eq(sessionId, selection.sessionId);
    else if (selection.kind === 'plugin')
        condition = eq(pluginId, selection.pluginId);
    return db
        .select()
        .from(miniAppCreations)
        .where(and(creationScope(accountId, deployment), condition))
        .orderBy(desc(miniAppCreations.createdAt), desc(miniAppCreations.id))
        .limit(selection.kind === 'unfinished' ? 100 : 1)
        .all();
}
export function readCreationCapacity(db, accountId, deployment) {
    const counts = db
        .select({ status, total: sql `count(*)` })
        .from(miniAppCreations)
        .where(and(creationScope(accountId, deployment), inArray(status, unfinishedStatuses)))
        .groupBy(status)
        .all();
    return {
        unfinished: counts.reduce((sum, row) => sum + row.total, 0),
        building: counts.find((row) => row.status === 'building')?.total ?? 0,
    };
}
export function readCreationSummaries(db, accountId, deployment) {
    const projection = {
        id: miniAppCreations.id,
        pluginId,
        status,
        createdAt: miniAppCreations.createdAt,
        requirements: sql `substr(${miniAppCreations.requirements}, 1, 160)`,
        sourceTitle: sql `substr(${miniAppCreations.sourceTitle}, 1, 160)`,
        sessionId,
        sourceSessionId,
        recommendationId: miniAppCreations.recommendationId,
    };
    const read = (ready, limit) => db
        .select(projection)
        .from(miniAppCreations)
        .where(and(creationScope(accountId, deployment), ready ? eq(status, 'ready') : inArray(status, unfinishedStatuses)))
        .orderBy(desc(miniAppCreations.createdAt), desc(miniAppCreations.id))
        .limit(limit)
        .all();
    const pending = read(false, 100);
    const rows = pending.length === 100 ? pending : [...pending, ...read(true, 100 - pending.length)];
    return rows.map(({ sessionId: session, sourceSessionId: source, sourceTitle, recommendationId, ...row }) => miniAppCreationSummary({
        ...row,
        ...(sourceTitle ? { sourceTitle } : {}),
        ...(session ? { sessionId: session } : {}),
        ...(source ? { sourceSessionId: source } : {}),
        ...(recommendationId ? { recommendationId } : {}),
    }));
}
/** Query only candidates, not every historical creation or its private requirements. */
export function readLinkedSessionIds(db, accountId, deployment, candidates) {
    if (candidates.length === 0)
        return new Set();
    const ids = [...new Set(candidates)];
    const read = (field) => db
        .selectDistinct({ id: field })
        .from(miniAppCreations)
        .where(and(creationScope(accountId, deployment), inArray(field, ids)))
        .all();
    return new Set([...read(sessionId), ...read(sourceSessionId)].flatMap((row) => (row.id ? [row.id] : [])));
}
/** Keep optional storage NULLs out of the public creation record. */
export function creationFromRow(row) {
    return {
        id: row.id,
        pluginId: row.pluginId,
        requirements: row.requirements,
        status: row.status,
        createdAt: row.createdAt,
        ...(row.sessionId !== null ? { sessionId: row.sessionId } : {}),
        ...(row.sourceSessionId !== null ? { sourceSessionId: row.sourceSessionId } : {}),
        ...(row.recommendationId !== null ? { recommendationId: row.recommendationId } : {}),
        ...(row.sourceSummary !== null ? { sourceSummary: row.sourceSummary } : {}),
        ...(row.sourceTitle !== null ? { sourceTitle: row.sourceTitle } : {}),
        ...(row.sourceCapturedAt !== null ? { sourceCapturedAt: row.sourceCapturedAt } : {}),
        ...(row.workspaceDir !== null ? { workspaceDir: row.workspaceDir } : {}),
        ...(row.error !== null ? { error: row.error } : {}),
    };
}
//# sourceMappingURL=launchpad-queries.js.map