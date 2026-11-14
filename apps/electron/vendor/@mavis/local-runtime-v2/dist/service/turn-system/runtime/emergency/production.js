import { usesSegmentContextProfile } from '@mavis/shared/agent-coordination';
import { emergencyFilesGrantSource, } from '../../agent-host/runner/policy/session-readable-grants.js';
import { createEmergencyArtifacts } from './emergency-state.repository.js';
import { createHistoryRepair } from './history-repair.js';
import { classifyTurnFailure } from './turn-failure-classification.js';
/** A root conversation whose Agent declares the segment context profile. */
function isSegmentConversation(sessions, session) {
    const coordination = sessions.coordinatorOwnership.roster.coordinationOf(session?.agentName);
    return session?.sessionType === 'root' && usesSegmentContextProfile(coordination);
}
/**
 * Sessions on the segment profile: root conversations whose Agent declares it.
 * Side chats keep the default.
 */
export function segmentProfileSessions(sessions, isSideChat) {
    return async (sessionId) => !isSideChat(sessionId) &&
        isSegmentConversation(sessions, await sessions.sessions.repository.get(sessionId));
}
/** The emergency rebuild's ports of the production segment compaction (spec 2, 6, 8, 10). */
export function productionEmergencyPorts(input) {
    const artifacts = createEmergencyArtifacts(input.sessions.artifacts);
    return {
        emergency: artifacts.store,
        emergencyFiles: artifacts.files,
        classifyFailure: classifyTurnFailure,
        historyRepair: createHistoryRepair(input.sessions, input.getImageEncoding),
        ...(input.configRepair ? { configRepair: input.configRepair } : {}),
        ...(input.metrics ? { metrics: input.metrics } : {}),
    };
}
/**
 * Reading the files an emergency rebuild moved content into (spec 4.4, 10.2): a
 * segment conversation reads its own, and a task it assigned reads its assigner's.
 */
export function productionEmergencyFilesGrant(sessions) {
    return emergencyFilesGrantSource({
        conversationOf: async (sessionId) => {
            const session = await sessions.sessions.repository.get(sessionId);
            if (isSegmentConversation(sessions, session))
                return sessionId;
            if (!sessions.coordinatorOwnership.isAssignedTask(sessionId))
                return undefined;
            return (await sessions.repositories.assignmentTasks.get(sessionId))?.assignerSessionId;
        },
        readableDirectory: createEmergencyArtifacts(sessions.artifacts).readableDirectory,
    });
}
//# sourceMappingURL=production.js.map