import { messagesHaveSkillAvailabilityNotice } from '@mavis/agent-tools';
import { readAdvisorSelection, } from '../../../model-system/index.js';
import { ADVISOR_TOOL_NAME, isLocalTurnBuiltinToolAllowed, readAgentProfile, } from '@mavis/harness';
import { LocalAgentConfigBuilder, } from './local-agent-config-builder.js';
import { sessionModelPinRequest, } from './session-model-selection.js';
/**
 * Conversation preparation owner shared by normal turns, manual compaction,
 * archive title generation and Context Debug.
 *
 * It is also the desktop `ModelAccess`: a Turn's model is resolved once, the
 * preparation returns it without its credential, and `credential()` hands the
 * credential of that same resolution to the harness. Entries are keyed by the
 * returned model object and die with it.
 */
export class LocalAgentPreparationService {
    options;
    credentials = new WeakMap();
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
            // A continuation resumes the last Turn without a new user message, so it has
            // nowhere to carry a skill-availability update: it only reads the window.
            commitSkillCatalog: input.request.executionMode !== 'continuation',
            skillCatalogHistoryHasNotice: () => messagesHaveSkillAvailabilityNotice(input.history.messages),
            // Only a real Turn may pin the Session's model; compaction and side builds never do.
            sessionModelPin: sessionModelPinRequest(input.history.messages),
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
    async credential(model) {
        const credential = this.credentials.get(model);
        if (!credential) {
            throw new Error('LocalAgentPreparationService: the model was not prepared by this service');
        }
        return credential;
    }
    async prepareResolved(input) {
        const built = await this.options.configBuilder.buildPrepared(input);
        const builtAgentConfig = built.agentConfig;
        const agentConfig = Object.freeze({ ...builtAgentConfig });
        const advisor = this.bindAdvisor(input, agentConfig);
        const { llm, credential } = splitModelCredential(await this.resolveModel({
            sessionId: input.session.sessionId,
            turnId: input.turnId,
            agentConfig: builtAgentConfig,
        }));
        this.credentials.set(llm, credential);
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
            ...(built.skillAvailabilityNotice
                ? { skillAvailabilityNotice: built.skillAvailabilityNotice }
                : {}),
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
/** Keeps every credential field that the resolver set, including one set to `undefined`. */
function splitModelCredential(resolved) {
    const { apiKey, headers, fetch, fileApiGatewayAuth, ...llm } = resolved;
    const credential = {
        ...('apiKey' in resolved ? { apiKey } : {}),
        ...('headers' in resolved ? { headers } : {}),
        ...('fetch' in resolved ? { fetch } : {}),
        ...('fileApiGatewayAuth' in resolved ? { fileApiGatewayAuth } : {}),
    };
    return { llm, credential };
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