import { logger } from '../common/logger.js';
import { parseExplicitStableName } from '../agent/contract.js';
import { canonicalProjectWorkspaceDir, DEFAULT_PROJECT_KEY, normalizeAbsolutePath, projectForSession, projectKeyForWorkspace, workspaceDirFromProjectKey, } from './canonical-workspace.js';
import { aggregateFromKey, compareProjects, compareSessions, normalizePositiveInteger, paginate, rootTaskSessions, } from './helpers.js';
import { pageProjectSessions, toProjectDetail } from './wire.js';
export class LocalProjectContractError extends Error {
    status;
    code;
    constructor(status, message, code) {
        super(message);
        this.status = status;
        this.code = code;
        this.name = 'LocalProjectContractError';
    }
}
export class LocalProjectService {
    deps;
    // `isDefaultWorkspaceSession` is called during both aggregation and view
    // rendering for one snapshot. Keep the compatibility log at most once per
    // record, while allowing a discarded record to be collected with no strong
    // reference held by the project service.
    loggedLegacyAliasSessions = new WeakSet();
    constructor(deps) {
        this.deps = deps;
    }
    async listProjects(req) {
        const states = await this.deps.stateStore.readAll();
        const aggregates = await this.listAggregates(req, states);
        const visible = req.includeHidden
            ? aggregates
            : aggregates.filter((aggregate) => !aggregate.state?.hidden);
        // Only paginate aggregates the sidebar will actually render. `aggregate.sessions`
        // is already narrowed to root branch tasks (see `listAggregates`), so
        // `sessionCount = aggregate.sessions.length`; anything at 0 is either an
        // orphan `pinned`/`recentAt` state left over from a deleted project or a
        // workspace whose only sessions are child/non-branch. `groupSessionsByProject`
        // in the UI drops both (`if (project.sessionCount <= 0) continue;`), so
        // counting them here would inflate `hasMore` and leave a dead-end "更多"
        // button that the user has no way to satisfy.
        const renderable = visible.filter((aggregate) => aggregate.sessions.length > 0);
        const sorted = renderable.sort(compareProjects);
        const page = paginate(sorted, req.cursor, normalizePositiveInteger(req.limit) ?? 50);
        const sessionLimit = normalizePositiveInteger(req.sessionLimit) ?? 5;
        return {
            projects: page.items.map((aggregate) => ({
                project: toProjectDetail(aggregate),
                ...pageProjectSessions(aggregate.sessions, aggregate.allSessions, undefined, sessionLimit, (session) => this.isDefaultWorkspaceSession(session)),
            })),
            hasMore: page.hasMore,
            nextCursor: page.nextCursor,
        };
    }
    /** Resolve one project ref for pinned-item payload hydration. */
    async getProjectByKey(projectKey) {
        const states = await this.deps.stateStore.readAll();
        const aggregates = await this.listAggregates({}, states);
        const aggregate = aggregates.find((candidate) => candidate.key === projectKey);
        if (aggregate)
            return toProjectDetail(aggregate);
        const state = states[projectKey];
        return state ? toProjectDetail(aggregateFromKey(projectKey, state)) : undefined;
    }
    async listProjectSessions(req) {
        const workspaceDir = this.resolveProjectWorkspace(req);
        const sessions = await this.listProjectSessionsForWorkspace({
            agentName: req.agentName,
            workspaceDir,
            excludePurposePrefix: req.excludePurposePrefix,
            includePurposePrefix: req.includePurposePrefix,
            includeArchived: false,
        });
        // pageProjectSessions returns ProjectSessionGroup-shaped pagination fields
        // (`hasMoreSessions` / `nextSessionCursor`) because it also feeds
        // `listProjects`. `ListProjectSessionsResp` expects the flat
        // `hasMore` / `nextCursor` naming — remap explicitly so thrift wire keeps
        // pagination alive and the sidebar's "Load more" button actually works.
        const page = pageProjectSessions(rootTaskSessions(sessions), sessions, req.cursor, normalizePositiveInteger(req.limit) ?? 50, (session) => this.isDefaultWorkspaceSession(session));
        return {
            sessions: page.sessions,
            hasMore: page.hasMoreSessions,
            nextCursor: page.nextSessionCursor,
        };
    }
    async setProjectPinned(req) {
        const detail = await this.patchProjectState(req.project, { pinned: req.pinned });
        return { success: true, project: detail };
    }
    async setProjectHidden(req) {
        const detail = await this.patchProjectState(req.project, { hidden: req.hidden });
        return { success: true, project: detail };
    }
    async putProjectsOrder(req) {
        const refs = req.projects ?? [];
        const seen = new Set();
        const states = await this.deps.stateStore.readAll();
        refs.forEach((ref, index) => {
            const key = this.resolveProjectKey(ref);
            if (seen.has(key)) {
                throw new LocalProjectContractError(400, 'duplicate project in order', 'DUPLICATE_PROJECT');
            }
            seen.add(key);
            states[key] = { ...(states[key] ?? {}), pinned: true, orderIndex: index };
        });
        await this.deps.stateStore.replaceAll(states);
        return this.listProjects({ includeHidden: true });
    }
    async archiveProjectSessions(req) {
        const workspaceDir = this.resolveProjectWorkspace(req.project);
        // The UI uses the explicit namespace for an exact historic owner (for
        // example `agent:general`).
        // Archive is an exact-owner mutation, so strip only that ingress marker;
        // bare historical owners remain exact and are never widened into a family.
        const exactAgentName = req.agentName?.toLowerCase().startsWith('agent:')
            ? parseExplicitStableName(req.agentName)
            : req.agentName;
        const sessions = rootTaskSessions(await this.listProjectSessionsForWorkspace({
            ...(exactAgentName !== undefined ? { agentName: exactAgentName } : {}),
            workspaceDir,
            excludePurposePrefix: req.excludePurposePrefix,
            includeArchived: false,
            // Reads intentionally aggregate a canonical AgentName family. Archive
            // is destructive, so keep the selected persisted owner exact.
            exactAgentOwner: true,
        }));
        const archivedSessionIds = [];
        const failedSessionIds = [];
        for (const session of sessions) {
            if (await this.deps.isReadOnlyLegacySession?.(session)) {
                failedSessionIds.push(session.sessionId);
                continue;
            }
            const updated = await this.deps.updateSession(session.sessionId, {
                archived: true,
                updatedAtMs: this.deps.nowMs(),
            });
            if (updated)
                archivedSessionIds.push(session.sessionId);
            else
                failedSessionIds.push(session.sessionId);
        }
        return {
            archivedCount: archivedSessionIds.length,
            archivedSessionIds,
            failedSessionIds,
        };
    }
    async listRecentProjects(req) {
        const states = await this.deps.stateStore.readAll();
        const aggregates = await this.listAggregates({}, states);
        const byKey = new Map(aggregates.map((aggregate) => [aggregate.key, aggregate]));
        const projects = Object.entries(states)
            .filter(([, state]) => state.recentAt !== undefined)
            .sort((left, right) => (right[1].recentAt ?? 0) - (left[1].recentAt ?? 0))
            .slice(0, normalizePositiveInteger(req.limit) ?? 20)
            .map(([key, state]) => toProjectDetail(byKey.get(key) ?? aggregateFromKey(key, state)));
        return { projects };
    }
    async touchRecentProject(req) {
        const detail = await this.patchProjectState(req.project, { recentAt: this.deps.nowMs() });
        return { success: true, project: detail };
    }
    async patchProjectState(ref, patch) {
        const key = this.resolveProjectKey(ref);
        const state = await this.deps.stateStore.patch(key, patch);
        return toProjectDetail(aggregateFromKey(key, state));
    }
    async listAggregates(req, states) {
        const owner = await this.resolveOwnerFilter(req.agentName, {
            archived: req.includeArchived ? undefined : false,
            includeHidden: true,
            excludePurposePrefix: req.excludePurposePrefix,
            includePurposePrefix: req.includePurposePrefix,
        });
        const sessions = await this.deps.listAllSessions(owner.agentName, owner.options);
        const groups = new Map();
        for (const session of sessions) {
            const workspaceDir = this.projectWorkspaceDir(session);
            const key = projectKeyForWorkspace(workspaceDir);
            const aggregate = groups.get(key) ?? {
                key,
                workspaceDir,
                sessions: [],
                allSessions: [],
                state: states[key],
            };
            aggregate.allSessions.push(session);
            if (isRenderableProjectRootTask(session)) {
                aggregate.sessions.push(session);
            }
            if (session.visibility !== 'hidden') {
                aggregate.latestActivityAt = Math.max(aggregate.latestActivityAt ?? 0, session.updatedAtMs, session.createdAtMs);
            }
            groups.set(key, aggregate);
        }
        for (const [key, state] of Object.entries(states)) {
            if (!groups.has(key) && (state.pinned || state.recentAt)) {
                groups.set(key, aggregateFromKey(key, state));
            }
        }
        return [...groups.values()].map((aggregate) => ({
            ...aggregate,
            sessions: aggregate.sessions.sort(compareSessions),
            allSessions: aggregate.allSessions.sort(compareSessions),
            state: states[aggregate.key] ?? aggregate.state,
        }));
    }
    async listProjectSessionsForWorkspace(input) {
        const options = {
            archived: input.includeArchived ? undefined : false,
            includeHidden: false,
            excludePurposePrefix: input.excludePurposePrefix,
            includePurposePrefix: input.includePurposePrefix,
        };
        const owner = input.exactAgentOwner
            ? {
                ...(input.agentName ? { agentName: input.agentName } : {}),
                options,
            }
            : await this.resolveOwnerFilter(input.agentName, options);
        const sessions = await this.deps.listAllSessions(owner.agentName, owner.options);
        return sessions
            .filter((session) => {
            const workspaceDir = canonicalProjectWorkspaceDir(session.workspaceDir, session.runLocation);
            if (this.isDefaultWorkspaceSession(session)) {
                return input.workspaceDir === undefined;
            }
            return (workspaceDir ?? undefined) === input.workspaceDir;
        })
            .sort(compareSessions);
    }
    async resolveOwnerFilter(requestedName, options) {
        if (!requestedName || !this.deps.resolveAgentReadScope) {
            return {
                ...(requestedName ? { agentName: requestedName } : {}),
                options,
            };
        }
        const scope = await this.deps.resolveAgentReadScope(requestedName);
        return { options: { ...options, agentNames: scope.compatibleNames } };
    }
    projectWorkspaceDir(session) {
        if (this.isDefaultWorkspaceSession(session))
            return undefined;
        return canonicalProjectWorkspaceDir(session.workspaceDir, session.runLocation);
    }
    isDefaultWorkspaceSession(session) {
        const projection = projectForSession(session, this.deps);
        // Only this final, strict alias branch is observable. It runs only after
        // excluding an explicit runLocation, persisted `isDefaultWorkspace === true`,
        // the runtime default path, and the current per-session fallback path; the
        // historical alias is therefore the reason this read classifies the session as `default`.
        // Keep the log free of workspace/parent paths because sessionId is enough
        // to correlate the compatibility read without exposing a user directory.
        if (projection.defaultReason === 'legacy-data-dir-alias' &&
            !this.loggedLegacyAliasSessions.has(session)) {
            this.loggedLegacyAliasSessions.add(session);
            logger.info({
                operation: 'classify_project_session',
                reason: 'legacy_data_dir_alias',
                sessionId: session.sessionId,
                projectKey: DEFAULT_PROJECT_KEY,
            }, 'Classified legacy data-dir alias as default project');
        }
        return projection.projectKey === DEFAULT_PROJECT_KEY;
    }
    resolveProjectKey(ref) {
        const workspaceDir = this.resolveProjectWorkspace(ref);
        return projectKeyForWorkspace(workspaceDir);
    }
    resolveProjectWorkspace(ref) {
        if (ref.projectId !== undefined) {
            throw new LocalProjectContractError(400, 'project_id is not supported by desktop local-runtime', 'VALIDATION_ERROR');
        }
        const fromWorkspace = normalizeAbsolutePath(ref.workspaceDir);
        if (ref.workspaceDir && !fromWorkspace) {
            throw new LocalProjectContractError(400, 'workspace_dir must be absolute', 'INVALID_WORKSPACE_DIR');
        }
        const keyOrProjectKey = ref.projectKey ?? ref.key;
        const fromKey = workspaceDirFromProjectKey(keyOrProjectKey);
        if (keyOrProjectKey === DEFAULT_PROJECT_KEY)
            return undefined;
        return fromWorkspace ?? fromKey;
    }
}
function isRenderableProjectRootTask(session) {
    return (!session.parentSessionId && session.sessionType === 'branch' && session.visibility !== 'hidden');
}
//# sourceMappingURL=service.js.map