import { readAdvisorSelection, } from '../../../model-system/index.js';
import { LocalAgentConfigBuilder, } from './config/local-agent-config-builder.js';
import { ADVISOR_TOOL_NAME, isLocalTurnBuiltinToolAllowed, } from '../assembly/local-turn-tool-catalog.js';
import { readAgentProfile } from '../assembly/local-turn-tool-catalog-source.js';
/**
 * Conversation preparation owner shared by normal turns, manual compaction,
 * archive title generation and Context Debug.
 */
export class LocalAgentPreparationService {
    options;
    constructor(options) {
        this.options = options;
    }
    bindAgentShellResolver(resolve) {
        this.options.configBuilder.bindAgentShellResolver(resolve);
    }
    /**
     * The runtime's one `beta.ptcStore` decision, the same value the Agent Host creates
     * its store from, so the PTC prompt never names `store` on a Host that has none.
     */
    ptcStoreRequested() {
        return this.options.configBuilder.ptcStoreRequested();
    }
    /** Late-bound memory tail rendered at the end of a coordinator's system prompt. */
    bindCoordinatorMemoryProvider(provider) {
        this.options.configBuilder.bindCoordinatorMemoryProvider(provider);
    }
    /** Late-bound Session model repair; see `session-model-selection.ts`. */
    bindSessionModelRepair(repair) {
        this.options.configBuilder.bindSessionModelRepair(repair);
    }
    /** Late-bound Task snapshot store. Ordinary Sessions remain live. */
    bindTaskSessionBindings(bindings) {
        this.options.configBuilder.bindTaskSessionBindings(bindings);
    }
    /** Late-bound Project folder reader; absent keeps the single-folder behavior. */
    bindAdditionalWorkspaceRoots(read) {
        this.options.configBuilder.bindAdditionalWorkspaceRoots(read);
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
        const agentConfig = Object.freeze({ ...builtAgentConfig });
        const advisor = this.bindAdvisor(input, agentConfig);
        const llm = await this.resolveModel({
            sessionId: input.session.sessionId,
            turnId: input.turnId,
            agentConfig: builtAgentConfig,
        });
        return {
            agentConfig,
            ...(built.agentShell ? { agentShell: built.agentShell } : {}),
            llm,
            outputRevisionInstruction: built.outputRevisionInstruction,
            ...(built.retryContinuationPrompt
                ? { retryContinuationPrompt: built.retryContinuationPrompt }
                : {}),
            ...(built.promptRead ? { promptRead: built.promptRead } : {}),
            ...(built.additionalWorkspaceRoots
                ? { additionalWorkspaceRoots: built.additionalWorkspaceRoots }
                : {}),
            ...(advisor ? { advisor } : {}),
        };
    }
    /**
     * One binding per Turn, recomputed from the Session's selection and never persisted: the tool
     * catalog offers the advisor tool exactly when it is present.
     */
    bindAdvisor(input, agentConfig) {
        const stored = input.session.advisor;
        if (!stored?.enabled)
            return undefined;
        if (!isLocalTurnBuiltinToolAllowed(ADVISOR_TOOL_NAME, readAgentProfile(agentConfig))) {
            return undefined;
        }
        const read = readAdvisorSelection(this.options.configBuilder.readRuntimeConfig(), stored);
        this.reportAdvisorRead(input, read);
        return read.advisor;
    }
    /** The stored selection was not used as written: say so, since the UI cannot see it. */
    reportAdvisorRead(input, read) {
        if (read.dropped.length === 0 && !read.failure)
            return;
        const fields = {
            session_id: input.session.sessionId,
            turn_id: input.turnId,
            advisor_model: read.selection.model,
            ...(read.dropped.length > 0 ? { dropped: read.dropped } : {}),
            ...(read.failure ? { code: read.failure.code, reason: read.failure.message } : {}),
        };
        this.options.logger?.warn(fields, read.failure
            ? '[advisor] the stored advisor model cannot be used; this Turn runs without the advisor'
            : '[advisor] the stored advisor settings no longer apply; this Turn uses the model defaults');
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