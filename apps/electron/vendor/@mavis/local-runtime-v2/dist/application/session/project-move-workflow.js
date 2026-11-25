import { stat } from 'node:fs/promises';
import { SessionServiceError, sessionProjectMoveBlocker, } from '../../service/session-system/index.js';
import { AppError } from '../errors.js';
import { publishBestEffort } from '../events.js';
/** UpdateSession `project_id` for "no Project", as in Cloud. */
const NO_PROJECT_ID = 0;
/**
 * Moves a local task to another Project folder (UpdateSession `project_id`; `0` leaves its
 * Project). A local Project is a folder: the task then works in the target's primary folder,
 * or where a new no-project Session of its Agent would, and every later Turn reads that folder
 * from the Session row. The move is not activity, so `updated_at_ms` stays; pins are keyed by
 * Session id and stay too. The emptied source Project stays listed (see
 * `ProjectService.keepWorkspaceProjectListed`).
 */
export class SessionProjectMoveWorkflow {
    options;
    isDirectory;
    nowMs;
    constructor(options) {
        this.options = options;
        this.isDirectory = options.isDirectory ?? isDirectory;
        this.nowMs = options.nowMs ?? Date.now;
    }
    async move(sessionId, projectId) {
        assertProjectId(projectId);
        const plan = await this.plan(sessionId, projectId);
        if (isNoop(plan))
            return plan.session;
        return this.options.maintenance.runExclusive(sessionId, (lane) => lane.run(() => this.commitUnderLease(sessionId, projectId)));
    }
    /** Plans again under the lease: a concurrent move or archive may have committed first. */
    async commitUnderLease(sessionId, projectId) {
        const plan = await this.plan(sessionId, projectId);
        if (isNoop(plan))
            return plan.session;
        const workspace = await this.destination(plan);
        if (plan.sourceProjectId !== undefined) {
            await this.options.catalog.keepWorkspaceProjectListed(plan.sourceProjectId);
        }
        const moved = await this.options.sessions.rebindWorkspace(sessionId, workspace);
        if (!moved)
            throw sessionNotFound(sessionId);
        // An older task brought into a Project that was removed and added back still lists there.
        await this.options.projects.restoreSessionAfterRemoval(sessionId, this.nowMs());
        publishBestEffort(this.options.publish, {
            type: 'session.workspace_updated',
            payload: {
                sessionId,
                agentName: moved.agentName,
                workspaceDir: workspace.workspaceDir,
                isDefaultWorkspace: workspace.isDefaultWorkspace,
            },
        });
        return moved;
    }
    async plan(sessionId, projectId) {
        const session = await this.requireMovableSession(sessionId);
        const target = await this.resolveTarget(projectId);
        const sourceProjectId = await this.options.projects.getSessionProjectId(sessionId);
        const plan = { session, sourceProjectId, target };
        if (!isNoop(plan) && target.kind === 'workspace')
            await this.requireFolder(target.workspaceDir);
        return plan;
    }
    async requireMovableSession(sessionId) {
        const session = await this.options.sessions.get(sessionId);
        if (!session)
            throw sessionNotFound(sessionId);
        const blocker = sessionProjectMoveBlocker(session) ??
            (this.options.isOwnedByScheduledTask?.(sessionId) ? 'scheduled-task' : undefined);
        if (blocker) {
            throw new AppError(400, 'SESSION_PROJECT_MOVE_UNSUPPORTED', `Session cannot move to another project (${blocker}): ${sessionId}`);
        }
        return session;
    }
    /** A removed (hidden) Project is gone for the user; the default row means "no Project". */
    async resolveTarget(projectId) {
        if (projectId === NO_PROJECT_ID)
            return this.defaultTarget();
        const project = await this.options.projects.getById(projectId);
        if (!project || project.hidden) {
            throw new AppError(404, 'PROJECT_NOT_FOUND', `Project not found: ${String(projectId)}`);
        }
        if (project.projectKind === 'default' || !project.workspaceDir)
            return this.defaultTarget();
        return { kind: 'workspace', projectId: project.projectId, workspaceDir: project.workspaceDir };
    }
    async defaultTarget() {
        return { kind: 'default', projectId: (await this.options.projects.getDefault())?.projectId };
    }
    async requireFolder(workspaceDir) {
        if (await this.isDirectory(workspaceDir))
            return;
        throw new AppError(409, 'PROJECT_FOLDER_MISSING', `Project folder does not exist: ${workspaceDir}`);
    }
    async destination(plan) {
        if (plan.target.kind === 'workspace') {
            return { workspaceDir: plan.target.workspaceDir, isDefaultWorkspace: false };
        }
        return {
            workspaceDir: await this.options.noProjectWorkspaceDir(plan.session),
            isDefaultWorkspace: true,
        };
    }
}
function assertProjectId(projectId) {
    if (Number.isSafeInteger(projectId) && projectId >= NO_PROJECT_ID)
        return;
    throw new AppError(400, 'VALIDATION_ERROR', 'project_id must be 0 or a project id');
}
/** Moving a task to the Project it is already in changes nothing. */
function isNoop(plan) {
    return plan.target.projectId !== undefined && plan.sourceProjectId === plan.target.projectId;
}
function sessionNotFound(sessionId) {
    return new SessionServiceError('session-not-found', `Session not found: ${sessionId}`);
}
async function isDirectory(dir) {
    try {
        return (await stat(dir)).isDirectory();
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=project-move-workflow.js.map