import { SidebarQueryError, ProjectServiceError, sessionTreeFilterFromRequest, } from '../../service/session-system/index.js';
import { AppError } from '../errors.js';
import { toSessionInfoView, toSessionTreeChildView } from '../session/wire.js';
import { toProjectDetail, toProjectReference } from './wire.js';
export class ProjectApplication {
    options;
    constructor(options) {
        this.options = options;
    }
    async querySidebarProjects(_context, req) {
        return this.invoke(async () => {
            const { sidebar, bindingIds, cronTargetIds } = await this.sidebarContext();
            const scope = await this.sidebarScope(req.scope);
            const page = sidebar.projects({ ...req, scope, bindingIds, cronTargetIds });
            const children = await this.options.sidebarChildren?.(page.groups.flatMap((g) => [...g.entries, ...(g.activeEntry ? [g.activeEntry] : [])].map((e) => e.session.sessionId)));
            return {
                ...page,
                groups: page.groups.map((group) => ({
                    ...group,
                    project: toProjectDetail(group.project, group.matchedCount),
                    entries: group.entries.map((value) => this.sidebarEntry(value, children)),
                    activeEntry: group.activeEntry
                        ? this.sidebarEntry(group.activeEntry, children)
                        : undefined,
                })),
            };
        });
    }
    async querySidebarProjectSessions(_context, req) {
        return this.invoke(async () => {
            const { sidebar, bindingIds, cronTargetIds } = await this.sidebarContext();
            if (!req.context && (!req.allProjects || req.cursor))
                throw new SidebarQueryError('SIDEBAR_QUERY_CONTEXT_MISMATCH', 'Context required');
            const scope = await this.sidebarScope(req.scope);
            if (req.allProjects && req.projectId !== undefined)
                throw new SidebarQueryError('SIDEBAR_INVALID_FILTER', 'Do not combine allProjects and projectId');
            const page = sidebar.sessions(req.allProjects ? undefined : (req.projectId ?? 0), {
                ...req,
                scope,
                bindingIds,
                cronTargetIds,
            });
            const children = await this.options.sidebarChildren?.(page.entries.map((e) => e.session.sessionId));
            return { ...page, entries: page.entries.map((value) => this.sidebarEntry(value, children)) };
        });
    }
    async querySidebarAgents(_context, req) {
        return this.invoke(async () => {
            const { sidebar, bindingIds, cronTargetIds } = await this.sidebarContext();
            if (!this.options.sidebarAgents)
                throw new AppError(501, 'NOT_IMPLEMENTED', 'Sidebar agent roster is unavailable');
            // Configuration only supplies display names. Deleted/unconfigured Agents
            // remain selectable while eligible historical conversations reference them.
            const roster = await this.options.sidebarAgents.list();
            const { names, ...page } = sidebar.agents({ ...req, bindingIds, cronTargetIds }, roster.map((agent) => agent.name));
            const byName = new Map(roster.map((agent) => [agent.name, agent]));
            const agents = names.map((name) => ({
                name,
                displayName: byName.get(name)?.displayName || name,
            }));
            return { ...page, agents };
        });
    }
    async getSidebarSession(_context, req) {
        return this.invoke(async () => {
            const { sidebar, bindingIds, cronTargetIds } = await this.sidebarContext();
            const value = sidebar.get(req.sessionId ?? '', bindingIds, cronTargetIds);
            const children = await this.options.sidebarChildren?.([value.session.sessionId]);
            return { entry: this.sidebarEntry(value, children) };
        });
    }
    async sidebarScope(scope) {
        if (!this.options.sidebarPins)
            throw new AppError(501, 'NOT_IMPLEMENTED', 'Sidebar pin facts are unavailable');
        const pins = await this.options.sidebarPins.getOrder();
        return {
            ...scope,
            excludedSessionIds: [
                ...(scope?.excludedSessionIds ?? []),
                ...pins.flatMap((item) => (item.ref.type === 'session' ? [item.ref.id] : [])),
            ],
            excludedProjectIds: [
                ...(scope?.excludedProjectIds ?? []),
                ...pins.flatMap((item) => item.ref.type === 'project' && item.project ? [item.project.projectId] : []),
            ],
        };
    }
    async sidebarContext() {
        if (!this.options.sidebar || !this.options.sidebarBindings || !this.options.sidebarCronTargets)
            throw new AppError(501, 'NOT_IMPLEMENTED', 'Sidebar queries are unavailable');
        return {
            sidebar: this.options.sidebar,
            bindingIds: await this.options.sidebarBindings.listSessionIds(),
            cronTargetIds: this.options.sidebarCronTargets(),
        };
    }
    sidebarEntry(value, children) {
        return {
            session: toSessionInfoView(value.session),
            types: value.types,
            done: value.done,
            childSessions: (children?.get(value.session.sessionId) ?? []).map(toSessionTreeChildView),
        };
    }
    async listProjects(_context, req) {
        const page = await this.invoke(() => this.options.service.list({
            agentName: req.agentName,
            sessionFilter: projectSessionFilter(req),
            includeHiddenProjects: req.includeHidden,
            limit: req.limit,
            cursor: req.cursor,
            sessionLimit: req.sessionLimit,
        }));
        return {
            projects: page.projects.map(toProjectSessionGroup),
            hasMore: page.hasMore,
            ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
        };
    }
    async listProjectSessions(_context, req) {
        const page = await this.invoke(() => this.options.service.listSessions(toProjectReference(req), {
            agentName: req.agentName,
            filter: projectSessionFilter(req),
            limit: req.limit,
            cursor: req.cursor,
        }));
        return {
            sessions: toProjectSessionPage(page),
            hasMore: page.hasMore,
            ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
        };
    }
    async setProjectPinned(_context, req) {
        const project = await this.invoke(() => this.options.pinService.pinProject(toProjectReference(req.project), req.pinned));
        return mutationResponse(project);
    }
    async setProjectHidden(_context, req) {
        const project = await this.invoke(() => this.options.service.setHidden(toProjectReference(req.project), req.hidden));
        return mutationResponse(project);
    }
    async putProjectsOrder(context, req) {
        await this.invoke(() => this.options.pinService.putProjectsOrder((req.projects ?? []).map(toProjectReference)));
        return this.listProjects(context, { includeHidden: true });
    }
    async archiveProjectSessions(_context, req) {
        const archived = await this.invoke(async () => {
            const project = await this.options.service.resolve(toProjectReference(req.project), true);
            const sessionIds = await this.options.service.listRootSessionIds(project.projectId, {
                agentName: req.agentName,
                filter: projectSessionFilter(req),
            });
            return archiveSessionsBestEffort(sessionIds, this.options.sessionArchive);
        });
        return {
            archivedCount: archived.archivedSessionIds.length,
            archivedSessionIds: archived.archivedSessionIds,
            failedSessionIds: archived.failedSessionIds,
        };
    }
    async listRecentProjects(_context, req) {
        const projects = await this.invoke(() => this.options.service.listRecent(req.limit));
        return {
            projects: projects.map((project) => toProjectDetail(project, project.sessionCount)),
        };
    }
    async touchRecentProject(_context, req) {
        const project = await this.invoke(() => this.options.service.touchRecent(toProjectReference(req.project)));
        return mutationResponse(project);
    }
    async invoke(operation) {
        try {
            return await operation();
        }
        catch (error) {
            if (error instanceof SidebarQueryError)
                throw new AppError(error.status, error.key, error.message);
            if (error instanceof ProjectServiceError) {
                const mapping = projectFailureMapping(error.reason);
                throw new AppError(mapping.status, mapping.key, error.message);
            }
            throw error;
        }
    }
}
/**
 * Projects include Cron roots because they are user-visible tasks associated
 * with a workspace. Ordinary conversation lists still exclude Cron's internal
 * execution tree through their default Session filter.
 */
function projectSessionFilter(request) {
    const { excludeSessionKinds, ...filter } = sessionTreeFilterFromRequest(request, false);
    const excluded = excludeSessionKinds?.filter((kind) => kind !== 'cron');
    return {
        ...filter,
        excludeInternalTreeSessions: false,
        ...(excluded?.length ? { excludeSessionKinds: excluded } : {}),
    };
}
async function archiveSessionsBestEffort(sessionIds, sessions) {
    const archivedSessionIds = [];
    const failedSessionIds = [];
    for (const sessionId of sessionIds) {
        try {
            await sessions.archiveSessionById(sessionId);
            archivedSessionIds.push(sessionId);
        }
        catch {
            failedSessionIds.push(sessionId);
        }
    }
    return { archivedSessionIds, failedSessionIds };
}
function toProjectSessionGroup(group) {
    return {
        project: toProjectDetail(group.project, group.sessionCount),
        sessions: group.sessions.map((session) => ({
            session: toSessionInfoView(session),
            childSessions: (group.childrenByParent.get(session.sessionId) ?? []).map(toSessionTreeChildView),
        })),
        hasMoreSessions: group.hasMoreSessions,
        ...(group.nextSessionCursor ? { nextSessionCursor: group.nextSessionCursor } : {}),
    };
}
function toProjectSessionPage(page) {
    return page.sessions.map((session) => ({
        session: toSessionInfoView(session),
        childSessions: (page.childrenByParent.get(session.sessionId) ?? []).map(toSessionTreeChildView),
    }));
}
function mutationResponse(project) {
    return { success: true, project: toProjectDetail(project, project.sessionCount) };
}
function projectFailureMapping(reason) {
    switch (reason) {
        case 'invalid-project-id':
            return { status: 400, key: 'INVALID_PROJECT_ID' };
        case 'project-required':
            return { status: 400, key: 'PROJECT_REQUIRED' };
        case 'invalid-workspace-dir':
            return { status: 400, key: 'INVALID_WORKSPACE_DIR' };
        case 'project-not-found':
            return { status: 404, key: 'PROJECT_NOT_FOUND' };
        case 'duplicate-project':
            return { status: 400, key: 'DUPLICATE_PROJECT' };
        case 'invalid-project-row':
            return { status: 500, key: 'INVALID_PROJECT_ROW' };
        case 'session-cursor-missing':
            return { status: 500, key: 'PROJECT_SESSION_CURSOR_MISSING' };
    }
}
//# sourceMappingURL=project-application.js.map