import { promises as fs } from 'node:fs';
import { normalizeAbsolutePath, pathFlavor } from '../shared/path-normalization.js';
import { ProjectServiceError } from './errors.js';
export const PROJECT_WORKSPACE_ROOTS_MAX = 20;
export const PROJECT_WORKSPACE_ROOT_MAX_LENGTH = 4096;
/**
 * Folders of a workspace Project, primary folder first. Missing, malformed or
 * reordered stored data falls back to the row's `workspace_dir` as the first item.
 */
export function projectWorkspaceRoots(project) {
    if (project.projectKind !== 'workspace' || !project.workspaceDir)
        return [];
    return withPrimaryFirst(project.workspaceDir, storedWorkspaceRoots(project.extraDataJson) ?? []);
}
/** Whether the roots were ever written through CreateProject / UpdateProject. */
export function hasStoredWorkspaceRoots(project) {
    return storedWorkspaceRoots(project.extraDataJson) !== undefined;
}
/** Hides the storage field; clients read `ProjectDetail.workspace_roots`. */
export function extraDataWithoutWorkspaceRoots(extraDataJson) {
    try {
        const value = JSON.parse(extraDataJson);
        if (!value || typeof value !== 'object' || Array.isArray(value))
            return extraDataJson;
        if (!Object.hasOwn(value, 'workspaceRoots'))
            return extraDataJson;
        const rest = { ...value };
        delete rest.workspaceRoots;
        return JSON.stringify(rest);
    }
    catch {
        return extraDataJson;
    }
}
/**
 * Validates a complete replacement list. The first item must be the primary
 * folder; every item is absolute, normalized and unique, and no folder may
 * contain another one (a nested folder could be swapped for a symlink from
 * inside its parent and widen the sandbox). Folders not in
 * `existingRoots` must exist as directories, so an offline folder that is
 * already part of the project does not block editing the others.
 */
export async function validateWorkspaceRoots(requested, primaryWorkspaceDir, existingRoots = []) {
    if (requested.length === 0)
        invalid('workspace_roots must include the primary folder');
    if (requested.length > PROJECT_WORKSPACE_ROOTS_MAX) {
        invalid(`workspace_roots cannot exceed ${PROJECT_WORKSPACE_ROOTS_MAX} folders`);
    }
    const roots = [];
    for (const raw of requested) {
        const root = normalizeRequestedRoot(raw);
        if (!roots.some((value) => samePath(value, root)))
            roots.push(root);
    }
    if (!samePath(roots[0] ?? '', primaryWorkspaceDir)) {
        invalid('The first workspace root must be the primary project folder');
    }
    roots[0] = primaryWorkspaceDir;
    roots.forEach((root, index) => {
        if (roots.slice(0, index).some((other) => nestedPath(root, other))) {
            invalid(`Project folders cannot contain each other: ${root}`);
        }
    });
    const added = roots.filter((root) => !existingRoots.some((value) => samePath(value, root)));
    for (const root of added)
        await requireDirectory(root);
    return roots;
}
function normalizeRequestedRoot(raw) {
    if (typeof raw !== 'string' || raw.length > PROJECT_WORKSPACE_ROOT_MAX_LENGTH) {
        invalid('workspace root path is too long');
    }
    if (/[\0\r\n]/u.test(raw))
        invalid('workspace root path is invalid');
    const root = normalizeAbsolutePath(raw);
    if (!root)
        invalid('workspace root must be an absolute path');
    return root;
}
/**
 * Additional folders of the Session's Project, read for every Turn. The primary
 * folder is excluded: the Session keeps its own working directory. Folders that
 * are currently missing are skipped so an offline folder never fails the Turn.
 */
export async function readSessionAdditionalWorkspaceRoots(projects, sessionId) {
    const projectId = await projects.getSessionProjectId(sessionId);
    if (projectId === undefined)
        return [];
    const project = await projects.getById(projectId);
    if (!project || project.hidden)
        return [];
    const additional = projectWorkspaceRoots(project).slice(1);
    const present = await Promise.all(additional.map(isDirectory));
    return additional.filter((_root, index) => present[index]);
}
async function isDirectory(root) {
    try {
        return (await fs.stat(root)).isDirectory();
    }
    catch {
        return false;
    }
}
export async function requireDirectory(root) {
    let directory = false;
    try {
        directory = (await fs.stat(root)).isDirectory();
    }
    catch {
        directory = false;
    }
    if (!directory)
        invalid(`Folder does not exist: ${root}`);
}
function storedWorkspaceRoots(extraDataJson) {
    try {
        const value = JSON.parse(extraDataJson).workspaceRoots;
        if (!Array.isArray(value))
            return undefined;
        return value.flatMap((item) => {
            const root = typeof item === 'string' && !/[\0\r\n]/u.test(item)
                ? normalizeAbsolutePath(item)
                : undefined;
            return root ? [root] : [];
        });
    }
    catch {
        return undefined;
    }
}
function withPrimaryFirst(primary, roots) {
    const result = [primary];
    for (const root of roots) {
        if (!result.some((value) => samePath(value, root)))
            result.push(root);
    }
    return result;
}
function samePath(left, right) {
    if (left === right)
        return true;
    // Windows drive and UNC paths compare case-insensitively.
    const windows = pathFlavor(left).sep === '\\' && pathFlavor(right).sep === '\\';
    return windows && left.toLowerCase() === right.toLowerCase();
}
/** Whether one path is an ancestor of the other. */
function nestedPath(left, right) {
    const windows = pathFlavor(left).sep === '\\' && pathFlavor(right).sep === '\\';
    const separator = pathFlavor(left).sep;
    const a = windows ? left.toLowerCase() : left;
    const b = windows ? right.toLowerCase() : right;
    const within = (child, parent) => child.startsWith(parent.endsWith(separator) ? parent : parent + separator);
    return within(a, b) || within(b, a);
}
function invalid(message) {
    throw new ProjectServiceError('invalid-workspace-roots', message);
}
//# sourceMappingURL=workspace-roots.js.map