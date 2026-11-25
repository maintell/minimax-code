import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
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
 * inside its parent and widen the sandbox). Folders not in `existingRoots` must
 * exist as directories and not be a system or home directory, and the same
 * containment rule applies to their real locations. An offline folder that is
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
    const added = roots.filter((root) => !existingRoots.some((value) => samePath(value, root)));
    assertAddedRootsNotForbidden(roots, added);
    roots.forEach((root, index) => {
        if (roots.slice(0, index).some((other) => nestedPath(root, other))) {
            overlapping(root);
        }
    });
    for (const root of added)
        await requireDirectory(root);
    await assertAddedRootsAllowed(roots, added);
    return roots;
}
/**
 * A home or system folder usually also contains the primary folder; name this
 * more specific refusal before the containment check.
 */
function assertAddedRootsNotForbidden(roots, added) {
    for (const root of added)
        if (root !== roots[0] && isForbiddenRoot(root))
            refuseForbidden(root);
}
async function assertAddedRootsAllowed(roots, added) {
    // Removing a folder touches no disk: an unresponsive mount must not block it.
    if (added.length === 0)
        return;
    const located = await Promise.all(roots.map(async (root) => ({
        root,
        // A saved folder on an unresponsive mount falls back to its stored path.
        real: added.includes(root) ? await realRoot(root) : await realRootWithin(root),
    })));
    for (const { root, real } of located) {
        if (root === roots[0] || !added.includes(root))
            continue;
        if (isForbiddenRoot(real))
            refuseForbidden(root);
        const clash = located.find((other) => other.root !== root && (samePath(other.real, real) || nestedPath(other.real, real)));
        if (clash)
            overlapping(root);
    }
}
/** How long a saved folder's real path may take before its stored path is used. */
export const SAVED_ROOT_REALPATH_TIMEOUT_MS = 1_000;
async function realRootWithin(root) {
    let timer;
    const timeout = new Promise((resolve) => {
        timer = setTimeout(() => resolve(root), SAVED_ROOT_REALPATH_TIMEOUT_MS);
    });
    try {
        return await Promise.race([realRoot(root), timeout]);
    }
    finally {
        clearTimeout(timer);
    }
}
async function realRoot(root) {
    try {
        return normalizeAbsolutePath(await fs.realpath(root)) ?? root;
    }
    catch {
        return root;
    }
}
/** macOS keeps cloud drive folders (Dropbox, OneDrive, iCloud Drive) here. */
const MAC_CLOUD_DRIVE_DIRECTORIES = ['Library/CloudStorage', 'Library/Mobile Documents'];
/**
 * Granting one of these would hand the Agent the whole machine or the user's
 * private settings. The primary folder is never checked: it is what the user
 * opened, and it already has these permissions.
 */
export function isForbiddenRoot(root) {
    const flavor = pathFlavor(root);
    if (flavor.parse(root).root === root)
        return true;
    const home = normalizeAbsolutePath(homedir());
    if (home && (samePath(root, home) || isAncestor(root, home)))
        return true;
    if (flavor.sep === '\\')
        return /^[A-Za-z]:\\Windows(?:\\|$)/iu.test(root);
    if (home &&
        MAC_CLOUD_DRIVE_DIRECTORIES.some((directory) => isAncestor(`${home}/${directory}`, root))) {
        return false;
    }
    const forbidden = ['/etc', '/private/etc', '/System', ...(home ? [`${home}/Library`] : [])];
    return forbidden.some((directory) => samePath(root, directory) || nestedPath(root, directory));
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
function isAncestor(parent, child) {
    return nestedPath(parent, child) && parent.length < child.length;
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
function refuseForbidden(root) {
    throw new ProjectServiceError('forbidden-workspace-root', `System or home folders cannot be added to a project: ${root}`);
}
function overlapping(root) {
    throw new ProjectServiceError('overlapping-workspace-roots', `Project folders cannot contain each other: ${root}`);
}
//# sourceMappingURL=workspace-roots.js.map