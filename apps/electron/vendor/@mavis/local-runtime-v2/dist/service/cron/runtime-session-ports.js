import { decodeCronModel } from '@mavis/shared/cron-model';
import { createCronSessionPurpose, formatCronRunTitle } from '@mavis/shared/cron-purpose';
import { createHostCronSessionCreation } from './adapters/session-creation.adapter.js';
import { deliverRuntimeCron } from './runtime-delivery.js';
import { CronDeliveryDeferredError } from './errors.js';
/** Binds Cron's session ports to the V2 Agent, Session, and Turn capabilities. */
export function createRuntimeCronSessionPorts(options) {
    const { agentSessionPorts, sessions, turns, reportFailure, lifecycle, deletion } = options;
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
                const result = await sessionCreation.create(request);
                const model = request.model?.trim();
                if (request.sessionTarget.mode === 'sessionId' &&
                    request.sessionTarget.sessionId &&
                    model) {
                    const session = await sessions.sessions.repository.get(result.sessionId);
                    const decoded = decodeCronModel(model);
                    if (decoded.selection || session?.effectiveModel !== decoded.modelKey) {
                        await lifecycle.mutateSession(result.sessionId, sessionModelFields(model));
                    }
                }
                return result;
            },
            // Level-triggered: the Queue re-checks every gate on this wake.
            ownerReleased: (sessionId) => turns.dispatchQueue(sessionId),
        },
        delivery: {
            deliver: (request) => deliverRuntimeCron(turns, {
                ...request,
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