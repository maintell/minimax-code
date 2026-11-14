import { decodeCronModel } from '@mavis/shared/cron-model';
import { createCronSessionPurpose, formatCronRunTitle, isSelfReminderId, } from '@mavis/shared/cron-purpose';
import { createHostCronSessionCreation } from './adapters/session-creation.adapter.js';
import { NO_MAIN_CONVERSATION_AGENTS, } from './contracts.js';
import { deliverRuntimeCron } from './runtime-delivery.js';
import { CronDeliveryDeferredError } from './errors.js';
/** Binds Cron's session ports to the V2 Agent, Session, and Turn capabilities. */
export function createRuntimeCronSessionPorts(options) {
    const { agentSessionPorts, sessions, turns, reportFailure, lifecycle, deletion } = options;
    const mainConversationAgents = options.mainConversationAgents ?? NO_MAIN_CONVERSATION_AGENTS;
    const sessionCreation = createHostCronSessionCreation({
        getAgent: async (agentName) => {
            const defaults = await agentSessionPorts.directory.get(agentName);
            return defaults
                ? {
                    agentName,
                    ...(defaults.defaultWorkspaceDir
                        ? { defaultWorkspaceDir: defaults.defaultWorkspaceDir }
                        : {}),
                }
                : undefined;
        },
        getSession: async (sessionId) => {
            const session = await sessions.sessions.repository.get(sessionId);
            return session
                ? {
                    sessionId,
                    agentName: session.agentName,
                    archived: session.archived,
                    workspaceDir: session.workspaceDir,
                }
                : undefined;
        },
        resolveAgentWriteTarget: agentSessionPorts.resolveWriteTarget,
        createSession: async (request) => {
            const session = await sessions.sessions.records.createInternalSession({
                agentName: request.agentName,
                workspaceDir: request.workspaceDir,
                isDefaultWorkspace: request.isDefaultWorkspace,
                ...(request.model?.trim() ? sessionModelFields(request.model) : {}),
                sessionType: 'branch',
                sessionKind: 'cron',
                originCronId: request.cronId,
                purpose: createCronSessionPurpose(request.agentName, request.cronName),
                title: formatCronRunTitle(request.cronName, request.runCreatedAtMs),
            });
            return { sessionId: session.sessionId, agentName: session.agentName };
        },
        renameSession: async (sessionId, title, signal) => {
            signal?.throwIfAborted();
            const session = await sessions.sessions.repository.get(sessionId);
            signal?.throwIfAborted();
            if (!session || session.title?.trim())
                return;
            await lifecycle.renameSession(sessionId, title, session.title ?? null, signal);
        },
        discardSession: async (sessionId) => {
            await deletion.deleteTaskOwnedSessionById(sessionId);
        },
        detachCronSessions: async (cronId, targetSessionId, signal) => {
            signal?.throwIfAborted();
            await sessions.sessions.repository.detachCronSessions(cronId, targetSessionId);
        },
        resolveDefaultWorkspaceDir: options.resolveDefaultWorkspaceDir,
    });
    return {
        sessionCreation: {
            ...sessionCreation,
            async create(request) {
                if (mainConversationAgents(request.agentName) && !isSelfReminderId(request.cronId))
                    return {
                        sessionId: (await sessions.sessions.root.getRootSessionByAgent(request.agentName))
                            .sessionId,
                    };
                // A fixed target keeps its own model: borrowing the user's conversation must not rewrite
                // what they selected in it. A conversation this run creates still takes the definition's
                // model, applied by the adapter when it creates the Session.
                return sessionCreation.create(request);
            },
            // Level-triggered: the Queue re-checks every gate on this wake.
            ownerReleased: (sessionId) => turns.dispatchQueue(sessionId),
        },
        delivery: {
            deliver: async (request) => deliverRuntimeCron(turns, {
                ...request,
                text: options.mainConversationText && mainConversationAgents(request.agentName)
                    ? options.mainConversationText(request.text)
                    : request.text,
                // A schedule into the busy main conversation waits for the running Turn.
                deferWhileBusy: mainConversationAgents(request.agentName) &&
                    request.sessionId ===
                        (await sessions.sessions.root.getRootSessionByAgent(request.agentName)).sessionId,
                beforeDelivery: async () => {
                    await request.beforeDelivery?.();
                    const snapshot = await sessions.queue.committed.snapshot(request.sessionId);
                    if (snapshot.pause)
                        throw new CronDeliveryDeferredError('CRON_DELIVERY_QUEUE_PAUSED');
                },
            }, reportFailure),
        },
    };
}
/** New configurations replace all parameters; legacy keys keep the previous same-model policy. */
function sessionModelFields(model) {
    const { modelKey, selection } = decodeCronModel(model);
    return {
        effectiveModel: modelKey,
        effectiveModelVariant: selection?.variant ?? null,
        effectiveModelThinking: selection?.thinking ?? null,
        effectiveModelContextWindow: selection?.contextLimit ?? null,
        effectiveModelMaxOutputTokens: null,
    };
}
//# sourceMappingURL=runtime-session-ports.js.map