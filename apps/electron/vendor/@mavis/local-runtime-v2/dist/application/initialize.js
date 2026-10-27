import { SideChatApplication } from './session/sidechat-application.js';
import { ProjectApplication, } from './project/project-application.js';
import { QueueApplication } from './queue/queue-application.js';
import { SessionContentApplication } from './session/content-application.js';
import { SessionDiffApplication } from './session/diff-application.js';
import { SessionLifecycleApplication, } from './session/lifecycle-application.js';
import { SessionQueryApplication } from './session/query-application.js';
import { SessionHandoffApplication } from './session/handoff-application.js';
import { SessionRootApplication, SessionRootEventProjector, } from './session/root-application.js';
import { PinApplication } from './session/pin-application.js';
import { SessionConversationMutationApplication, } from './session/conversation-mutation-application.js';
/** Constructs named feature applications without adding an aggregate forwarding facade. */
export const initializeApplications = (options) => {
    const sideChat = new SideChatApplication({
        sessions: options.sessionSystem.repositories.sessions,
        messages: options.sessionSystem.repositories.messages,
        queue: options.sessionSystem.repositories.queue,
        sideChats: options.sessionSystem.sideChats,
        prepareHistory: options.turn.prepareSideChat,
        registration: options.attachmentRegistration,
        dispatch: (sessionId) => options.turn.dispatchQueue(sessionId),
        publish: options.publishGlobalEvent,
        publishQueueFacts: (facts) => options.sessionSystem.queue.facts.handle(facts),
    });
    const root = new SessionRootApplication({
        invariant: options.sessionSystem.root.invariant,
        resolveAgentWriteTarget: options.resolveAgentWriteTarget,
        requireExactAgentKey: options.requireExactAgentKey,
        turn: options.turn,
        archiveTitle: options.sessionSystem.root.archiveTitle,
        facts: new SessionRootEventProjector({ publish: options.publishGlobalEvent }),
        ...(options.onRootBestEffortFailure
            ? { onBestEffortFailure: options.onRootBestEffortFailure }
            : {}),
    });
    const deletion = options.sessionSystem.session.deletion.create();
    const createSideSession = options.conversationMutationWorkflow?.createSideSession;
    const deleteOwnedSession = (sessionId) => options.workspaceIndexing.deleteSession(sessionId, async () => {
        await deletion.deleteSession(sessionId);
    });
    const deleteSession = (sessionId) => options.turn.sessionDeletion(sessionId, async () => {
        for (const sideId of options.sessionSystem.sideChats.activeSessionIds(sessionId)) {
            await deleteSession(sideId);
        }
        if (!options.memory)
            return deleteOwnedSession(sessionId);
        await options.memory.deleteSession({
            sessionId,
            requestedAtMs: (options.nowMs ?? Date.now)(),
            deleteOwnedSession: () => deleteOwnedSession(sessionId),
        });
    });
    const lifecycle = new SessionLifecycleApplication({
        lifecycle: options.sessionSystem.session.lifecycle,
        ...(createSideSession
            ? {
                sideFork: {
                    create: (input) => createSideSession(input),
                },
            }
            : {}),
        resolveAgentWriteTarget: options.resolveAgentWriteTarget,
        ...(options.runPluginHookSessionEndFence
            ? { runPluginHookSessionEndFence: options.runPluginHookSessionEndFence }
            : {}),
        ...(options.preparePluginHookSessionEnd
            ? { preparePluginHookSessionEnd: options.preparePluginHookSessionEnd }
            : {}),
        ...(options.endPluginHookSession ? { endPluginHookSession: options.endPluginHookSession } : {}),
        deletion: { deleteSession },
        ...(options.assertSessionDeletionAllowed
            ? { assertSessionDeletionAllowed: options.assertSessionDeletionAllowed }
            : {}),
        ...(options.metrics ? { metrics: options.metrics } : {}),
    });
    const query = new SessionQueryApplication({
        backgroundTaskWait: options.backgroundTaskWait,
        cloudReader: options.cloudSessionReader,
        service: options.sessionSystem.session.query,
        sideChats: options.sessionSystem.sideChats,
    });
    const content = new SessionContentApplication({
        cloudReader: options.cloudSessionReader,
        messages: options.sessionSystem.messages.query,
        sources: options.sessionSystem.messages.sources,
        maintenance: options.sessionSystem.session.maintenance,
        staleCompactionRepair: options.sessionSystem.messages.staleCompactionRepair,
        files: options.sessionSystem.files,
        inputSummaries: options.sessionSystem.messages.inputSummaries,
        usage: options.sessionSystem.usage,
        peekContext: options.sessionSystem.messages.peekContext,
        queryCollapse: options.sessionSystem.queryCollapse,
        conversationActions: options.sessionSystem.messages.conversationActions,
        conversationMutation: options.conversationMutationPort,
        forkOriginSessions: options.sessionSystem.repositories.sessions,
    });
    const diff = new SessionDiffApplication({
        service: options.sessionSystem.diff,
        capability: options.compatibility.diff.capability,
    });
    const handoff = new SessionHandoffApplication({
        sessions: options.sessionSystem.repositories.sessions,
        messages: options.sessionSystem.repositories.messages,
        handoff: options.sessionHandoff,
        maintenance: options.sessionSystem.session.maintenance,
    });
    const queue = new QueueApplication({
        queue: options.sessionSystem.queue.committed,
        attachmentRegistration: options.attachmentRegistration,
    });
    const project = new ProjectApplication({
        sidebar: options.sessionSystem.sidebar,
        sidebarBindings: options.compatibility.channelBindings,
        sidebarAgents: options.sidebarAgents,
        sidebarPins: options.pinService,
        ...(options.sidebarCronTargets ? { sidebarCronTargets: options.sidebarCronTargets } : {}),
        sidebarChildren: (ids) => options.sessionSystem.repositories.sessions.listChildrenMany(ids, {
            archived: false,
            includeHidden: false,
            excludeInternalTreeSessions: true,
        }),
        service: options.sessionSystem.project,
        pinService: options.pinService,
        sessionArchive: lifecycle,
    });
    const conversationMutation = new SessionConversationMutationApplication(options.conversationMutationPort, options.conversationMutationWorkflow);
    const pin = new PinApplication({
        service: options.pinService,
        publishGlobalEvent: options.publishGlobalEvent,
    });
    return {
        backgroundTask: options.backgroundTask,
        pin,
        session: { query, content, lifecycle, root, diff, conversationMutation, handoff, sideChat },
        queue,
        project,
    };
};
//# sourceMappingURL=initialize.js.map