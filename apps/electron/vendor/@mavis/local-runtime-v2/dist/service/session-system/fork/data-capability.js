import { isTaskSession } from '../sessions/repo/drizzle/normalization.js';
import { CURRENT_SESSION_DATA_VERSION } from '../sessions/support/version.js';
import { createSessionForkDisplayCapability } from './display-data-capability.js';
/** Session-owned metadata, Display and asset operations used by Application Fork. */
export function createSessionForkDataCapability(input) {
    const display = createSessionForkDisplayCapability(input.messages, input.historyMutation);
    return {
        sessionDataVersion: CURRENT_SESSION_DATA_VERSION,
        boundary: display.boundary,
        sessions: {
            get: (sessionId) => input.sessions.get(sessionId),
            titleExists: async ({ agentName, title, }) => (await input.sessions.list({
                agentName,
                parentSessionId: null,
                includeHidden: true,
                includeSessionKinds: ['conversation', 'cron'],
            })).some((session) => session.title === title),
            probe: async ({ sessionId, visibility, }) => {
                const session = await input.sessions.get(sessionId);
                return session?.visibility === visibility ? session : undefined;
            },
            create: async (session) => {
                return input.records.createInternalSession({
                    agentName: session.agentName,
                    workspaceDir: session.workspaceDir,
                    title: session.title,
                    titleSource: session.titleSource,
                    sessionType: 'branch',
                    sessionKind: session.sessionKind ?? 'conversation',
                    parentSessionId: session.parentSessionId ?? null,
                    visibility: session.visibility ?? 'hidden',
                    ...(session.isDefaultWorkspace !== undefined
                        ? {
                            isDefaultWorkspace: session.isDefaultWorkspace,
                            preserveDefaultWorkspaceIdentity: true,
                        }
                        : {}),
                    ...(session.appMode ? { appMode: session.appMode } : {}),
                    ...(session.runLocation ? { runLocation: session.runLocation } : {}),
                    ...(await readForkedBindingFields(input.records, session)),
                    ...(session.effectiveModel !== undefined
                        ? { effectiveModel: session.effectiveModel }
                        : {}),
                    ...(session.effectiveModelVariant !== undefined
                        ? { effectiveModelVariant: session.effectiveModelVariant }
                        : {}),
                    effectiveModelThinking: session.effectiveModelThinking,
                    effectiveModelContextWindow: session.effectiveModelContextWindow,
                    effectiveModelMaxOutputTokens: session.effectiveModelMaxOutputTokens,
                    ...(session.purpose ? { purpose: session.purpose } : {}),
                    origin: 'user',
                });
            },
            update: (sessionId, fields) => input.records.mutateSession(sessionId, fields),
            delete: (sessionId) => input.records.discardCreatedSession(sessionId),
        },
        display,
        assets: {
            copyPrefix: async (request) => input.assets.copyForMessagePrefix(request),
            probe: (probe) => input.assets.probeCopy({
                sessionId: probe.targetSessionId,
                ...(probe.mode ? { mode: probe.mode } : {}),
                ...(probe.targetRoot ? { targetRoot: probe.targetRoot } : {}),
                copiedPaths: probe.copiedPaths,
            }),
            compensate: (cleanup) => input.assets.compensateCopy({
                sessionId: cleanup.targetSessionId,
                ...(cleanup.mode ? { mode: cleanup.mode } : {}),
                ...(cleanup.targetRoot ? { targetRoot: cleanup.targetRoot } : {}),
                ...(cleanup.copiedPaths ? { copiedPaths: cleanup.copiedPaths } : {}),
            }),
        },
    };
}
async function readForkedBindingFields(records, session) {
    const target = {
        sessionKind: session.sessionKind ?? 'conversation',
        sessionType: 'branch',
        parentSessionId: session.parentSessionId ?? null,
        visibility: session.visibility ?? 'hidden',
        ...(session.purpose ? { purpose: session.purpose } : {}),
    };
    if (!isTaskSession(target))
        return {};
    const source = await records.ensureSessionAgentDefinition(session.sourceSessionId);
    return source ? { forkedAgentDefinition: { definition: source.definition } } : {};
}
//# sourceMappingURL=data-capability.js.map