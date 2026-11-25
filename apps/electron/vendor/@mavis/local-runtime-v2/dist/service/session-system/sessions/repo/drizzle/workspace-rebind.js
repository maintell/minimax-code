import { eq } from 'drizzle-orm';
import { sessionAgentDefinitions } from '../../../../../infra/db/schema/sessions.js';
import { decodeSessionAgentDefinition, isCurrentSessionAgentDefinition, serializeSessionAgentDefinition, withCurrentSessionAgentDefinitionProject, } from '../agent-binding.js';
/**
 * The record of a Session that now works in another folder. The stored Project hint and run
 * location describe the old folder, so both go and the Project is derived from the new folder
 * again. The activity time stays: moving a task is not activity.
 */
export function rebindSessionRecordWorkspace(current, target) {
    return {
        ...current,
        workspaceDir: target.workspaceDir,
        isDefaultWorkspace: target.isDefaultWorkspace,
        projectWorkspaceDir: undefined,
        runLocation: undefined,
    };
}
/**
 * Runs inside the Session row transaction, so a frozen definition never keeps naming the old
 * folder. A V1 (Task-only) definition predates the Project field and has nothing to rebind.
 */
export function rebindSessionAgentDefinitionProject(db, sessionId, target) {
    const row = db
        .select()
        .from(sessionAgentDefinitions)
        .where(eq(sessionAgentDefinitions.sessionId, sessionId))
        .get();
    if (!row)
        return;
    const current = decodeSessionAgentDefinition(row);
    if (!isCurrentSessionAgentDefinition(current.definition))
        return;
    const rebound = withCurrentSessionAgentDefinitionProject(current, {
        workspaceDir: target.workspaceDir,
        isDefaultWorkspace: target.isDefaultWorkspace,
    });
    db.update(sessionAgentDefinitions)
        .set({ definitionJson: serializeSessionAgentDefinition(rebound).definitionJson })
        .where(eq(sessionAgentDefinitions.sessionId, sessionId))
        .run();
}
//# sourceMappingURL=workspace-rebind.js.map