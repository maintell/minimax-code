import { and, asc, desc, eq, getTableColumns, gt, isNotNull, lt, or, sql, } from 'drizzle-orm';
import { DEFAULT_PROJECT_ORDER_INDEX, projects } from '../../../../infra/db/schema/projects.js';
import { sessions } from '../../../../infra/db/schema/sessions.js';
import { canonicalProjectWorkspaceDir } from '../../shared/workspace.js';
import { recordProjectRemoval, restoreSessionAfterProjectRemoval, } from '../../shared/project-removal.js';
import { eligible } from '../sidebar/predicate.js';
import { sessionAgentNamePredicate } from '../../sessions/repo/agent-name-predicate.js';
import { projectTaskRootPredicate } from '../../sessions/repo/filters.js';
import { decodeProjectCursor, normalizeProjectLimit, projectPageFromRows, } from './pagination.js';
import { channelProjectPredicate, explicitWorkspaceProjectPredicate, projectActivityExpression, projectListActivityExpression, } from './activity.js';
const projectSelection = {
    ...getTableColumns(projects),
    latestActivityAtMs: projectActivityExpression,
    sessionCount: sql `${projects.sessionCount} +
    (SELECT COUNT(*) FROM ${sessions} WHERE ${channelProjectPredicate} AND ${sessions.parentSessionId} IS NULL)`,
};
export function createProjectRepository(options) {
    return new DrizzleProjectRepository(options);
}
class DrizzleProjectRepository {
    options;
    constructor(options) {
        this.options = options;
    }
    async getById(projectId) {
        return decode(this.options.db
            .select(projectSelection)
            .from(projects)
            .where(eq(projects.projectId, projectId))
            .get());
    }
    async getSessionProjectId(sessionId) {
        return (this.options.db
            .select({ projectId: sessions.projectId })
            .from(sessions)
            .where(eq(sessions.sessionId, sessionId))
            .get()?.projectId ?? undefined);
    }
    async getByWorkspaceDir(workspaceDir) {
        const canonical = canonicalProjectWorkspaceDir(workspaceDir);
        return canonical
            ? decode(this.options.db
                .select(projectSelection)
                .from(projects)
                .where(eq(projects.workspaceDir, canonical))
                .get())
            : undefined;
    }
    async getDefault() {
        return decode(this.options.db
            .select(projectSelection)
            .from(projects)
            .where(eq(projects.projectKind, 'default'))
            .get());
    }
    async ensureByWorkspaceDir(workspaceDir, nowMs) {
        const canonical = canonicalProjectWorkspaceDir(workspaceDir);
        if (!canonical)
            return undefined;
        this.options.db
            .insert(projects)
            .values({
            projectKind: 'workspace',
            workspaceDir: canonical,
            createdAtMs: nowMs,
            updatedAtMs: nowMs,
        })
            .onConflictDoNothing()
            .run();
        return this.getByWorkspaceDir(canonical);
    }
    async ensureDefault(nowMs) {
        this.options.db
            .insert(projects)
            .values({
            projectKind: 'default',
            workspaceDir: null,
            createdAtMs: nowMs,
            updatedAtMs: nowMs,
        })
            .onConflictDoNothing()
            .run();
        const value = await this.getDefault();
        if (!value)
            throw new Error('Default Project was not created');
        return value;
    }
    async listPage(options) {
        const includeHiddenProjects = options.includeHiddenProjects === true || options.includeHidden === true;
        const kind = includeHiddenProjects ? 'catalog-all' : 'catalog-visible';
        const cursor = decodeProjectCursor(options.cursor, kind);
        const limit = normalizeProjectLimit(options.limit);
        const sessionCountExpression = this.options.db.$count(sessions, projectRootPredicate(options));
        const values = this.options.db
            .select({
            project: projects,
            filteredSessionCount: sessionCountExpression,
            listActivityAtMs: projectListActivityExpression,
        })
            .from(projects)
            .where(and(includeHiddenProjects ? undefined : eq(projects.hidden, 0), hasSessionFilter(options)
            ? gt(sessionCountExpression, 0)
            : or(gt(sessionCountExpression, 0), explicitWorkspaceProjectPredicate), cursor?.kind === 'catalog-visible' || cursor?.kind === 'catalog-all'
            ? catalogCursorPredicate(cursor)
            : undefined))
            .orderBy(desc(projects.pinned), asc(projects.orderIndex), desc(projectListActivityExpression), asc(projects.projectId))
            .limit(limit + 1)
            .all()
            .map(({ project, filteredSessionCount, listActivityAtMs }) => ({
            ...requiredDecode(project),
            sessionCount: Number(filteredSessionCount),
            latestActivityAtMs: listActivityAtMs,
        }));
        return projectPageFromRows(values, limit, kind);
    }
    async listRecent(options) {
        const cursor = decodeProjectCursor(options.cursor, 'recent');
        const limit = normalizeProjectLimit(options.limit);
        const values = this.options.db
            .select(projectSelection)
            .from(projects)
            .where(and(isNotNull(projects.recentAtMs), cursor?.kind === 'recent' ? recentCursorPredicate(cursor) : undefined))
            .orderBy(desc(projects.recentAtMs), asc(projects.projectId))
            .limit(limit + 1)
            .all()
            .map(requiredDecode);
        return projectPageFromRows(values, limit, 'recent');
    }
    async setIcon(projectId, iconJson, nowMs) {
        return this.setMetadata(projectId, { iconJson }, nowMs);
    }
    async setDisplayName(projectId, displayName, nowMs) {
        return this.setMetadata(projectId, { displayName }, nowMs);
    }
    async setMetadata(projectId, metadata, nowMs) {
        // Metadata and any legacy removal boundary are committed together;
        // updatedAt advances once and other metadata remains unchanged.
        const { displayName, iconJson, workspaceRoots, unhide } = metadata;
        if (displayName === undefined &&
            iconJson === undefined &&
            workspaceRoots === undefined &&
            !unhide) {
            return this.getById(projectId);
        }
        const extraDataPaths = [];
        if (iconJson !== undefined)
            extraDataPaths.push(sql `'$.projectIcon', json(${iconJson})`);
        if (workspaceRoots !== undefined) {
            extraDataPaths.push(sql `'$.workspaceRoots', json(${JSON.stringify(workspaceRoots)})`);
        }
        this.options.db.transaction((tx) => {
            if (unhide) {
                const project = tx.select().from(projects).where(eq(projects.projectId, projectId)).get();
                if (project?.hidden && !JSON.parse(project.extraDataJson).sidebarRemoval) {
                    recordProjectRemoval(tx, project, project.updatedAtMs);
                }
            }
            tx.update(projects)
                .set({
                ...(extraDataPaths.length > 0
                    ? {
                        extraDataJson: sql `json_set(${projects.extraDataJson}, ${sql.join(extraDataPaths, sql `, `)})`,
                    }
                    : {}),
                ...(displayName !== undefined ? { displayName } : {}),
                ...(unhide ? { hidden: 0 } : {}),
                updatedAtMs: sql `max(${projects.updatedAtMs} + 1, ${nowMs})`,
            })
                .where(eq(projects.projectId, projectId))
                .run();
        });
        return this.getById(projectId);
    }
    async setPinned(projectId, pinned, nowMs) {
        return this.update(projectId, {
            pinned: pinned ? 1 : 0,
            ...(pinned ? {} : { orderIndex: DEFAULT_PROJECT_ORDER_INDEX }),
            updatedAtMs: nowMs,
        });
    }
    async setHidden(projectId, hidden, nowMs) {
        this.options.db.transaction((tx) => {
            const project = tx
                .select({ projectId: projects.projectId })
                .from(projects)
                .where(eq(projects.projectId, projectId))
                .get();
            if (!project)
                return;
            if (hidden)
                recordProjectRemoval(tx, project, nowMs);
            tx.update(projects)
                .set({ hidden: hidden ? 1 : 0, updatedAtMs: nowMs })
                .where(eq(projects.projectId, projectId))
                .run();
        });
        return this.getById(projectId);
    }
    async restoreSessionAfterRemoval(sessionId, nowMs) {
        return this.options.db.transaction((tx) => restoreSessionAfterProjectRemoval(tx, sessionId, nowMs, () => Boolean(tx
            .select({ id: sessions.sessionId })
            .from(sessions)
            .innerJoin(projects, eq(sessions.projectId, projects.projectId))
            .where(and(eq(sessions.sessionId, sessionId), eligible(true)))
            .get())));
    }
    async putOrder(projectIds, nowMs) {
        this.options.db.transaction((tx) => projectIds.forEach((projectId, orderIndex) => {
            tx.update(projects)
                .set({ pinned: 1, orderIndex, updatedAtMs: nowMs })
                .where(eq(projects.projectId, projectId))
                .run();
        }));
    }
    async touchRecent(projectId, nowMs) {
        return this.update(projectId, { recentAtMs: nowMs, updatedAtMs: nowMs });
    }
    async update(projectId, fields) {
        this.options.db.update(projects).set(fields).where(eq(projects.projectId, projectId)).run();
        return this.getById(projectId);
    }
}
const DEFAULT_PROJECT_SESSION_FILTER = {
    archived: false,
    includeHidden: false,
    excludeInternalTreeSessions: true,
};
function projectRootPredicate(options) {
    return and(eq(sessions.columnarVersion, 3), eq(sessions.projectId, projects.projectId), sessionAgentNamePredicate(options.agentName), projectTaskRootPredicate(options.sessionFilter ?? DEFAULT_PROJECT_SESSION_FILTER));
}
/** Agent or purpose scoping lists only projects that have matching conversations. */
function hasSessionFilter(options) {
    const filter = options.sessionFilter;
    return Boolean(options.agentName ||
        filter?.archived === true ||
        filter?.includeSessionKinds?.length ||
        filter?.excludeSessionKinds?.length ||
        filter?.includePurposePrefix ||
        filter?.excludePurposePrefix);
}
function catalogCursorPredicate(cursor) {
    const pinned = cursor.pinned ? 1 : 0;
    return or(lt(projects.pinned, pinned), and(eq(projects.pinned, pinned), gt(projects.orderIndex, cursor.orderIndex)), and(eq(projects.pinned, pinned), eq(projects.orderIndex, cursor.orderIndex), lt(projectListActivityExpression, cursor.latestActivityAtMs)), and(eq(projects.pinned, pinned), eq(projects.orderIndex, cursor.orderIndex), eq(projectListActivityExpression, cursor.latestActivityAtMs), gt(projects.projectId, cursor.projectId)));
}
function recentCursorPredicate(cursor) {
    return or(lt(projects.recentAtMs, cursor.recentAtMs), and(eq(projects.recentAtMs, cursor.recentAtMs), gt(projects.projectId, cursor.projectId)));
}
function decode(row) {
    return row ? requiredDecode(row) : undefined;
}
function requiredDecode(row) {
    return {
        ...row,
        projectKind: row.projectKind === 'default' ? 'default' : 'workspace',
        pinned: row.pinned === 1,
        hidden: row.hidden === 1,
    };
}
//# sourceMappingURL=drizzle.js.map