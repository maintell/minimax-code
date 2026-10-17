import { canonicalProjectWorkspaceDir } from '../shared/workspace.js';
import { projectPrimarySessionAgentName } from '../sessions/agent-name.js';
import { DEFAULT_PROJECT_KEY } from './contracts.js';
import { ProjectServiceError } from './errors.js';
export class ProjectService {
    options;
    nowMs;
    constructor(options) {
        this.options = options;
        this.nowMs = options.nowMs ?? Date.now;
    }
    async list(input) {
        const page = await this.options.projects.listPage(input);
        const sessionLimit = normalizeLimit(input.sessionLimit, 5);
        const projectIds = page.projects.map(({ projectId }) => projectId);
        const rootsByProject = await this.options.sessions.listProjectRootPreviews(projectIds, {
            agentName: input.agentName,
            ...input.sessionFilter,
            limit: sessionLimit,
        });
        const roots = [...rootsByProject.values()].flatMap((value) => value.sessions);
        const childrenByParent = await this.options.sessions.listChildrenMany(roots.map(({ sessionId }) => sessionId), input.sessionFilter);
        const projectedChildrenByParent = projectPrimaryChildren(childrenByParent, input.agentName);
        return {
            projects: page.projects.map((project) => {
                const preview = rootsByProject.get(project.projectId) ?? {
                    sessions: [],
                    hasMore: false,
                };
                return {
                    project,
                    sessionCount: project.sessionCount,
                    sessions: projectPrimarySessions(preview.sessions, input.agentName),
                    childrenByParent: projectedChildrenByParent,
                    hasMoreSessions: preview.hasMore,
                    ...(preview.nextCursor ? { nextSessionCursor: preview.nextCursor } : {}),
                };
            }),
            hasMore: page.hasMore,
            ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
        };
    }
    async listSessions(reference, input) {
        const project = await this.resolve(reference);
        const roots = await this.options.sessions.listProjectRootPage({
            projectId: project.projectId,
            agentName: input.agentName,
            ...input.filter,
            limit: input.limit,
            cursor: input.cursor,
        });
        const childrenByParent = await this.options.sessions.listChildrenMany(roots.sessions.map(({ sessionId }) => sessionId), input.filter);
        return {
            ...roots,
            sessions: projectPrimarySessions(roots.sessions, input.agentName),
            childrenByParent: projectPrimaryChildren(childrenByParent, input.agentName),
        };
    }
    async setPinned(reference, pinned) {
        const project = await this.resolve(reference, true);
        return requireProject(await this.options.projects.setPinned(project.projectId, pinned, this.nowMs()));
    }
    async setHidden(reference, hidden) {
        const project = await this.resolve(reference, true);
        return requireProject(await this.options.projects.setHidden(project.projectId, hidden, this.nowMs()));
    }
    async putOrder(references) {
        const records = await this.resolveOrder(references);
        await this.options.projects.putOrder(records.map(({ projectId }) => projectId), this.nowMs());
        return records;
    }
    async canonicalizeReferences(references) {
        return (await this.lookupUnique(references)).map(canonicalProjectReference);
    }
    async resolveOrder(references) {
        const candidates = await this.lookupUnique(references);
        const records = await Promise.all(candidates.map(async ({ project, workspaceDir, defaultProject }) => {
            if (project)
                return project;
            if (defaultProject)
                return this.options.projects.ensureDefault(this.nowMs());
            if (!workspaceDir) {
                throw new ProjectServiceError('project-required', 'project reference is required');
            }
            return requireProject(await this.options.projects.ensureByWorkspaceDir(workspaceDir, this.nowMs()));
        }));
        return records;
    }
    async listRecent(limit) {
        return (await this.options.projects.listRecent({ limit })).projects;
    }
    async touchRecent(reference) {
        const project = await this.resolve(reference);
        return requireProject(await this.options.projects.touchRecent(project.projectId, this.nowMs()));
    }
    resolve(reference, createWorkspace = false) {
        return this.resolveProject(reference, createWorkspace);
    }
    /**
     * Resolves an existing Session's Project through its persisted foreign key.
     *
     * Missing legacy associations fail closed. A present but malformed Project
     * row is corrupt data and must remain visible to the caller.
     */
    async resolveSessionProjectIdentity(sessionId) {
        const projectId = await this.options.projects.getSessionProjectId(sessionId);
        if (projectId === undefined)
            return undefined;
        const project = await this.options.projects.getById(projectId);
        if (!project)
            return undefined;
        if (project.projectKind === 'default') {
            if (project.workspaceDir !== null) {
                throw new ProjectServiceError('invalid-project-row', 'default Project must not have workspace path');
            }
            return { projectKey: DEFAULT_PROJECT_KEY, projectKind: 'default' };
        }
        const workspaceDir = requireWorkspaceProjectDir(project);
        if (canonicalProjectWorkspaceDir(workspaceDir) !== workspaceDir) {
            throw new ProjectServiceError('invalid-project-row', 'workspace Project path must be canonical');
        }
        return {
            projectKey: `workspace:${workspaceDir}`,
            projectKind: 'workspace',
            workspaceDir,
        };
    }
    async listRootSessionIds(projectId, input) {
        const sessionIds = [];
        let cursor;
        do {
            const page = await this.options.sessions.listProjectRootPage({
                projectId,
                agentName: input.agentName,
                ...input.filter,
                limit: 200,
                ...(cursor ? { cursor } : {}),
            });
            sessionIds.push(...page.sessions.map(({ sessionId }) => sessionId));
            cursor = page.hasMore ? page.nextCursor : undefined;
            if (page.hasMore && !cursor) {
                throw new ProjectServiceError('session-cursor-missing', 'Project Session page is missing a continuation cursor');
            }
        } while (cursor);
        return sessionIds;
    }
    async resolveProject(reference, createWorkspace) {
        const { project, workspaceDir, defaultProject } = await this.lookup(reference);
        if (project)
            return project;
        if (createWorkspace && defaultProject) {
            return this.options.projects.ensureDefault(this.nowMs());
        }
        if (createWorkspace && workspaceDir) {
            return requireProject(await this.options.projects.ensureByWorkspaceDir(workspaceDir, this.nowMs()));
        }
        return requireProject(undefined);
    }
    async lookup(reference) {
        if (reference.projectId !== undefined) {
            if (!Number.isSafeInteger(reference.projectId) || reference.projectId <= 0) {
                throw new ProjectServiceError('invalid-project-id', 'project_id must be positive');
            }
            return { project: requireProject(await this.options.projects.getById(reference.projectId)) };
        }
        if (reference.projectKey === DEFAULT_PROJECT_KEY) {
            return {
                project: await this.options.projects.getDefault(),
                defaultProject: true,
            };
        }
        const requestedWorkspace = reference.workspaceDir?.trim() || workspaceDirFromReferenceKey(reference.projectKey);
        if (!requestedWorkspace) {
            throw new ProjectServiceError('project-required', 'project reference is required');
        }
        const workspaceDir = canonicalProjectWorkspaceDir(requestedWorkspace);
        if (!workspaceDir) {
            throw new ProjectServiceError('invalid-workspace-dir', 'workspace_dir must be absolute');
        }
        return {
            project: await this.options.projects.getByWorkspaceDir(workspaceDir),
            workspaceDir,
        };
    }
    async lookupUnique(references) {
        const candidates = await Promise.all(references.map((reference) => this.lookup(reference)));
        const identities = candidates.map(projectIdentity);
        if (new Set(identities).size !== identities.length) {
            throw new ProjectServiceError('duplicate-project', 'duplicate project in order');
        }
        return candidates;
    }
}
function projectPrimarySessions(sessions, requestedAgentName) {
    return requestedAgentName
        ? sessions.map((session) => projectPrimarySessionAgentName(session, requestedAgentName))
        : sessions;
}
function projectPrimaryChildren(childrenByParent, requestedAgentName) {
    if (!requestedAgentName)
        return childrenByParent;
    return new Map([...childrenByParent].map(([parentSessionId, children]) => [
        parentSessionId,
        projectPrimarySessions(children, requestedAgentName),
    ]));
}
export function requireWorkspaceProjectDir(project) {
    if (project.projectKind !== 'workspace' || !project.workspaceDir) {
        throw new ProjectServiceError('invalid-project-row', 'workspace Project is missing path');
    }
    return project.workspaceDir;
}
function projectIdentity(lookup) {
    if (lookup.project)
        return `id:${String(lookup.project.projectId)}`;
    if (lookup.defaultProject)
        return DEFAULT_PROJECT_KEY;
    return `workspace:${String(lookup.workspaceDir)}`;
}
function canonicalProjectReference(lookup) {
    if (lookup.project?.projectKind === 'default' || lookup.defaultProject) {
        return { projectKey: DEFAULT_PROJECT_KEY };
    }
    const workspaceDir = lookup.project
        ? requireWorkspaceProjectDir(lookup.project)
        : lookup.workspaceDir;
    if (!workspaceDir) {
        throw new ProjectServiceError('project-required', 'project reference is required');
    }
    return { projectKey: `workspace:${workspaceDir}` };
}
function requireProject(project) {
    if (!project)
        throw new ProjectServiceError('project-not-found', 'project not found');
    return project;
}
function normalizeLimit(value, fallback) {
    if (!Number.isFinite(value))
        return fallback;
    const normalized = Math.floor(value);
    return normalized > 0 ? Math.min(normalized, 200) : fallback;
}
function workspaceDirFromReferenceKey(projectKey) {
    if (!projectKey?.startsWith('workspace:'))
        return undefined;
    return projectKey.slice('workspace:'.length).trim() || undefined;
}
//# sourceMappingURL=service.js.map