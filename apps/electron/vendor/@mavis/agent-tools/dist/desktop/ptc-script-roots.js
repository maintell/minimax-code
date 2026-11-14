import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
/** Directory name under a workspace's `.minimax` and under the data directory. */
export const PTC_SCRIPT_DIR_NAME = 'ptc';
/**
 * The directories `import()` may read. The default workspace has no
 * project-level directory, the same rule project hooks follow
 * (`hook-config/turn-hook-source.ts`).
 */
export function resolvePtcScriptRoots(input) {
    const workspaceDir = input.workspaceDir.trim();
    const user = resolve(input.dataDir, PTC_SCRIPT_DIR_NAME);
    const project = workspaceDir && input.isDefaultWorkspace !== true
        ? resolve(workspaceDir, '.minimax', PTC_SCRIPT_DIR_NAME)
        : undefined;
    return {
        // The workspace can be the directory that holds the data directory, a home
        // directory opened as the workspace, and then `<workspace>/.minimax/ptc`
        // and `<dataDir>/ptc` are one directory. Keeping both would list every
        // script twice and let `scopeOf` label the same file `project` or `user`
        // depending on which root matched first, so this gets the same answer the
        // default workspace gets: no project-level directory. The two are compared
        // one level up, which is what makes the answer right on the first save too.
        ...(project !== undefined && !sharesUserScriptDirectory(workspaceDir, input.dataDir)
            ? { project }
            : {}),
        user,
        skills: (input.skillRoots ?? []).map((root) => resolve(root.rootPath)),
        homeDir: input.homeDir,
        workspaceDir: resolve(workspaceDir || input.homeDir),
    };
}
/**
 * Whether `<workspace>/.minimax/ptc` and `<dataDir>/ptc` are one directory,
 * asked one level up: both `ptc` directories carry the same name, so the level
 * holding them decides.
 *
 * Comparing the `ptc` directories themselves needed both to exist, and the
 * very first save happens before either does. A data directory reached through
 * a symlink (a profile alias) then went unrecognised, the project directory
 * survived, and the first project-scoped save wrote into the shared user
 * directory while reporting `scope: "project"`. The data directory always
 * exists, and `<workspace>/.minimax` that does not exist cannot be it, so the
 * answer below is right either way.
 */
function sharesUserScriptDirectory(workspaceDir, dataDir) {
    return isSameDirectory(resolve(workspaceDir, '.minimax'), resolve(dataDir));
}
/**
 * The same directory, compared as resolved paths and then, when both really
 * exist, as realpaths, so a directory reached through a symlink (a profile
 * alias) still counts as the same one. A side that does not exist is never the
 * same one: the caller compares the data directory, which always exists, so a
 * missing `<workspace>/.minimax` really is somewhere else.
 */
function isSameDirectory(left, right) {
    if (left === right)
        return true;
    try {
        return realpathSync(left) === realpathSync(right);
    }
    catch {
        // One of them does not exist, so there is nothing to follow.
        return false;
    }
}
/** The two directories the catalog lists, project first; skill roots are not listed. */
export function ptcScriptCatalogDirectories(roots) {
    return [
        ...(roots.project ? [{ scope: 'project', directory: roots.project }] : []),
        { scope: 'user', directory: roots.user },
    ];
}
/**
 * Every existing component between `boundary` and `path` must be a real
 * directory or file. Without this a repository could ship `.minimax/ptc` as a
 * symlink and the save tool would write outside the workspace. Claude Code does
 * the same check before saving a workflow.
 */
export function assertNoSymlinkBelow(boundary, path) {
    const root = resolve(boundary);
    const target = resolve(path);
    const below = relative(root, target);
    // The boundary itself, or a target outside it: only the target can be a
    // symlink on the path this function was asked about. The segments come from
    // `relative` rather than a `root + sep` prefix, which never matches when the
    // boundary is a filesystem root (`/` or `C:\`): `root + sep` is then a doubled
    // separator, the prefix failed for every target, and only the final target
    // was ever checked.
    if (below === '' || below === '..' || below.startsWith(`..${sep}`) || isAbsolute(below)) {
        assertNotSymlink(target);
        return;
    }
    let current = root;
    for (const segment of below.split(sep)) {
        current = join(current, segment);
        assertNotSymlink(current);
    }
}
function assertNotSymlink(path) {
    let stats;
    try {
        stats = lstatSync(path);
    }
    catch {
        // Not created yet: nothing can be a symlink.
        return;
    }
    if (stats.isSymbolicLink()) {
        throw new Error(`save_run_code_script refuses to write through the symlink ${path}.`);
    }
}
export function createPtcScriptHost(dependencies) {
    const resolveDirectories = (input) => {
        const skillRoots = dependencies.skillRoots({
            agentName: input.agentName,
            workspaceDir: input.workspaceDir,
            ...(input.expectedAgentInstanceId
                ? { expectedAgentInstanceId: input.expectedAgentInstanceId }
                : {}),
            ...(input.excludeAgentResources ? { excludeAgentResources: true } : {}),
        });
        return {
            roots: resolvePtcScriptRoots({
                workspaceDir: input.workspaceDir,
                dataDir: dependencies.dataDir(),
                homeDir: dependencies.homeDir(),
                ...(input.isDefaultWorkspace ? { isDefaultWorkspace: true } : {}),
                skillRoots,
            }),
            workspaceSkillRoots: skillRoots.flatMap((root) => root.workspaceBoundary === undefined
                ? []
                : [{ boundary: root.workspaceBoundary, rootPath: root.rootPath }]),
            // A path the user owns is never withdrawn, even when the workspace also
            // contributes it: a home directory opened as the workspace makes
            // `~/.agents/skills` arrive twice, once as each kind.
            userOwnedSkillRoots: new Set(skillRoots.flatMap((root) => root.workspaceBoundary === undefined ? [resolve(root.rootPath)] : [])),
        };
    };
    return {
        resolve: (input) => resolveDirectories(input).roots,
        importable: (input) => {
            const directories = resolveDirectories(input);
            return withoutSymlinkedWorkspaceSkillRoots(withoutSymlinkedProjectDirectory(directories.roots), directories);
        },
        assertNoSymlink: (path, boundary) => assertNoSymlinkBelow(boundary, path),
        refusedImport: (content) => dependencies.refusedImport(content),
    };
}
/**
 * The roots without a project-level directory that is reached through a
 * symlink.
 *
 * A repository can ship `.minimax` or `.minimax/ptc` as a symlink pointing
 * anywhere: the filesystem root, a home directory. The save tool already
 * refuses to write through one, but the allowlist resolves the directory and
 * the catalog reads it, so without this every `.mjs` under the link target
 * would be importable and listed to the model, with no read approval of its
 * own. Dropping the directory is the same answer the default workspace gets.
 *
 * The check is the save tool's own, so both sides agree on what counts as a
 * symlink. The user-level directory is untouched: it is the user's own data
 * directory, which may legitimately be a profile alias.
 */
function withoutSymlinkedProjectDirectory(roots) {
    if (!roots.project)
        return roots;
    try {
        assertNoSymlinkBelow(roots.workspaceDir, roots.project);
        return roots;
    }
    catch {
        return {
            user: roots.user,
            skills: roots.skills,
            homeDir: roots.homeDir,
            workspaceDir: roots.workspaceDir,
        };
    }
}
/**
 * The roots without a skill root the workspace contributes through a symlink.
 *
 * The dot directories a workspace contributes, `.minimax`, `.agents` and the
 * rest, come out of the repository the user opened, exactly like
 * `.minimax/ptc` above, and a repository may ship one of them as a symlink
 * pointing at the filesystem root or a home directory. The loader allowlist
 * resolves every skill root and accepts anything under it
 * (`script/allowlist.ts`), so such a link would make every `.mjs` under its
 * target importable, with no read approval of its own. Dropping the root is the
 * same answer the project directory gets.
 *
 * The walk starts at the level holding the dot directory, so that level being
 * itself a symlink (a workspace reached through a link, `/var` on macOS) is
 * not a reason to drop anything; only the dot directory and the skill root
 * below it are checked. Roots the user owns are untouched: linking
 * `~/.agents/skills` to a dotfiles checkout is how skills are shared.
 *
 * The same directory can arrive as both kinds at once, which is what a home
 * directory opened as the workspace does to `~/.agents/skills`. Dropping by
 * path would then take the user's own root with it, so a path the user also
 * owns stays no matter what the workspace side found.
 */
function withoutSymlinkedWorkspaceSkillRoots(roots, directories) {
    const { workspaceSkillRoots, userOwnedSkillRoots } = directories;
    if (workspaceSkillRoots.length === 0)
        return roots;
    const dropped = new Set(workspaceSkillRoots.flatMap(({ boundary, rootPath }) => {
        const resolvedRoot = resolve(rootPath);
        if (userOwnedSkillRoots.has(resolvedRoot))
            return [];
        try {
            assertNoSymlinkBelow(boundary, rootPath);
            return [];
        }
        catch {
            return [resolvedRoot];
        }
    }));
    if (dropped.size === 0)
        return roots;
    return { ...roots, skills: roots.skills.filter((skill) => !dropped.has(skill)) };
}
//# sourceMappingURL=ptc-script-roots.js.map