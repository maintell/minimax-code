import { createV1ConversationAttachmentMaterializer } from './attachments/index.js';
import { createV1ConversationCompatibility } from './initialize.js';
import { createV1CompatibleTurnSubmission, } from './v1-compatible-turn-submission.service.js';
/**
 * Assembles the three collaborators behind the v1 Conversation surface.
 *
 * The materializer is shared on purpose: submission registers attachments
 * before a Turn is accepted, and the compatibility service reuses the same
 * registration when it materializes a message on any other path.
 */
export function composeV1Conversation(input) {
    const attachmentMaterializer = createV1ConversationAttachmentMaterializer({
        registration: input.attachmentRegistration,
    });
    const submission = createV1CompatibleTurnSubmission({
        turns: input.turns,
        attachmentMaterializer,
    });
    return createV1ConversationCompatibility({
        sessions: {
            repository: input.sessions.sessions.repository,
            query: input.sessions.sessions.query,
            records: input.sessions.sessions.records,
            lifecycle: input.lifecycle,
            messages: { ...input.sessions.messages },
            queue: input.sessions.queue.committed,
            deletion: {
                deleteSession: (sessionId) => input.deletion.deleteSessionById(sessionId),
            },
            root: input.root,
        },
        submission,
        attachmentMaterializer,
        turns: input.turns,
        rootAgents: input.rootAgents,
        resolveAgentWriteTarget: input.resolveAgentWriteTarget,
        ...(input.taskOccupancy ? { taskOccupancy: input.taskOccupancy } : {}),
        ...(input.onQueueWakeFailure ? { onQueueWakeFailure: input.onQueueWakeFailure } : {}),
    });
}
//# sourceMappingURL=composition.js.map