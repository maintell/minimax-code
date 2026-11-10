import { parseProjectIcon } from '@mavis/shared/project-icon';
import { canonicalProjectWorkspaceDir } from '../shared/workspace.js';
import { projectPrimarySessionAgentName } from '../sessions/agent-name.js';
import { DEFAULT_PROJECT_KEY } from './contracts.js';
import { ProjectServiceError } from './errors.js';
import { hasStoredWorkspaceRoots, projectWorkspaceRoots, validateWorkspaceRoots, } from './workspace-roots.js';
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
    async updateIcon(reference, extraDataJson) {
        return this.updateMetadata(reference, { extraDataJson });
    }
    /** Empty (after trim) restores the directory default; the folder itself never changes. */
    async updateDisplayName(reference, raw) {
        return this.updateMetadata(reference, { displayName: raw });
    }
    /** Validates every requested field before one atomic write; absent fields stay unchanged. */
    async updateMetadata(reference, input) {
        const displayName = input.displayName === undefined ? undefined : normalizeProjectDisplayName(input.displayName);
        const iconJson = input.extraDataJson === undefined ? undefined : parseIconPatch(input.extraDataJson);
        const project = await this.resolve(reference, true);
        if (displayName !== undefined && project.projectKind === 'default') {
            throw new ProjectServiceError('default-project-name', 'The default project name cannot be changed');
        }
        const workspaceRoots = input.workspaceRoots === undefined
            ? undefined
            : await replacementWorkspaceRoots(project, input.workspaceRoots);
        return requireProject(await this.options.projects.setMetadata(project.projectId, {
            ...(displayName !== undefined ? { displayName } : {}),
            ...(iconJson !== undefined ? { iconJson } : {}),
            ...(workspaceRoots !== undefined ? { workspaceRoots } : {}),
        }, this.nowMs()));
    }
    /**
     * Creates a workspace Project keyed by its primary folder. A row that only
     * exists implicitly (created by an earlier conversation and never set up by
     * the user) or was removed from the sidebar is taken over; a project the
     * user already set up is a conflict.
     */
    async create(input) {
        const workspaceDir = createWorkspaceDir(input);
        const displayName = normalizeProjectDisplayName(input.displayName);
        const iconJson = input.extraDataJson ? parseIconPatch(input.extraDataJson) : undefined;
        const requestedRoots = input.workspaceRoots?.length ? input.workspaceRoots : [workspaceDir];
        const workspaceRoots = await validateWorkspaceRoots(withCanonicalPrimary(requestedRoots, workspaceDir), workspaceDir);
        const existing = await this.options.projects.getByWorkspaceDir(workspaceDir);
        assertCreatable(existing, workspaceDir);
        const project = existing ??
            requireProject(await this.options.projects.ensureByWorkspaceDir(workspaceDir, this.nowMs()));
        return requireProject(await this.options.projects.setMetadata(project.projectId, {
            // An empty name keeps the name a taken-over row already had.
            displayName: displayName ?? project.displayName,
            workspaceRoots,
            ...(iconJson !== undefined ? { iconJson } : {}),
            ...(project.hidden ? { unhide: true } : {}),
        }, this.nowMs()));
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
/** Mirrors the Desktop project-name limit (`MAX_PROJECT_NAME_LENGTH` in the UI modals). */
export const PROJECT_DISPLAY_NAME_MAX_LENGTH = 50;
const CONTROL_CHARACTER = /\p{Cc}/u;
function normalizeProjectDisplayName(raw) {
    const trimmed = raw.trim();
    if (!trimmed)
        return null;
    if (trimmed.length > PROJECT_DISPLAY_NAME_MAX_LENGTH) {
        throw new ProjectServiceError('invalid-project-name', `Project name cannot exceed ${PROJECT_DISPLAY_NAME_MAX_LENGTH} characters`);
    }
    if (CONTROL_CHARACTER.test(trimmed)) {
        throw new ProjectServiceError('invalid-project-name', 'Project name contains control characters');
    }
    return trimmed;
}
function parseIconPatch(extraDataJson) {
    let patch;
    try {
        if (extraDataJson.length > 1024)
            throw new Error('oversized');
        patch = JSON.parse(extraDataJson);
    }
    catch {
        throw new ProjectServiceError('invalid-project-icon', 'Invalid project icon metadata');
    }
    if (!patch ||
        typeof patch !== 'object' ||
        Array.isArray(patch) ||
        Object.keys(patch).length !== 1 ||
        !Object.hasOwn(patch, 'projectIcon')) {
        throw new ProjectServiceError('invalid-project-icon', 'Only projectIcon metadata may be updated');
    }
    const raw = patch.projectIcon;
    const icon = parseProjectIcon(raw);
    if (raw !== null && !icon) {
        throw new ProjectServiceError('invalid-project-icon', 'Invalid project icon');
    }
    return JSON.stringify(icon);
}
function requireProject(project) {
    if (!project)
        throw new ProjectServiceError('project-not-found', 'project not found');
    return project;
}
/** Set up by the user through CreateProject / a folder edit. */
function isUserProject(project) {
    return hasStoredWorkspaceRoots(project);
}
function createWorkspaceDir(input) {
    const workspaceDir = canonicalProjectWorkspaceDir(input.workspaceDir?.trim() || input.workspaceRoots?.[0]);
    if (!workspaceDir) {
        throw new ProjectServiceError('invalid-workspace-dir', 'workspace_dir must be absolute');
    }
    return workspaceDir;
}
/** The primary folder may arrive as a worktree path that keys to its repository. */
function withCanonicalPrimary(roots, primary) {
    const [first, ...rest] = roots;
    return first !== undefined && canonicalProjectWorkspaceDir(first) === primary
        ? [primary, ...rest]
        : roots;
}
/** A visible project the user already set up owns its primary folder. */
function assertCreatable(existing, workspaceDir) {
    if (!existing || existing.hidden || !isUserProject(existing))
        return;
    throw new ProjectServiceError('project-conflict', `This folder is already the project ${existing.displayName ?? projectFolderName(workspaceDir)}`);
}
/**
 * The primary folder is the project key and stays locked; only the additional
 * folders can be added or removed.
 */
async function replacementWorkspaceRoots(project, requested) {
    if (project.projectKind !== 'workspace') {
        throw new ProjectServiceError('invalid-workspace-roots', 'The default project has no folders');
    }
    const primary = requireWorkspaceProjectDir(project);
    return validateWorkspaceRoots(withCanonicalPrimary(requested, primary), primary, projectWorkspaceRoots(project));
}
function projectFolderName(workspaceDir) {
    return workspaceDir.split(/[\\/]+/u).filter(Boolean).at(-1) ?? workspaceDir;
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