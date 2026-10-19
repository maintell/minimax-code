import yaml from 'yaml';
import { AgentServiceError, } from '../../service/agent/index.js';
import { AgentModelSelectionError, freezeManagedQueueModel, formatModelKey, isMiniMaxM3ModelId, LocalModelProviderError, modelConfigForRef, normalizeModelThinkingEffort, normalizeModelThinkingEffortOptions, parseSourceQualifiedModelKey, previewAgentModelSelection, resolveModelThinkingMiddleEffort, resolveEffectiveAgentModelSelection, } from '../../service/model-system/index.js';
/** Stable rejection that the Queue boundary can project without exposing an internal cause. */
export class ChannelAgentModelSelectionError extends Error {
    details;
    constructor(message, details) {
        super(message);
        this.details = details;
        this.name = 'ChannelAgentModelSelectionError';
    }
}
/**
 * An IM route fence, deliberately distinct from a model selection failure.
 * The channel adapter keeps its existing reconnect/routing error semantics
 * when an Agent was deleted or recreated between route resolution and submit.
 */
class ChannelAgentIdentityError extends AgentServiceError {
    constructor(message) {
        super('AGENT_CONFIG_INSTANCE_CONFLICT', message);
        this.name = 'ChannelAgentIdentityError';
    }
}
/**
 * Resolves one inbound IM message from its currently bound Agent only.  A
 * historical Session model and caller-supplied model never enter this path.
 */
export async function resolveChannelAgentQueueModel(input) {
    const document = await readChannelAgentDocument(input);
    const modelSource = sourceForDocument(document);
    const configured = configuredSelection(document);
    const resolved = resolveStrictSelection(input.config, configured, modelSource);
    const requested = queueModelFromResolved(resolved, modelSource);
    try {
        const frozen = freezeManagedQueueModel(input.config, { sessionKind: 'channel' }, requested);
        return {
            ...requested,
            ...(frozen ?? {}),
            frozen: true,
            modelSource,
        };
    }
    catch (error) {
        throw modelSelectionError(error, input.config, configured, modelSource);
    }
}
/** Read-only model presentation for a channel Session; invalid stale config remains unselected. */
export async function previewChannelAgentModelSelection(input) {
    try {
        const document = await input.agents.getConfigDocument(`agent:${input.agentName}`);
        const configured = configuredSelection(document);
        return previewAgentModelSelection({
            config: input.config,
            sources: configured.model !== undefined
                ? [
                    {
                        source: 'channel-agent-preview',
                        selection: configured,
                        requireCatalog: true,
                        allowCustomProviderPrefixFallback: true,
                        defaultMissingEffortOff: true,
                    },
                ]
                : [],
        });
    }
    catch {
        // Model listing must stay usable to repair a deleted or malformed Agent selection.
        return undefined;
    }
}
/**
 * Keeps a channel Agent authoritative while reusing the canonical Config CAS
 * writer. AUTO remains an absent Agent model and is handled by the existing
 * runtime-default selection workflow.
 */
export async function selectChannelAgentModel(input) {
    const document = await input.agents.getConfigDocument(`agent:${input.agentName}`);
    if (sourceForDocument(document) === 'runtime-default')
        return 'runtime-default';
    const content = patchChannelAgentModelContent(document, input.config, input.selection);
    await input.agents.putConfigDocument({
        requestRef: `agent:${document.exactOwnerName}`,
        content,
        expectedRevision: document.revision,
        ...(document.ownerKind === 'custom' && document.ownerInstanceId
            ? { expectedOwnerInstanceId: document.ownerInstanceId }
            : {}),
    });
    return 'agent';
}
async function readChannelAgentDocument(input) {
    // Preserve Agent/routing failures verbatim. Only catalog/selection failures
    // below are allowed to become QueueServiceError('model-invalid').
    const document = await input.agents.getConfigDocument(`agent:${input.session.agentName}`);
    const expectedAgentId = input.targetAgentId?.trim();
    // Desktop channel Session sends do not have an external IM route identity.
    // When one was captured at IM admission, it must match exactly so a deleted
    // and recreated same-name custom Agent cannot consume the old inbound item.
    if (expectedAgentId &&
        document.ownerKind === 'custom' &&
        document.ownerInstanceId !== expectedAgentId) {
        throw new ChannelAgentIdentityError('The bound Agent changed before this message could be accepted. Reconnect the channel and send a new message.');
    }
    if (document.ownerKind === 'builtin' && expectedAgentId) {
        throw new ChannelAgentIdentityError('The bound Agent identity is no longer valid. Reconnect the channel and send a new message.');
    }
    return document;
}
function configuredSelection(document) {
    const configured = document.configured;
    return {
        ...(configured.model !== undefined ? { model: configured.model } : {}),
        ...(configured.effort !== undefined ? { effort: configured.effort } : {}),
        ...(configured.mavis?.contextWindow === undefined
            ? {}
            : { contextWindow: configured.mavis.contextWindow }),
        ...(configured.mavis?.maxOutputTokens === undefined
            ? {}
            : { maxOutputTokens: configured.mavis.maxOutputTokens }),
    };
}
function sourceForDocument(document) {
    return document.configured.model === undefined ? 'runtime-default' : 'agent';
}
function resolveStrictSelection(config, configured, modelSource) {
    try {
        const resolved = resolveEffectiveAgentModelSelection({
            config,
            sources: configured.model !== undefined
                ? [
                    {
                        source: 'channel-agent',
                        selection: configured,
                        requireCatalog: true,
                        allowCustomProviderPrefixFallback: true,
                        defaultMissingEffortOff: true,
                    },
                ]
                : [],
        });
        if (resolved)
            return resolved;
    }
    catch (error) {
        throw modelSelectionError(error, config, configured, modelSource);
    }
    throw new ChannelAgentModelSelectionError('No model is configured for the bound Agent or runtime default. Update the Agent configuration or Settings.', { modelSource });
}
function queueModelFromResolved(resolved, modelSource) {
    return {
        provider_id: resolved.providerId,
        model_id: resolved.modelId,
        ...(resolved.reasoning === undefined ? {} : { reasoning: resolved.reasoning }),
        ...(resolved.contextWindow === undefined ? {} : { context_limit: resolved.contextWindow }),
        ...(resolved.maxOutputTokens === undefined
            ? {}
            : { max_output_tokens: resolved.maxOutputTokens }),
        ...(resolved.effort === undefined ? {} : { thinking: { effort: resolved.effort } }),
        ...(resolved.parameterSnapshot ? { parameterSnapshot: resolved.parameterSnapshot } : {}),
        frozen: true,
        modelSource,
    };
}
function modelSelectionError(error, config, configured, modelSource) {
    if (error instanceof ChannelAgentModelSelectionError)
        return error;
    if (!(error instanceof AgentModelSelectionError) && !(error instanceof LocalModelProviderError)) {
        throw error;
    }
    const model = modelForError(config, configured, modelSource);
    const label = modelSource === 'agent' ? 'selected Agent model' : 'runtime default model';
    const remediation = modelSource === 'agent' ? 'Update the Agent configuration.' : 'Update Settings.';
    const selected = model ? ` (${model.providerId}/${model.modelId})` : '';
    return new ChannelAgentModelSelectionError(`${label}${selected} is unavailable. ${remediation}`, {
        ...(model ? { model } : {}),
        modelSource,
    });
}
function modelForError(config, configured, modelSource) {
    const raw = modelSource === 'agent' ? configured.model : config.defaultModel;
    const parsed = raw ? parseSourceQualifiedModelKey(raw) : undefined;
    return parsed ? { providerId: parsed.providerId, modelId: parsed.modelId } : undefined;
}
function patchChannelAgentModelContent(current, config, selection) {
    const parts = splitCanonicalConfigContent(current.content);
    const document = parseCanonicalConfigFrontmatter(parts.frontmatter);
    const model = formatModelKey(selection.providerId, selection.modelId);
    const replaceParameters = selection.replaceSelection === true || current.configured.model !== model;
    document.set('model', model);
    const requestedEffort = requestedCanonicalEffort(config, selection);
    patchModelEffort(document, requestedEffort === undefined && replaceParameters ? null : requestedEffort);
    patchMavisNumber(document, 'contextWindow', selection.contextLimit, replaceParameters);
    patchMavisNumber(document, 'maxOutputTokens', undefined, replaceParameters);
    assertCanonicalModelGroup(config, model, modelParametersFromDocument(document));
    return renderCanonicalConfigContent(parts, document);
}
function patchModelEffort(document, effort) {
    if (effort === undefined)
        return;
    if (effort)
        document.set('effort', effort);
    else
        document.delete('effort');
}
function requestedCanonicalEffort(config, selection) {
    const requestedThinking = requestedThinkingState(selection);
    const model = modelConfigForRef(config, selection.providerId, selection.modelId);
    const explicitEffort = selection.thinking?.effort;
    if (explicitEffort !== undefined) {
        assertThinkingEffortMatchesRequest(requestedThinking, explicitEffort, model);
        return explicitEffort;
    }
    if (requestedThinking === undefined)
        return isExplicitThinkingClear(selection) ? null : undefined;
    if (model?.thinking_config?.mode === 'forced_on' ||
        model?.thinking_config?.mode === 'forced_off') {
        return undefined;
    }
    if (!requestedThinking)
        return 'off';
    if (isCanonicalM3ThinkingSwitch(selection, model))
        return 'on';
    const effort = enabledThinkingEffort(model);
    if (effort)
        return effort;
    if (model?.reasoning === true)
        return undefined;
    throw unsupportedChannelModelParameter();
}
function assertThinkingEffortMatchesRequest(requestedThinking, effort, model) {
    if (requestedThinking === undefined || model?.thinking_config?.mode?.startsWith('forced_'))
        return;
    if (requestedThinking !== isDisabledThinkingEffort(effort))
        return;
    throw unsupportedChannelModelParameter();
}
function isCanonicalM3ThinkingSwitch(selection, model) {
    return (isMiniMaxM3ModelId(selection.modelId) &&
        !selection.providerId.startsWith('custom_provider:') &&
        model?.thinking_config?.mode === 'switchable');
}
function requestedThinkingState(selection) {
    const variant = thinkingStateForVariant(selection.variant);
    if (selection.reasoning !== undefined &&
        variant !== undefined &&
        selection.reasoning !== variant) {
        throw unsupportedChannelModelParameter();
    }
    return selection.reasoning ?? variant;
}
function thinkingStateForVariant(variant) {
    if (variant === undefined)
        return undefined;
    if (variant === 'thinking')
        return true;
    if (variant === '' || variant === 'none-thinking')
        return false;
    throw unsupportedChannelModelParameter();
}
function enabledThinkingEffort(model) {
    const efforts = normalizeModelThinkingEffortOptions(model?.thinking?.effortOptions);
    if (!efforts)
        return undefined;
    const configured = normalizeModelThinkingEffort(model?.thinking?.defaultEffort);
    if (configured && efforts.includes(configured) && !isDisabledThinkingEffort(configured)) {
        return configured;
    }
    const middle = resolveModelThinkingMiddleEffort(efforts);
    if (middle && !isDisabledThinkingEffort(middle))
        return middle;
    return efforts.find((effort) => !isDisabledThinkingEffort(effort));
}
function isDisabledThinkingEffort(effort) {
    const normalized = normalizeModelThinkingEffort(effort)?.toLowerCase();
    return normalized === 'off' || normalized === 'none';
}
function isExplicitThinkingClear(selection) {
    return (selection.thinking === null ||
        (selection.thinking !== undefined && selection.thinking.effort === undefined));
}
function unsupportedChannelModelParameter() {
    return new LocalModelProviderError(400, 'The selected model variant cannot be stored in the bound Agent configuration.', 'VALIDATION_ERROR');
}
function modelParametersFromDocument(document) {
    const effort = document.get('effort');
    const contextWindow = document.getIn(['x-mavis', 'contextWindow']);
    const maxOutputTokens = document.getIn(['x-mavis', 'maxOutputTokens']);
    return {
        ...(typeof effort === 'string' && effort ? { effort } : {}),
        ...(typeof contextWindow === 'number' ? { contextWindow } : {}),
        ...(typeof maxOutputTokens === 'number' ? { maxOutputTokens } : {}),
    };
}
function assertCanonicalModelGroup(config, model, parameters) {
    try {
        const resolved = resolveEffectiveAgentModelSelection({
            config,
            sources: [
                {
                    source: 'channel-agent-write',
                    selection: { model, ...parameters },
                    requireCatalog: true,
                    allowCustomProviderPrefixFallback: true,
                    defaultMissingEffortOff: true,
                },
            ],
        });
        if (resolved)
            return;
    }
    catch (error) {
        if (!(error instanceof AgentModelSelectionError) &&
            !(error instanceof LocalModelProviderError)) {
            throw error;
        }
        throw new LocalModelProviderError(400, error.message, 'VALIDATION_ERROR');
    }
    throw unsupportedChannelModelParameter();
}
function patchMavisNumber(document, key, value, replaceParameters) {
    if (value === undefined && !replaceParameters)
        return;
    if (value === undefined) {
        document.deleteIn(['x-mavis', key]);
        return;
    }
    document.setIn(['x-mavis', key], value);
}
function splitCanonicalConfigContent(content) {
    const match = /^(\uFEFF?)---(\r?\n)([\s\S]*?)^---(\r?\n|$)([\s\S]*)$/mu.exec(content);
    if (!match)
        throw invalidCanonicalConfig();
    const [, prefix = '', opening = '', frontmatter = '', closing = '', body = ''] = match;
    return {
        prefix: prefix === '\uFEFF' ? prefix : '',
        frontmatter,
        body,
        lineEnding: opening === '\r\n' ? '\r\n' : '\n',
        closingLineEnding: closingFrontmatterLineEnding(closing),
    };
}
function closingFrontmatterLineEnding(value) {
    if (value === '\r\n')
        return '\r\n';
    if (value === '\n')
        return '\n';
    return '';
}
function parseCanonicalConfigFrontmatter(frontmatter) {
    let document;
    try {
        document = yaml.parseDocument(frontmatter, { prettyErrors: false, uniqueKeys: true });
    }
    catch {
        throw invalidCanonicalConfig();
    }
    if (document.errors.length > 0 || !document.contents || !yaml.isMap(document.contents)) {
        throw invalidCanonicalConfig();
    }
    return document;
}
function renderCanonicalConfigContent(parts, document) {
    let frontmatter;
    try {
        frontmatter = document.toString().trimEnd().replace(/\r?\n/gu, parts.lineEnding);
    }
    catch {
        throw invalidCanonicalConfig();
    }
    return `${parts.prefix}---${parts.lineEnding}${frontmatter}${parts.lineEnding}---${parts.closingLineEnding}${parts.body}`;
}
function invalidCanonicalConfig() {
    return new AgentServiceError('AGENT_CONFIG_INVALID', 'Agent configuration frontmatter is invalid.');
}
//# sourceMappingURL=channel-agent-model-selection.js.map