import { getConfig } from '@mavis/config';
import { mkdir } from 'node:fs/promises';
import { canonicalProjectWorkspaceDir } from '../../shared/workspace.js';
import { SessionServiceError } from '../errors.js';
import { SessionRecordService, } from '../lifecycle/record-service.js';
import { SessionUniqueViolation } from '../repo/contract.js';
import { applyLocalRunLocation, readLocalRunLocationInput } from './run-location.js';
import { CURRENT_SESSION_DATA_VERSION } from './version.js';
/**
 * The Project a new Session belongs to.
 *
 * A creator that names the registered Project (`projectWorkspaceDir`, set by an assignment
 * running in a directory inside it) has that Project looked up, never created: the directory
 * the task runs in must not become a Project of its own. When the named Project is not
 * registered (only linked to a space, or removed meanwhile) the Project root itself is
 * resolved, still never the sub directory. Every other creator keeps the existing
 * directory-is-a-Project behaviour, so a user opening a conversation in a sub directory
 * still registers it.
 */
async function resolveSessionProject(projects, input, nowMs) {
    const named = input.projectWorkspaceDir;
    if (!named) {
        // The same directory the session row stores, so a worktree outside the
        // repository resolves to the repository's Project.
        const workspaceDir = canonicalProjectWorkspaceDir(input.workspaceDir, input.runLocation) ?? input.workspaceDir;
        return projects.ensureByWorkspaceDir(workspaceDir, nowMs());
    }
    return (await projects.getByWorkspaceDir(named)) ?? projects.ensureByWorkspaceDir(named, nowMs());
}
export function createNativeSessionRecordService(options) {
    const { sessionRepository, projectRepository, agentDirectory, nowMs = Date.now } = options;
    return new SessionRecordService({
        sessions: sessionRepository,
        agentBindings: sessionRepository,
        metadata: {
            create: async (input) => {
                try {
                    const project = input.isDefaultWorkspace
                        ? await projectRepository.ensureDefault(nowMs())
                        : await resolveSessionProject(projectRepository, input, nowMs);
                    if (!project) {
                        throw new SessionServiceError('workspace-required', 'Session Project could not be resolved');
                    }
                    return await sessionRepository.create({
                        ...input,
                        ...(project.projectKind === 'default' ? { isDefaultWorkspace: true } : {}),
                        projectId: project.projectId,
                        runtime: 'pi-agent',
                        status: 'idle',
                        archived: false,
                        sessionDataVersion: CURRENT_SESSION_DATA_VERSION,
                        sessionOrigin: 'local-runtime',
                    });
                }
                catch (error) {
                    if (error instanceof SessionUniqueViolation) {
                        throw new SessionServiceError('session-id-conflict', `Session already exists: ${input.sessionId}`);
                    }
                    throw error;
                }
            },
            update: (sessionId, fields, expectedModel, expectedTitle) => sessionRepository.update(sessionId, fields, expectedModel, expectedTitle),
            delete: (sessionId) => sessionRepository.delete(sessionId),
        },
        agents: {
            getDefaults: async (agentName) => {
                const agent = await agentDirectory.get(agentName);
                if (!agent)
                    return undefined;
                return agent.defaultWorkspaceDir ? { defaultWorkspaceDir: agent.defaultWorkspaceDir } : {};
            },
        },
        runLocation: options.runLocation ?? {
            resolve: async (value, workspaceDir, resolveOptions) => {
                const input = readLocalRunLocationInput(value);
                return input
                    ? applyLocalRunLocation(input, workspaceDir, nowMs, {
                        refreshBeforeCreate: getConfig().worktreeRefreshBeforeCreate,
                        workspaceDirImplicit: resolveOptions?.workspaceDirImplicit === true,
                        ...(options.worktreeProgress ? { onWorktreeProgress: options.worktreeProgress } : {}),
                    })
                    : undefined;
            },
        },
        titlePolicy: options.titlePolicy,
        ...(options.resolveRequestedModel
            ? { resolveRequestedModel: options.resolveRequestedModel }
            : {}),
        artifacts: options.artifacts,
        facts: options.facts,
        workspace: options.workspace ?? {
            initialize: async (workspaceDir) => {
                await mkdir(workspaceDir, { recursive: true, mode: 0o700 });
            },
        },
        ...(options.defaultWorkspaceDir ? { defaultWorkspaceDir: options.defaultWorkspaceDir } : {}),
        ...(options.agentInternalWorkspaceDir
            ? { agentInternalWorkspaceDir: options.agentInternalWorkspaceDir }
            : {}),
        ...(options.sessionDefaultWorkspaceDir
            ? { sessionDefaultWorkspaceDir: options.sessionDefaultWorkspaceDir }
            : {}),
        ...(options.makeSessionId ? { makeSessionId: options.makeSessionId } : {}),
        ...(options.backfillDiagnostics ? { backfillDiagnostics: options.backfillDiagnostics } : {}),
        ...(options.toolCallMode ? { toolCallMode: options.toolCallMode } : {}),
        agentSurfaces: options.agentSurfaces,
    });
}
//# sourceMappingURL=native-record-factory.js.map