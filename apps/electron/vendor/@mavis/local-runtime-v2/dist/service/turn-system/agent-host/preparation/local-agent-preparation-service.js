import { LocalAgentConfigBuilder, } from './config/local-agent-config-builder.js';
/**
 * Conversation preparation owner shared by normal turns, manual compaction,
 * archive title generation and Context Debug.
 */
export class LocalAgentPreparationService {
    options;
    constructor(options) {
        this.options = options;
    }
    /** Late-bound Session model repair; see `session-model-selection.ts`. */
    bindSessionModelRepair(repair) {
        this.options.configBuilder.bindSessionModelRepair(repair);
    }
    /** Late-bound Task snapshot store. Ordinary Sessions remain live. */
    bindTaskSessionBindings(bindings) {
        this.options.configBuilder.bindTaskSessionBindings(bindings);
    }
    async prepare(input) {
        const model = toModelOverride(input.request.input.model);
        return this.prepareResolved({
            session: input.session,
            agent: input.agent,
            turnId: input.turnId,
            isSessionFirstTurn: input.history.messages.length === 0,
            ...(input.desktopCapabilities ? { desktopCapabilities: input.desktopCapabilities } : {}),
            ...(model ? { model } : {}),
            ...(input.request.clientIntent ? { clientIntent: input.request.clientIntent } : {}),
            ...(input.promptRead ? { promptRead: input.promptRead } : {}),
        });
    }
    prepareCompaction(input) {
        return this.prepareResolved({
            session: input.session,
            agent: input.agent,
            turnId: input.turnId,
            isSessionFirstTurn: input.history.messages.length === 0,
            ...(input.desktopCapabilities ? { desktopCapabilities: input.desktopCapabilities } : {}),
        });
    }
    buildAgentConfig(input) {
        return this.options.configBuilder.build({
            ...input,
            isSessionFirstTurn: input.isSessionFirstTurn ?? false,
        });
    }
    resolveModel(input) {
        return this.options.modelResolver.resolveModel(input);
    }
    async prepareResolved(input) {
        const built = await this.options.configBuilder.buildPrepared(input);
        const builtAgentConfig = built.agentConfig;
        const llm = await this.resolveModel({
            sessionId: input.session.sessionId,
            turnId: input.turnId,
            agentConfig: builtAgentConfig,
        });
        return {
            agentConfig: Object.freeze({ ...builtAgentConfig }),
            llm,
            outputRevisionInstruction: built.outputRevisionInstruction,
            ...(built.retryContinuationPrompt
                ? { retryContinuationPrompt: built.retryContinuationPrompt }
                : {}),
            ...(built.promptRead ? { promptRead: built.promptRead } : {}),
        };
    }
}
function toModelOverride(model) {
    if (!model)
        return undefined;
    const providerId = model.providerId?.trim();
    const modelId = model.modelId?.trim();
    const variant = model.variant === '' ? '' : model.variant?.trim() || undefined;
    const override = preparedModelParameters(model);
    if (providerId)
        override.provider_id = providerId;
    if (modelId)
        override.model_id = modelId;
    if (variant !== undefined)
        override.variant = variant;
    return Object.keys(override).length > 0 ? override : undefined;
}
function preparedModelParameters(model) {
    const effort = model.thinking?.effort;
    return {
        ...(model.parameterSnapshot ? { parameterSnapshot: model.parameterSnapshot } : {}),
        ...(model.reasoning != null ? { reasoning: model.reasoning } : {}),
        ...(model.contextLimit != null ? { contextLimit: model.contextLimit } : {}),
        ...(model.maxOutputTokens != null ? { maxOutputTokens: model.maxOutputTokens } : {}),
        ...(model.frozen === true ? { frozen: true } : {}),
        ...(model.modelSource ? { modelSource: model.modelSource } : {}),
        ...(model.thinking != null ? { thinking: effort != null ? { effort } : {} } : {}),
    };
}
//# sourceMappingURL=local-agent-preparation-service.js.map