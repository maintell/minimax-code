import { createHookExtension } from '@mavis/agent-runtime';
/** Exposes only durable local attachment registration to v2 ingress owners. */
export function createV1AttachmentRegistration(source) {
    const attachments = source.createHostedAgentCapabilities().attachments;
    return {
        register: attachments.register,
        discard: attachments.discard,
        resolveSource: attachments.resolveSource,
    };
}
/**
 * Optional model-resolver ports are spread only when the host supplies them.
 * Extracted so the adapter below stays within its complexity budget.
 */
function createV1ModelResolver(hosted) {
    return {
        ...(hosted.authContextGetter ? { authContextGetter: hosted.authContextGetter } : {}),
        ...(hosted.authContextInvalidator
            ? { authContextInvalidator: hosted.authContextInvalidator }
            : {}),
        ...(hosted.routingContextGetter ? { routingContextGetter: hosted.routingContextGetter } : {}),
        providerAuthGetter: hosted.providerAuthGetter,
        ...(hosted.fetchImpl ? { fetchImpl: hosted.fetchImpl } : {}),
    };
}
/**
 * The only v1 -> v2 AgentHost adapter. It maps product owners into native
 * composition ports and never exposes the v1 Host to TurnSystem.
 */
export function createV1AgentHostProductCapabilities(source, evalReporterFactory, cloudHandoff) {
    const hosted = source.createHostedAgentCapabilities();
    const websiteDeploy = createV1WebsiteDeployProjectionAdapter(hosted.websiteDeploy);
    return {
        preparation: {
            configBuilder: {
                config: hosted.config,
                memory: hosted.memory,
                skills: hosted.skills,
                modelRepairLogger: hosted.runnerLogger,
            },
            modelResolver: createV1ModelResolver(hosted),
        },
        // V1 Computer Use state is retired. The V2 CUA composition replaces this
        // source when the broker client is present; compatibility alone stays
        // globally closed.
        turnRuntimeFacts: {
            snapshot: () => ({ computerUseGloballyEnabled: false }),
        },
        checkpointState: hosted.checkpointState,
        // Goal tools come from the local-runtime-v2 Goal owner (withGoalAgentProduct).
        toolSources: {
            resolve: async (input) => ({
                ...(await hosted.toolSources.resolve(input)),
                threadGoalTools: [],
            }),
        },
        inputPreparation: {
            assets: hosted.attachments,
            materializePrompt: hosted.websiteDeploy.materializeSources,
            reminders: {
                buildBackground: hosted.reminders.buildBackground,
                buildSystem: (input) => {
                    const model = systemReminderModel(input.agentConfig);
                    return hosted.reminders.buildSystem({
                        session: input.session,
                        resourceAgentName: input.agent.resourceAgentName ?? input.agent.agentName,
                        promptText: input.promptText,
                        turnId: input.turnId,
                        deferTelemetry: true,
                        contextUsagePromptRanges: input.agentConfig.contextUsagePromptRanges,
                        availableSkillNames: (Array.isArray(input.agentConfig.skills)
                            ? input.agentConfig.skills
                            : []).flatMap((skill) => isRecord(skill) && typeof skill.name === 'string' ? [skill.name] : []),
                        ...(input.sessionIdInContext ? { sessionIdInContext: true } : {}),
                        ...(model ? { model } : {}),
                    });
                },
                confirmBackgroundTaskReads: async (input) => {
                    const confirmed = await hosted.reminders.confirmBackgroundTaskReads(input);
                    return confirmed.flatMap((value) => {
                        if (typeof value === 'string')
                            return [value];
                        const taskId = Reflect.get(Object(value), 'taskId');
                        return typeof taskId === 'string' ? [taskId] : [];
                    });
                },
            },
        },
        permission: hosted.permissions,
        sessionAssets: { listSessionReadablePaths: hosted.attachments.listSessionReadablePaths },
        terminalMemory: hosted.terminalMemory,
        runner: {
            contextUsage: hosted.contextUsage,
            logger: hosted.runnerLogger,
            ...(hosted.metricsClient ? { metricsClient: hosted.metricsClient } : {}),
            ...(hosted.llmRequestFailureHook
                ? { onLLMRequestFailure: hosted.llmRequestFailureHook }
                : {}),
            ...(hosted.observeLLMRequest ? { observeLLMRequest: hosted.observeLLMRequest } : {}),
            ...(evalReporterFactory ? { evalReporterFactory } : {}),
        },
        fileApi: {
            ...(hosted.fetchImpl ? { fetchImpl: hosted.fetchImpl } : {}),
            logger: hosted.runnerLogger,
        },
        executor: {
            createChildBashLifecycle: hosted.createChildBashLifecycle,
            fileChanges: {
                begin: hosted.fileChanges.begin,
                finalize: (input) => hosted.fileChanges.finalize(input),
                markFailed: async (input) => {
                    await hosted.fileChanges.markFailed(input);
                },
            },
            reportFailure: hosted.reportFailure,
            projectRuntimeEvent: async ({ sessionId, turnId, event }) => {
                const reviewed = hosted.review.projectRuntimeEvent({ sessionId, turnId }, event);
                return reviewed
                    ? websiteDeploy.projectRuntimeEvent({ sessionId, turnId, event: reviewed })
                    : undefined;
            },
        },
        normalExtensions: [
            websiteDeploy.extension,
            createHookExtension({
                id: 'local-builtin-tool-hooks',
                description: 'Product-internal tool policies and result handlers.',
                handlers: {
                    before_tool_call: (toolContext, _signal, turn) => hosted.hooks.beforeToolCall({
                        agentName: turn.agentName,
                        sessionId: turn.sessionId,
                        turnId: turn.turnId,
                        model: modelIdentity(turn.model),
                        toolContext,
                    }),
                    after_tool_call: (toolContext, _signal, turn) => hosted.hooks.afterToolCall({
                        agentName: turn.agentName,
                        sessionId: turn.sessionId,
                        turnId: turn.turnId,
                        toolContext,
                    }),
                },
            }),
            createHostedReviewExtension(hosted.review),
            ...(cloudHandoff ? [cloudHandoff.extension] : []),
        ],
    };
}
function createV1WebsiteDeployProjectionAdapter(capability) {
    const projections = new Map();
    const projectionFor = (sessionId, turnId) => {
        const key = turnKey({ sessionId, turnId });
        const existing = projections.get(key);
        if (existing)
            return existing;
        const created = capability.createTurnProjection();
        projections.set(key, created);
        return created;
    };
    return {
        projectRuntimeEvent: (input) => projectionFor(input.sessionId, input.turnId).projectRuntimeEvent(input.event),
        extension: {
            id: 'local-v1-website-deploy-projection',
            description: 'Project local website deploy output through the v2 turn owner.',
            init(pi) {
                pi.on('after_tool_call', (input, _signal, turn) => projectionFor(turn.sessionId, turn.turnId).afterToolCallHook(input));
                pi.on('after_llm_call', (input, turn) => projectionFor(turn.sessionId, turn.turnId).afterLlmCallHook(input));
                pi.on('turn_end', (_event, turn) => {
                    projections.delete(turnKey(turn));
                });
            },
        },
    };
}
function createHostedReviewExtension(review) {
    return {
        id: 'local-code-review',
        description: 'Activate and validate the local structured code review workflow.',
        init(pi) {
            pi.contributeUserPromptPrefix((turn) => review.buildUserPromptPrefix({
                sessionId: turn.sessionId,
                turnId: turn.turnId,
                agentName: turn.agentName,
                workspaceDir: turn.workspaceDir,
                userInput: turn.userInput.text,
                ...(turn.promptRead ? { promptRead: turn.promptRead } : {}),
                ...(turn.turnIntent ? { intent: turn.turnIntent } : {}),
            }));
            pi.on('before_llm_call', (input, turn) => review.beforeLlmCall(input, { sessionId: turn.sessionId, turnId: turn.turnId }));
            pi.on('after_llm_call', (input, turn) => review.afterLlmCall(input, { sessionId: turn.sessionId, turnId: turn.turnId }, modelIdentity(turn.model)));
            pi.on('before_tool_call', (input, signal, turn) => review.beforeToolCall(input, signal, {
                sessionId: turn.sessionId,
                turnId: turn.turnId,
            }));
            pi.on('turn_end', (_event, turn) => {
                review.endTurn({ sessionId: turn.sessionId, turnId: turn.turnId });
            });
        },
    };
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function turnKey(context) {
    return `${context.sessionId}\0${context.turnId}`;
}
function modelIdentity(model) {
    const provider = typeof model.provider === 'string' ? model.provider : undefined;
    const id = readModelId(model);
    return provider && id ? `${provider}/${id}` : id;
}
function readModelId(model) {
    if (typeof model.model_id === 'string')
        return model.model_id;
    return typeof model.id === 'string' ? model.id : undefined;
}
function systemReminderModel(agentConfig) {
    const raw = agentConfig.model;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        return undefined;
    const model = raw;
    const providerID = typeof model.provider === 'string' ? model.provider : undefined;
    const modelID = readModelId(model);
    if (!providerID || !modelID)
        return undefined;
    return {
        providerID,
        modelID,
        ...(typeof model.variant === 'string' && model.variant ? { variant: model.variant } : {}),
    };
}
/**
 * Validates a persisted Agent mention through the same trusted v1 resolver
 * chain that Task uses. The primary family is intentionally excluded: a main
 * session may nominate only a delegatable SubAgent, never itself.
 */
export async function resolveDelegatableAgentReference(resolver, requestRef, resolveTarget) {
    try {
        const scope = await resolver.resolveAgentReadScope(requestRef);
        if (scope.canonicalName === scope.primaryName)
            return 'unauthorized';
        await resolveTarget(resolver, requestRef);
        return 'authorized';
    }
    catch {
        // Resolver failures must neither reveal roster details nor emit Task text.
        return 'unknown';
    }
}
export function legacyCollisionMigrationId(error) {
    const migrationId = error && typeof error === 'object' && 'migrationId' in error
        ? error.migrationId
        : undefined;
    return typeof migrationId === 'string' && /^agent-name-conflicts-\d+$/u.test(migrationId)
        ? migrationId
        : undefined;
}
export function createV1CommerceCompatibility(options) {
    return {
        readAuthSnapshot: () => {
            const { accessToken, loginEpoch } = options.authContextGetter?.() ?? {};
            return { accessToken, loginEpoch };
        },
    };
}
export function createV1MiniAppToolRules(routeContext) {
    const config = () => routeContext().configGetter();
    return {
        listGlobalRules: () => routeContext().permissionRules.listRules({ source: 'global' }),
        readPermissionMode: () => config().permissionMode,
        readPolicyOwner: () => (config().permission?.policyOwner === 'engine' ? 'engine' : 'core'),
        readDataDir: () => config().dataDir,
        addGlobalAllowRule: (toolName) => routeContext().permissionRules.applyUpdate({
            type: 'addRules',
            source: 'global',
            destination: 'global',
            behavior: 'allow',
            rules: [{ tool_name: toolName }],
        }),
    };
}
//# sourceMappingURL=agent-product-capabilities.js.map