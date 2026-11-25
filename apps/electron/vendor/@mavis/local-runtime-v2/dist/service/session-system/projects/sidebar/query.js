import { listInternalDefaultRootIds } from '../../shared/internal-default-roots.js';
import { projectListActivityExpression } from '../repo/activity.js';
import { and, asc, desc, eq, getTableColumns, gt, inArray, lte, sql } from 'drizzle-orm';
import { projectListPositionExpression } from '../../shared/project-list-position.js';
import { sessions as s } from '../../../../infra/db/schema/sessions.js';
import { projects as p } from '../../../../infra/db/schema/projects.js';
import { decodeSessionRow } from '../../sessions/repo/codec.js';
import { SidebarQueryError, } from './contracts.js';
import { encodeObject, normalizeSidebarQuery, pageLimit, readCursor, } from './context.js';
import { canonicalOwner, eligible, isDone, listedProjectPredicate, sidebarPredicate, sidebarProjectPredicate, tupleAfter, TRUSTED_IM_MARKER, } from './predicate.js';
export class SidebarQueryService {
    db;
    nowMs;
    agentInternalWorkspaceDir;
    bunnyCreatedSessionIds;
    constructor(db, nowMs = Date.now, agentInternalWorkspaceDir, bunnyCreatedSessionIds) {
        this.db = db;
        this.nowMs = nowMs;
        this.agentInternalWorkspaceDir = agentInternalWorkspaceDir;
        this.bunnyCreatedSessionIds = bunnyCreatedSessionIds;
    }
    normalizeQuery(input, rootAgentNames) {
        const internalRootIds = listInternalDefaultRootIds(this.db, this.agentInternalWorkspaceDir);
        return normalizeSidebarQuery(input, this.nowMs(), {
            internalRootIds,
            rootAgentNames,
            bunnyCreatedIds: this.bunnyCreatedSessionIds?.(),
        });
    }
    projects(input) {
        const q = this.normalizeQuery(input);
        const hasFilters = !!(q.types.length ||
            q.statuses.length ||
            q.agentNames.length ||
            q.activityDays);
        const limit = pageLimit(input.limit, 4);
        const sessionLimit = pageLimit(input.sessionLimit, 6);
        const last = readCursor(input.cursor, q, 'projects');
        return this.db.transaction((tx) => {
            const count = tx.$count(s, and(eq(s.projectId, p.projectId), sidebarPredicate(q)));
            // Preview/count still exclude pinned sessions through sidebarPredicate.
            const isListedProject = listedProjectPredicate(tx, {
                internalRootIds: q.internalRootIds,
                query: q,
            });
            const rows = tx
                .select({
                project: { ...getTableColumns(p), latestActivityAtMs: projectListActivityExpression },
                matchedCount: count,
                // The cursor carries the same position the page is ordered by.
                listPosition: projectListPositionExpression,
            })
                .from(p)
                .where(and(sidebarProjectPredicate(q), hasFilters ? gt(count, 0) : isListedProject, tupleAfter([
                sql `${p.pinned}`,
                sql `${p.orderIndex}`,
                projectListPositionExpression,
                sql `${p.projectId}`,
            ], last, [true, false, true, false])))
                // A stable position, not activity: adding, moving or running tasks keeps the list in place.
                .orderBy(desc(p.pinned), asc(p.orderIndex), desc(projectListPositionExpression), asc(p.projectId))
                .limit(limit + 1)
                .all();
            const page = rows.slice(0, limit);
            // Resolve selection by session ID, not by the current project page. Only the
            // first page may carry an extra group; later pages retain ordinary boundaries.
            const activeRow = input.activeSessionId
                ? tx
                    .select({ record: s, project: p, done: isDone })
                    .from(s)
                    .innerJoin(p, eq(s.projectId, p.projectId))
                    .where(and(eq(s.sessionId, input.activeSessionId), sidebarPredicate(q)))
                    .get()
                : undefined;
            const selectedProject = (() => {
                if (last ||
                    !activeRow ||
                    page.some((row) => row.project.projectId === activeRow.project.projectId))
                    return undefined;
                return tx
                    .select({
                    project: { ...getTableColumns(p), latestActivityAtMs: projectListActivityExpression },
                    matchedCount: count,
                })
                    .from(p)
                    .where(eq(p.projectId, activeRow.project.projectId))
                    .get();
            })();
            // The sidebar renders the default ("no project") bucket as its own section,
            // so the first page always carries it when it is listed. Like the selected
            // group it is an extra group: it never consumes a regular page slot or
            // moves the cursor, and later pages keep their ordinary boundaries.
            const defaultProject = (() => {
                if (last ||
                    page.some((row) => row.project.projectKind === 'default') ||
                    selectedProject?.project.projectKind === 'default')
                    return undefined;
                return tx
                    .select({
                    project: { ...getTableColumns(p), latestActivityAtMs: projectListActivityExpression },
                    matchedCount: count,
                })
                    .from(p)
                    .where(and(eq(p.projectKind, 'default'), sidebarProjectPredicate(q), hasFilters ? gt(count, 0) : isListedProject))
                    .get();
            })();
            const extraRows = [defaultProject, selectedProject].filter((row) => row !== undefined);
            const ids = [...page, ...extraRows].map((r) => r.project.projectId);
            const previews = new Map();
            if (ids.length) {
                const ranked = tx.$with('sidebar_ranked').as(tx
                    .select({
                    id: s.sessionId,
                    rank: sql `row_number() OVER (PARTITION BY ${s.projectId} ORDER BY ${s.updatedAtMs} DESC, ${s.createdAtMs} DESC, ${s.sessionId} ASC)`.as('preview_rank'),
                })
                    .from(s)
                    .innerJoin(p, eq(s.projectId, p.projectId))
                    .where(and(inArray(s.projectId, ids), sidebarPredicate(q))));
                const entries = tx
                    .with(ranked)
                    .select({ record: s, project: p, done: isDone, rank: ranked.rank })
                    .from(ranked)
                    .innerJoin(s, eq(s.sessionId, ranked.id))
                    .innerJoin(p, eq(p.projectId, s.projectId))
                    .where(lte(ranked.rank, sessionLimit + 1))
                    .orderBy(asc(ranked.rank))
                    .all();
                for (const row of entries) {
                    const list = previews.get(row.project.projectId) ?? [];
                    list.push(entry(row, q));
                    previews.set(row.project.projectId, list);
                }
            }
            const groups = [...page, ...extraRows].map((row) => {
                const entries = previews.get(row.project.projectId) ?? [];
                const shown = entries.slice(0, sessionLimit);
                return {
                    project: {
                        ...row.project,
                        projectKind: row.project.projectKind,
                        pinned: !!row.project.pinned,
                        hidden: !!row.project.hidden,
                    },
                    entries: shown,
                    ...(activeRow?.project.projectId === row.project.projectId &&
                        (selectedProject ||
                            !shown.some((value) => value.session.sessionId === activeRow.record.sessionId))
                        ? { activeEntry: entry(activeRow, q) }
                        : {}),
                    matchedCount: Number(row.matchedCount),
                    hasMoreSessions: entries.length > sessionLimit,
                    ...(entries.length > sessionLimit
                        ? { nextSessionCursor: sessionCursor(q, shown.at(-1), row.project.projectId) }
                        : {}),
                };
            });
            const tail = page.at(-1);
            return {
                groups,
                context: q.context,
                hasMore: rows.length > limit,
                ...(rows.length > limit && tail
                    ? {
                        nextCursor: cursor(q, 'projects', [
                            tail.project.pinned,
                            tail.project.orderIndex,
                            Number(tail.listPosition),
                            tail.project.projectId,
                        ]),
                    }
                    : {}),
            };
        });
    }
    sessions(projectId, input) {
        if (projectId !== undefined && (!Number.isSafeInteger(projectId) || projectId <= 0))
            throw new SidebarQueryError('SIDEBAR_INVALID_FILTER', 'Invalid project');
        const q = this.normalizeQuery({ ...input, allProjects: projectId === undefined });
        const limit = pageLimit(input.limit, projectId === undefined ? 20 : 6);
        const last = readCursor(input.cursor, q, 'sessions', projectId);
        const rows = this.db
            .select({ record: s, project: p, done: isDone })
            .from(s)
            .innerJoin(p, eq(p.projectId, s.projectId))
            .where(and(projectId === undefined ? undefined : eq(s.projectId, projectId), sidebarPredicate(q), tupleAfter([sql `${s.updatedAtMs}`, sql `${s.createdAtMs}`, sql `${s.sessionId}`], last, [
            true,
            true,
            false,
        ])))
            .orderBy(desc(s.updatedAtMs), desc(s.createdAtMs), asc(s.sessionId))
            .limit(limit + 1)
            .all();
        const entries = rows.slice(0, limit).map((row) => entry(row, q));
        return {
            entries,
            context: q.context,
            hasMore: rows.length > limit,
            ...(rows.length > limit ? { nextCursor: sessionCursor(q, entries.at(-1), projectId) } : {}),
        };
    }
    agents(input, rootAgentNames = []) {
        // Candidate owners come from eligible historical conversations, independently
        // of the current filters and the configured Agent roster.
        const q = this.normalizeQuery({ ...input, filter: { showBunnyCreatedSessions: true }, scope: undefined }, rootAgentNames);
        const last = readCursor(input.cursor, q, 'agents');
        const limit = pageLimit(input.limit, 50);
        const rows = this.db
            .select({ name: canonicalOwner })
            .from(s)
            .innerJoin(p, eq(p.projectId, s.projectId))
            .where(and(eligible(false, q.internalRootIds, false, q), 
        // Unconfigured legacy CLI roots alone are not evidence of a usable Agent.
        // Preserve real branch tasks, configured roots and explicit Desktop/IM roots.
        sql `(${s.sessionType} <> 'root'
          OR ${canonicalOwner} IN (SELECT value FROM json_each(${JSON.stringify(rootAgentNames)}))
          OR json_extract(${s.recordJson}, '$.runLocation') IS NOT NULL
          OR ${s.purpose} = ${TRUSTED_IM_MARKER}
          OR substr(${s.purpose}, -${TRUSTED_IM_MARKER.length + 1}) = ${`\n${TRUSTED_IM_MARKER}`})`, sql `length(trim(${canonicalOwner})) > 0`, last ? sql `${canonicalOwner} > ${last[0]}` : undefined))
            .groupBy(canonicalOwner)
            .orderBy(asc(canonicalOwner))
            .limit(limit + 1)
            .all();
        return {
            names: rows.slice(0, limit).map((r) => r.name),
            context: q.context,
            hasMore: rows.length > limit,
            ...(rows.length > limit ? { nextCursor: cursor(q, 'agents', [rows[limit - 1].name]) } : {}),
        };
    }
    get(sessionId, bindingIds, cronTargetIds = []) {
        if (!sessionId?.trim())
            throw new SidebarQueryError('SIDEBAR_INVALID_FILTER', 'Session required');
        const q = this.normalizeQuery({
            bindingIds,
            cronTargetIds,
            filter: { showBunnyCreatedSessions: true },
        });
        const row = this.db
            .select({ record: s, project: p, done: isDone })
            .from(s)
            .innerJoin(p, eq(p.projectId, s.projectId))
            .where(and(eq(s.sessionId, sessionId), eligible(false, q.internalRootIds, false, q)))
            .get();
        if (!row) {
            const exists = this.db
                .select({ id: s.sessionId })
                .from(s)
                .where(eq(s.sessionId, sessionId))
                .get();
            throw new SidebarQueryError(exists ? 'SIDEBAR_SESSION_NOT_OPENABLE' : 'SESSION_NOT_FOUND', 'Session is not available', exists ? 403 : 404);
        }
        return entry(row, q);
    }
}
function cursor(q, kind, last, projectId) {
    return encodeObject({
        v: 1,
        context: q.context,
        kind,
        last,
        ...(projectId === undefined ? {} : { projectId }),
    });
}
function sessionCursor(q, value, projectId) {
    const session = value.session;
    return cursor(q, 'sessions', [session.updatedAtMs, session.createdAtMs, session.sessionId], projectId);
}
function entry(row, q) {
    const session = decodeSessionRow(row.record);
    return {
        session,
        done: !!row.done,
        types: [
            row.project.projectKind === 'default' ? 'chat' : 'task',
            ...(session.sessionKind === 'cron' || q.cronTargetIds.includes(session.sessionId)
                ? ['cron']
                : []),
            ...(session.sessionKind === 'channel' ||
                q.bindingIds.includes(session.sessionId) ||
                (session.sessionType === 'root' &&
                    session.sessionKind === 'conversation' &&
                    (session.purpose === TRUSTED_IM_MARKER ||
                        session.purpose?.endsWith(`\n${TRUSTED_IM_MARKER}`)))
                ? ['im']
                : []),
        ],
    };
}
//# sourceMappingURL=query.js.map