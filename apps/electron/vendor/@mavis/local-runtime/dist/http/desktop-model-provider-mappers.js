export function toModelInfo(entry) {
    const record = entry;
    const thinkingConfig = record.thinkingConfig;
    return {
        providerId: String(record.providerId ?? ''),
        modelId: String(record.modelId ?? ''),
        ...(record.displayName !== undefined ? { displayName: String(record.displayName) } : {}),
        ...(record.configurationSource === 'manual' || record.configurationSource === 'discovered'
            ? { configurationSource: record.configurationSource }
            : {}),
        ...(record.enabled !== undefined ? { enabled: Boolean(record.enabled) } : {}),
        ...(record.selected !== undefined ? { selected: Boolean(record.selected) } : {}),
        ...(typeof record.variant === 'string' ? { variant: record.variant } : {}),
        ...(Array.isArray(record.supportedVariants)
            ? { supportedVariants: record.supportedVariants }
            : {}),
        ...(typeof record.contextLimit === 'number' ? { contextLimit: record.contextLimit } : {}),
        ...(Array.isArray(record.contextWindowOptions)
            ? { contextWindowOptions: record.contextWindowOptions }
            : {}),
        ...(record.contextWindowOptionHints
            ? { contextWindowOptionHints: { ...record.contextWindowOptionHints } }
            : {}),
        ...(typeof record.modelConfigId === 'string' ? { modelConfigId: record.modelConfigId } : {}),
        ...(Array.isArray(record.effortOptions)
            ? { effortOptions: record.effortOptions }
            : {}),
        ...(typeof record.defaultEffort === 'string' ? { defaultEffort: record.defaultEffort } : {}),
        ...(record.modalities
            ? {
                modalities: {
                    ...(record.modalities.input ? { input: [...record.modalities.input] } : {}),
                    ...(record.modalities.output ? { output: [...record.modalities.output] } : {}),
                },
            }
            : {}),
        ...(typeof record.maxOutputTokens === 'number'
            ? { maxOutputTokens: record.maxOutputTokens }
            : {}),
        ...(thinkingConfig?.mode
            ? {
                thinkingConfig: {
                    mode: thinkingConfig.mode,
                    ...(thinkingConfig.default_value ? { defaultValue: thinkingConfig.default_value } : {}),
                },
            }
            : {}),
        ...(typeof record.providerName === 'string' ? { providerName: record.providerName } : {}),
        ...(typeof record.providerSource === 'string' ? { providerSource: record.providerSource } : {}),
        ...(typeof record.providerKind === 'string' ? { providerKind: record.providerKind } : {}),
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
        ...(model.displayName !== undefined ? { displayName: model.displayName } : {}),
        ...(model.configurationSource !== undefined
            ? { configurationSource: model.configurationSource }
            : {}),
        ...(model.enabled !== undefined ? { enabled: model.enabled } : {}),
        ...(model.attachment !== undefined ? { attachment: model.attachment } : {}),
        ...(model.reasoning !== undefined ? { reasoning: model.reasoning } : {}),
        ...(model.toolCall !== undefined ? { toolCall: model.toolCall } : {}),
        ...(model.temperature !== undefined ? { temperature: model.temperature } : {}),
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
//# sourceMappingURL=desktop-model-provider-mappers.js.map