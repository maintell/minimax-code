import path from 'node:path';
import { readSessionCreateScope } from '@mavis/agent-tools/namespaced-tools';
import { resolveExistingWorktreeRepository } from '../../workspace/index.js';
import { containingProject, normalizeProjectDir, } from '../orchestration/execution-location.js';
const UNKNOWN_PROJECT = 'SESSION_CREATE_UNKNOWN_PROJECT';
/** How the model may name the default project: its key and the name project_list shows. */
const DEFAULT_PROJECT_REFERENCES = new Set(['default', 'No project selected']);
const DEFAULT_PROJECT_REFUSAL = '默认项目没有目录，不能用作 project。请换一个项目，或请用户先在界面里给它加上目录。';
/**
 * The project a session_create `project` names: the one registered project whose
 * name, as project_list shows it, is the reference; else assignment_create's match
 * by directory name, by path or by a directory inside a project. The default
 * project (`is_default` in project_list) has no directory, so naming it, when
 * nothing else matched, fails like an unknown project with the reason. Every miss
 * lists the candidates by the names project_list shows.
 */
export async function sessionCreateProject(projects, reference) {
    const wanted = reference.trim();
    const names = await projectNames(projects);
    const named = [...names].flatMap(([dir, name]) => (name === wanted ? [dir] : []));
    const [only] = named;
    if (named.length === 1 && only)
        return { projectDir: only, projectName: path.basename(only), directory: only };
    try {
        return await projects.project(wanted);
    }
    catch (error) {
        if (!(error instanceof Error) || !('candidates' in error))
            throw error;
        const candidates = (await projects.candidateProjectDirs()).map((dir) => ({
            name: names.get(dir) ?? path.basename(dir),
            path: dir,
        }));
        const refusal = DEFAULT_PROJECT_REFERENCES.has(wanted)
            ? DEFAULT_PROJECT_REFUSAL
            : error.message;
        throw unknownProject(refusal, candidates);
    }
}
/**
 * project_list's name for each registered project directory, keyed as the
 * candidates are: the name the user gave it, else its folder name.
 */
async function projectNames(projects) {
    const names = new Map();
    for (const { displayName, workspaceDir } of await projects.projects()) {
        if (!workspaceDir)
            continue;
        const dir = normalizeProjectDir(workspaceDir);
        names.set(dir, displayName || path.basename(dir));
    }
    return names;
}
/**
 * The directory the hosted project approval asks about, read from the tool's
 * own name and its own arguments. session_create names where it works, so it
 * resolves here; every other tool keeps the assignment service's answer.
 */
export function resolveApprovalProject(projects, callerSessionId, toolName, args) {
    if (toolName === 'session_create')
        return sessionCreateScope(projects, args);
    return projects.resolveAssignmentProject(callerSessionId, toolName, args);
}
/**
 * The project a session_create names, or for a `workspace_dir` the registered
 * project containing it and otherwise that directory itself, so a directory in
 * no project is approved, never refused. An existing worktree named alone is
 * approved by the repository it belongs to. Undefined when it names none.
 */
async function sessionCreateScope(projects, args) {
    const scope = readSessionCreateScope(args);
    if (scope.kind === 'project')
        return (await sessionCreateProject(projects, scope.value)).projectDir;
    if (scope.kind === 'worktree_dir')
        return worktreeScope(projects, scope.value);
    if (scope.kind !== 'workspace_dir')
        return undefined;
    const dir = scope.value;
    if (!path.isAbsolute(dir))
        throw new Error('workspace_dir must be an absolute path');
    const containing = await containingProject(await projects.candidateProjectDirs(), dir);
    return containing?.projectDir ?? normalizeProjectDir(dir);
}
/**
 * The session runs in the repository that registered the worktree, found the
 * way the create finds it when no workspace is named (read-only `git worktree
 * list`). That repository is approved as the registered project containing it,
 * else as itself; a worktree no repository claims cannot be created and is
 * approved as written.
 */
async function worktreeScope(projects, worktreeDir) {
    if (!path.isAbsolute(worktreeDir))
        throw new Error('location.worktree_dir must be an absolute path');
    const owner = await resolveExistingWorktreeRepository(worktreeDir, worktreeDir, true);
    if (owner.kind !== 'resolved')
        return normalizeProjectDir(worktreeDir);
    const containing = await containingProject(await projects.candidateProjectDirs(), owner.repoDir);
    return containing?.projectDir ?? normalizeProjectDir(owner.repoDir);
}
function unknownProject(message, candidates) {
    return Object.assign(new Error(message), { code: UNKNOWN_PROJECT, candidates });
}
//# sourceMappingURL=session-create-project.js.map