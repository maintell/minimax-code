export function toModelInfo(record) {
    return {
        providerId: record.providerId,
        modelId: record.modelId,
        ...toModelIdentityFields(record),
        ...toModelCapabilityFields(record),
        ...toModelThinkingFields(record),
        ...toModelProviderFields(record),
    };
}
function toModelIdentityFields(record) {
    return {
        displayName: record.displayName,
        ...(record.configurationSource ? { configurationSource: record.configurationSource } : {}),
        enabled: record.enabled,
        selected: record.selected,
        ...(record.variant !== undefined ? { variant: record.variant } : {}),
        ...(record.supportedVariants ? { supportedVariants: record.supportedVariants } : {}),
    };
}
function toModelCapabilityFields(record) {
    return {
        ...(record.contextLimit !== undefined ? { contextLimit: record.contextLimit } : {}),
        ...(record.defaultContextLimit !== undefined
            ? { defaultContextLimit: record.defaultContextLimit }
            : {}),
        ...(record.contextWindowOptions
            ? { contextWindowOptions: [...record.contextWindowOptions] }
            : {}),
        ...(record.contextWindowOptionHints
            ? { contextWindowOptionHints: { ...record.contextWindowOptionHints } }
            : {}),
        ...(record.selected && record.thinking ? { thinking: { ...record.thinking } } : {}),
        modelConfigId: record.modelConfigId,
        ...(record.effortOptions ? { effortOptions: record.effortOptions } : {}),
        ...(record.defaultEffort ? { defaultEffort: record.defaultEffort } : {}),
        ...toModelModalityFields(record),
        ...(record.maxOutputTokens !== undefined ? { maxOutputTokens: record.maxOutputTokens } : {}),
    };
}
function toModelModalityFields(record) {
    return {
        ...(record.modalities
            ? {
                modalities: {
                    ...(record.modalities.input ? { input: [...record.modalities.input] } : {}),
                    ...(record.modalities.output ? { output: [...record.modalities.output] } : {}),
                },
            }
            : {}),
    };
}
function toModelThinkingFields(record) {
    const thinkingConfig = record.thinkingConfig;
    return {
        ...(thinkingConfig?.mode
            ? {
                thinkingConfig: {
                    mode: thinkingConfig.mode,
                    ...(thinkingConfig.default_value ? { defaultValue: thinkingConfig.default_value } : {}),
                },
            }
            : {}),
    };
}
function toModelProviderFields(record) {
    return {
        providerName: record.providerName,
        providerSource: record.providerSource,
        providerKind: record.providerKind,
        ...(record.status ? { status: toModelStatus(record.status) } : {}),
    };
}
export function toModelStatus(status) {
    return {
        state: status.state,
        ...(status.lastTestedAt !== undefined ? { lastTestedAt: status.lastTestedAt } : {}),
        ...(status.lastErrorCode ? { lastErrorCode: status.lastErrorCode } : {}),
        ...(status.lastErrorMessage ? { lastErrorMessage: status.lastErrorMessage } : {}),
    };
}
export function toProviderInfo(view) {
    return {
        providerId: view.providerId,
        name: view.name,
        source: view.source,
        kind: view.kind,
        enabled: view.enabled,
        ...(view.baseUrl ? { baseUrl: view.baseUrl } : {}),
        ...(view.apiFormat ? { apiFormat: view.apiFormat } : {}),
        hasApiKey: view.hasApiKey,
        ...(view.maskedApiKey ? { maskedApiKey: view.maskedApiKey } : {}),
        ...(view.headerNames ? { headerNames: view.headerNames } : {}),
        ...(view.configRevision ? { configRevision: view.configRevision } : {}),
        models: view.models.map(toModelInfo),
        ...(view.status ? { status: toModelStatus(view.status) } : {}),
    };
}
export function toCandidateView(candidate) {
    return {
        ...(candidate.providerId !== undefined ? { providerId: candidate.providerId } : {}),
        ...(candidate.expectedRevision !== undefined
            ? { expectedRevision: candidate.expectedRevision }
            : {}),
        ...(candidate.name !== undefined ? { name: candidate.name } : {}),
        baseUrl: candidate.baseUrl,
        ...(candidate.apiKey !== undefined ? { apiKey: candidate.apiKey } : {}),
        ...(candidate.apiFormat !== undefined ? { apiFormat: candidate.apiFormat } : {}),
        ...(candidate.models ? { models: candidate.models.map(toModelInputView) } : {}),
        ...(candidate.headers !== undefined ? { headers: candidate.headers } : {}),
        ...(candidate.removeHeaders !== undefined ? { removeHeaders: candidate.removeHeaders } : {}),
    };
}
export function toModelInputView(model) {
    return {
        modelId: model.modelId,
        ...toModelInputIdentityFields(model),
        ...toModelInputCapabilityFields(model),
        ...toModelInputStructuredFields(model),
        ...toModelInputThinkingFields(model),
    };
}
function toUserModelInput(model) {
    return {
        modelId: model.modelId,
        ...toUserModelInputIdentityFields(model),
        ...toUserModelInputCapabilityFields(model),
        ...toUserModelInputStructuredFields(model),
        ...toUserModelInputThinkingFields(model),
    };
}
export function toByokPresetModelInput(model) {
    const mapped = toUserModelInput(model);
    delete mapped.configurationSource;
    return mapped;
}
function toUserModelInputIdentityFields(model) {
    return {
        ...(model.displayName !== undefined ? { displayName: model.displayName } : {}),
        ...(model.configurationSource !== undefined
            ? { configurationSource: model.configurationSource }
            : {}),
        ...(model.enabled !== undefined ? { enabled: model.enabled } : {}),
    };
}
function toUserModelInputCapabilityFields(model) {
    return {
        ...(model.attachment !== undefined ? { attachment: model.attachment } : {}),
        ...(model.reasoning !== undefined ? { reasoning: model.reasoning } : {}),
        ...(model.toolCall !== undefined ? { toolCall: model.toolCall } : {}),
        ...(model.temperature !== undefined ? { temperature: model.temperature } : {}),
    };
}
function toUserModelInputStructuredFields(model) {
    return {
        ...(model.modalities
            ? {
                modalities: {
                    ...(model.modalities.input ? { input: [...model.modalities.input] } : {}),
                    ...(model.modalities.output ? { output: [...model.modalities.output] } : {}),
                },
            }
            : {}),
        ...(model.limit
            ? {
                limit: {
                    ...(model.limit.context !== undefined ? { context: model.limit.context } : {}),
                    ...(model.limit.output !== undefined ? { output: model.limit.output } : {}),
                },
            }
            : {}),
    };
}
function toUserModelInputThinkingFields(model) {
    return {
        ...(model.thinkingConfig
            ? {
                thinkingConfig: {
                    ...(model.thinkingConfig.mode !== undefined ? { mode: model.thinkingConfig.mode } : {}),
                    ...(model.thinkingConfig.defaultValue !== undefined
                        ? { defaultValue: model.thinkingConfig.defaultValue }
                        : {}),
                },
            }
            : {}),
        ...(model.effortOptions !== undefined ? { effortOptions: [...model.effortOptions] } : {}),
    };
}
function toModelInputIdentityFields(model) {
    return {
        ...(model.displayName !== undefined ? { displayName: model.displayName } : {}),
        ...(model.configurationSource !== undefined
            ? { configurationSource: model.configurationSource }
            : {}),
        ...(model.enabled !== undefined ? { enabled: model.enabled } : {}),
    };
}
function toModelInputCapabilityFields(model) {
    return {
        ...(model.attachment !== undefined ? { attachment: model.attachment } : {}),
        ...(model.reasoning !== undefined ? { reasoning: model.reasoning } : {}),
        ...(model.toolCall !== undefined ? { toolCall: model.toolCall } : {}),
        ...(model.temperature !== undefined ? { temperature: model.temperature } : {}),
    };
}
function toModelInputStructuredFields(model) {
    return {
        ...(model.modalities
            ? {
                modalities: {
                    ...(model.modalities.input ? { input: model.modalities.input } : {}),
                    ...(model.modalities.output ? { output: model.modalities.output } : {}),
                },
            }
            : {}),
        ...(model.limit
            ? {
                limit: {
                    ...(model.limit.context !== undefined ? { context: model.limit.context } : {}),
                    ...(model.limit.output !== undefined ? { output: model.limit.output } : {}),
                },
            }
            : {}),
    };
}
function toModelInputThinkingFields(model) {
    return {
        ...(model.thinkingConfig?.mode
            ? {
                thinkingConfig: {
                    mode: model.thinkingConfig.mode,
                    ...(model.thinkingConfig.defaultValue
                        ? { defaultValue: model.thinkingConfig.defaultValue }
                        : {}),
                },
            }
            : {}),
        ...(model.effortOptions !== undefined ? { effortOptions: model.effortOptions } : {}),
    };
}
//# sourceMappingURL=model-provider-mappers.js.map