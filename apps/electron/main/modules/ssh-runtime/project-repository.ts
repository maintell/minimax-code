import { randomUUID } from "node:crypto";
import electronStore from "electron-store";
import { sshProjectRuntimeId } from "@mavis/shared/desktop-runtime";
import { isSafeSshHost, isSafeAbsoluteRemotePath } from "./config";
const SNAPSHOT_KEY = 'snapshot';
const SNAPSHOT_VERSION = 1;
const MAX_PROJECT_NAME_LENGTH = 80;
export class SshProjectRepositoryError extends Error {
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = 'SshProjectRepositoryError';
    }
}

/**
 * Persists project identity only. SSH credentials remain owned by OpenSSH and
 * the resolved MCode executable is never exposed to the renderer.
 */
export class SshProjectRepository {
    constructor(store, now = Date.now, createId = randomUUID) {
        this.store = store;
        this.now = now;
        this.createId = createId;
    }
    list() {
        return this.readProjects().map(toPublicProject);
    }
    get(projectId) {
        const project = this.getStored(projectId);
        return project ? toPublicProject(project) : null;
    }
    getRuntimeTarget(projectId) {
        const project = this.getStored(projectId);
        return project
            ? {
                kind: 'ssh',
                host: project.host,
                workspaceDir: project.workspaceDir,
                mcodePath: project.mcodePath,
            }
            : null;
    }
    create(input) {
        const host = input.host.trim();
        const workspaceDir = normalizeRemotePath(input.workspaceDir);
        const mcodePath = normalizeRemotePath(input.mcodePath);
        if (!isSafeSshHost(host) || !workspaceDir || !mcodePath) {
            throw new SshProjectRepositoryError('invalid_project', 'Invalid SSH project data.');
        }
        const name = normalizeProjectName(input.name, host, workspaceDir);
        if (!name) {
            throw new SshProjectRepositoryError('invalid_project', 'Invalid SSH project data.');
        }
        const projects = this.readProjects();
        if (projects.some((project) => project.host === host && project.workspaceDir === workspaceDir)) {
            throw new SshProjectRepositoryError('duplicate_project', 'This SSH workspace is already registered.');
        }
        const timestamp = this.now();
        const project = {
            id: this.createId(),
            name,
            host,
            workspaceDir,
            mcodePath,
            createdAtMs: timestamp,
            updatedAtMs: timestamp,
        };
        if (!isStoredProject(project)) {
            throw new SshProjectRepositoryError('invalid_project', 'Failed to create SSH project.');
        }
        this.writeProjects([...projects, project]);
        return toPublicProject(project);
    }
    update(input) {
        const name = normalizeExplicitProjectName(input.name);
        if (!name) {
            throw new SshProjectRepositoryError('invalid_project', 'Invalid SSH project name.');
        }
        const projects = this.readProjects();
        const index = projects.findIndex((project) => project.id === input.id);
        if (index < 0) {
            throw new SshProjectRepositoryError('project_not_found', 'SSH project not found.');
        }
        const updated = { ...projects[index], name, updatedAtMs: this.now() };
        projects[index] = updated;
        this.writeProjects(projects);
        return toPublicProject(updated);
    }
    remove(projectId) {
        const projects = this.readProjects();
        const remaining = projects.filter((project) => project.id !== projectId);
        if (remaining.length === projects.length)
            return false;
        this.writeProjects(remaining);
        return true;
    }
    /**
     * Forget this Desktop profile's project mappings, never remote workspaces or
     * sessions. The owning connection removal is synchronous so no project can
     * be created between the two writes. Restore the mappings if it fails.
     */
    removeByHost(host, removeConnection) {
        const projects = this.readProjects();
        const removed = projects.filter((project) => project.host === host);
        if (removed.length === 0) {
            removeConnection();
            return [];
        }
        this.writeProjects(projects.filter((project) => project.host !== host));
        try {
            removeConnection();
        }
        catch (error) {
            this.writeProjects(projects);
            throw error;
        }
        return removed.map((project) => project.id);
    }
    getStored(projectId) {
        return this.readProjects().find((project) => project.id === projectId) ?? null;
    }
    readProjects() {
        const snapshot = this.store.get(SNAPSHOT_KEY);
        if (!isRecord(snapshot) || snapshot.version !== SNAPSHOT_VERSION)
            return [];
        if (!Array.isArray(snapshot.projects))
            return [];
        return snapshot.projects.filter(isStoredProject).map((project) => ({ ...project }));
    }
    writeProjects(projects) {
        this.store.set(SNAPSHOT_KEY, { version: SNAPSHOT_VERSION, projects });
    }
}

export function createPersistentSshProjectRepository() {
    const store = new electronStore({
        name: 'ssh-projects',
        defaults: { snapshot: { version: SNAPSHOT_VERSION, projects: [] } },
    });
    return new SshProjectRepository(store);
}
function toPublicProject(project) {
    return {
        id: project.id,
        runtimeId: sshProjectRuntimeId(project.id),
        name: normalizeLegacyDefaultProjectName(project),
        host: project.host,
        workspaceDir: project.workspaceDir,
        createdAtMs: project.createdAtMs,
        updatedAtMs: project.updatedAtMs,
    };
}
function normalizeRemotePath(value) {
    const normalized = value.length > 1 ? value.replace(/\/+$/u, '') : value;
    return isSafeAbsoluteRemotePath(normalized) ? normalized : null;
}
function normalizeProjectName(name, host, workspaceDir) {
    if (name !== undefined)
        return normalizeExplicitProjectName(name);
    const leaf = workspaceDir.split('/').filter(Boolean).at(-1);
    return normalizeExplicitProjectName(leaf ?? host);
}
/**
 * Early SSH builds appended the host to every generated project name even
 * though the sidebar already renders the host in a separate column. Keep
 * those persisted projects readable without forcing users to recreate them.
 */
function normalizeLegacyDefaultProjectName(project) {
    const leaf = project.workspaceDir.split('/').filter(Boolean).at(-1);
    const legacyDefaultName = leaf ? `${leaf} · ${project.host}` : project.host;
    return project.name === legacyDefaultName ? (leaf ?? project.host) : project.name;
}
function normalizeExplicitProjectName(value) {
    const normalized = value.trim();
    if (!normalized || normalized.length > MAX_PROJECT_NAME_LENGTH)
        return null;
    return /[\u0000-\u001f\u007f]/u.test(normalized) ? null : normalized;
}
function isStoredProject(value) {
    if (!isRecord(value))
        return false;
    if (typeof value.id !== 'string' || typeof value.name !== 'string')
        return false;
    try {
        sshProjectRuntimeId(value.id);
    }
    catch {
        return false;
    }
    return (normalizeExplicitProjectName(value.name) === value.name &&
        typeof value.host === 'string' &&
        isSafeSshHost(value.host) &&
        typeof value.workspaceDir === 'string' &&
        normalizeRemotePath(value.workspaceDir) === value.workspaceDir &&
        typeof value.mcodePath === 'string' &&
        normalizeRemotePath(value.mcodePath) === value.mcodePath &&
        typeof value.createdAtMs === 'number' &&
        Number.isSafeInteger(value.createdAtMs) &&
        typeof value.updatedAtMs === 'number' &&
        Number.isSafeInteger(value.updatedAtMs) &&
        value.updatedAtMs >= value.createdAtMs);
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
