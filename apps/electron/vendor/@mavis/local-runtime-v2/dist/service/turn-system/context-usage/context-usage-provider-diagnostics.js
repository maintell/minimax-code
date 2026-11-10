import { validPromptRanges } from './context-usage-validation.js';
const DIAGNOSTIC_ORDER = [
    'OTHER',
    'SYSTEM_PROMPT',
    'MEMORY',
    'SKILLS',
    'TOOLS',
    'MESSAGES',
];
const PRODUCT_ORDER = [
    'SYSTEM_PROMPT',
    'MEMORY',
    'TOOLS',
    'SKILLS',
    'MESSAGES',
    'OTHER',
];
const BASELINE_MESSAGE = {
    role: 'user',
    content: [{ type: 'text', text: '.' }],
    timestamp: 0,
};
/**
 * Dev-only accounting experiment. Six cumulative Provider counts telescope to
 * the full payload. This is a deterministic diagnostic convention, not a
 * Provider-native semantic classification, and never feeds product state.
 */
export async function buildContextUsageProviderDiagnostics(input) {
    if (!isValidDiagnosticContext(input))
        return emptyDiagnostics('INVALID_CONTEXT');
    try {
        return await buildDiagnosticsResult(input);
    }
    catch (error) {
        return {
            ...emptyDiagnostics('FAILED'),
            error: error instanceof Error ? error.message : String(error),
        };
    }
}
function isValidDiagnosticContext(input) {
    const systemPrompt = input.context.systemPrompt ?? '';
    return input.prepared.valid && validPromptRanges(systemPrompt, input.promptRanges);
}
async function buildDiagnosticsResult(input) {
    const stages = buildStages(input.context, input.promptRanges);
    const { counts, reconstructedFull, supportsExactProviderPayload } = await countStages(input, stages);
    const components = buildDiagnosticComponents(input.prepared, stages, counts);
    const fullCount = counts.at(-1);
    if (!fullCount)
        throw new Error('Provider diagnostics produced no stages');
    return buildDiagnosticResult({
        input,
        counts,
        reconstructedFull,
        supportsExactProviderPayload,
        components,
        providerFullTokens: fullCount.result.tokens,
    });
}
function buildDiagnosticResult(input) {
    const { input: diagnosticInput, counts, reconstructedFull, supportsExactProviderPayload, components, providerFullTokens, } = input;
    return {
        status: resolveDiagnosticStatus(counts, reconstructedFull),
        method: 'ORDERED_INCREMENTAL',
        fullCountBasis: supportsExactProviderPayload
            ? 'EXACT_PROVIDER_PAYLOAD'
            : 'RECONSTRUCTED_CONTEXT',
        order: [...DIAGNOSTIC_ORDER],
        providerFullTokens,
        providerFullVsInputAnchorTokens: resolveAnchorDelta(diagnosticInput.providerInputAnchor, providerFullTokens),
        reconstructedFullTokens: reconstructedFull?.result.tokens ?? null,
        reconstructedFullVsExactTokens: resolveReconstructedDelta(reconstructedFull, providerFullTokens),
        rawPreparedMinusProviderTokens: diagnosticInput.prepared.usedTokens - providerFullTokens,
        closureTokens: components.reduce((total, component) => total + component.providerTokens, 0) -
            providerFullTokens,
        components,
    };
}
function resolveDiagnosticStatus(counts, reconstructedFull) {
    return counts.every((count) => count.result.source === 'remote') &&
        (!reconstructedFull || reconstructedFull.result.source === 'remote')
        ? 'REMOTE'
        : 'FALLBACK_ESTIMATE';
}
function resolveAnchorDelta(anchor, tokens) {
    return anchor === undefined ? null : tokens - anchor;
}
function resolveReconstructedDelta(reconstructedFull, providerFullTokens) {
    return reconstructedFull ? reconstructedFull.result.tokens - providerFullTokens : null;
}
async function countStages(input, stages) {
    const counts = [];
    let reconstructedFullContext;
    const supportsExactProviderPayload = input.model.api === 'anthropic-messages' && input.exactProviderPayload !== undefined;
    for (const [index, stage] of stages.entries()) {
        const reconstructedContext = buildRemoteCountContext(input, stage);
        if (index === stages.length - 1)
            reconstructedFullContext = reconstructedContext;
        const countContext = index === stages.length - 1 && supportsExactProviderPayload
            ? { ...reconstructedContext, exactProviderPayload: input.exactProviderPayload }
            : reconstructedContext;
        counts.push(await countDiagnosticStage(input.counter, countContext));
    }
    const reconstructedFull = supportsExactProviderPayload &&
        input.includeReconstructedFullComparison !== false &&
        reconstructedFullContext
        ? await countDiagnosticStage(input.counter, reconstructedFullContext)
        : undefined;
    return { counts, reconstructedFull, supportsExactProviderPayload };
}
function stageNotes(stage, prefix) {
    return {
        fallback: stage?.result.source === 'estimate'
            ? [`${prefix}:${stage.result.fallbackReason ?? 'unknown'}`]
            : [],
        recovered: stage?.retryRecovered ? [`${prefix}:${stage.retryRecovered}`] : [],
    };
}
function buildDiagnosticComponents(prepared, stages, counts) {
    const rawByKind = new Map(prepared.components.map((component) => [component.kind, component.tokens]));
    const orderedComponents = stages.map((stage, index) => {
        const currentStage = counts[index];
        if (!currentStage)
            throw new Error(`Missing Provider diagnostic stage ${stage.kind}`);
        const previousStage = index === 0 ? undefined : counts[index - 1];
        const providerTokens = currentStage.result.tokens - (previousStage?.result.tokens ?? 0);
        const rawPreparedTokens = rawByKind.get(stage.kind) ?? 0;
        const currentNotes = stageNotes(currentStage, 'current');
        const previousNotes = stageNotes(previousStage, 'previous');
        const fallbackReasons = [...currentNotes.fallback, ...previousNotes.fallback];
        const retryRecovered = [...currentNotes.recovered, ...previousNotes.recovered];
        return {
            kind: stage.kind,
            providerTokens,
            rawPreparedTokens,
            estimatorMinusProviderTokens: rawPreparedTokens - providerTokens,
            source: fallbackReasons.length === 0 ? 'remote' : 'estimate',
            ...(fallbackReasons.length > 0 ? { fallbackReason: fallbackReasons.join(',') } : {}),
            ...(retryRecovered.length > 0 ? { retryRecovered: retryRecovered.join(',') } : {}),
        };
    });
    return PRODUCT_ORDER.map((kind) => {
        const component = orderedComponents.find((candidate) => candidate.kind === kind);
        if (!component)
            throw new Error(`Missing Provider diagnostic component ${kind}`);
        return component;
    });
}
function buildRemoteCountContext(input, stage) {
    return {
        messages: stage.messages,
        model: input.model,
        ...(input.streamOptions?.apiKey ? { apiKey: input.streamOptions.apiKey } : {}),
        ...(input.streamOptions?.headers ? { headers: input.streamOptions.headers } : {}),
        ...(stage.systemPrompt ? { systemPrompt: stage.systemPrompt } : {}),
        ...(stage.tools ? { tools: stage.tools } : {}),
        ...(input.streamOptions?.maxTokens !== undefined
            ? { maxTokens: input.streamOptions.maxTokens }
            : {}),
        ...(input.streamOptions?.cacheRetention
            ? { cacheRetention: input.streamOptions.cacheRetention }
            : {}),
        ...(input.streamOptions?.reasoning ? { thinkingLevel: input.streamOptions.reasoning } : {}),
        // Intentionally omit the generation AbortSignal: diagnostics start after
        // terminal and must remain a detached, non-blocking sidecar.
    };
}
function emptyDiagnostics(status) {
    return {
        status,
        method: 'ORDERED_INCREMENTAL',
        fullCountBasis: 'RECONSTRUCTED_CONTEXT',
        order: [...DIAGNOSTIC_ORDER],
        providerFullTokens: null,
        providerFullVsInputAnchorTokens: null,
        reconstructedFullTokens: null,
        reconstructedFullVsExactTokens: null,
        rawPreparedMinusProviderTokens: null,
        closureTokens: null,
        components: [],
    };
}
async function countDiagnosticStage(counter, context) {
    const initial = await counter.countContextTokens(context);
    if (initial.source !== 'estimate' || initial.fallbackReason !== 'malformed_body') {
        return { result: initial };
    }
    const retry = await counter.countContextTokens(context);
    return {
        result: retry,
        ...(retry.source === 'remote' ? { retryRecovered: initial.fallbackReason } : {}),
    };
}
function buildStages(context, ranges) {
    const fullSystemPrompt = context.systemPrompt ?? '';
    const otherPrompt = buildPromptSubset(fullSystemPrompt, ranges, new Set(['OTHER']));
    const systemPrompt = buildPromptSubset(fullSystemPrompt, ranges, new Set(['OTHER', 'SYSTEM_PROMPT']));
    const withMemory = buildPromptSubset(fullSystemPrompt, ranges, new Set(['OTHER', 'SYSTEM_PROMPT', 'MEMORY']));
    const withSkills = buildPromptSubset(fullSystemPrompt, ranges, new Set(['OTHER', 'SYSTEM_PROMPT', 'MEMORY', 'SKILLS']));
    return [
        buildPromptStage('OTHER', otherPrompt),
        buildPromptStage('SYSTEM_PROMPT', systemPrompt),
        buildPromptStage('MEMORY', withMemory),
        buildPromptStage('SKILLS', withSkills),
        {
            kind: 'TOOLS',
            ...(fullSystemPrompt ? { systemPrompt: fullSystemPrompt } : {}),
            tools: [...(context.tools ?? [])],
            messages: [BASELINE_MESSAGE],
        },
        {
            kind: 'MESSAGES',
            ...(fullSystemPrompt ? { systemPrompt: fullSystemPrompt } : {}),
            tools: [...(context.tools ?? [])],
            messages: [...(context.messages ?? [])],
        },
    ];
}
function buildPromptStage(kind, systemPrompt) {
    return { kind, ...(systemPrompt ? { systemPrompt } : {}), messages: [BASELINE_MESSAGE] };
}
function buildPromptSubset(systemPrompt, ranges, selected) {
    let previousEnd = 0;
    const chunks = [];
    for (const range of ranges) {
        if (selected.has('SYSTEM_PROMPT'))
            chunks.push(systemPrompt.slice(previousEnd, range.startOffset));
        if (selected.has(range.kind))
            chunks.push(systemPrompt.slice(range.startOffset, range.endOffset));
        previousEnd = range.endOffset;
    }
    if (selected.has('SYSTEM_PROMPT'))
        chunks.push(systemPrompt.slice(previousEnd));
    return chunks.join('');
}
//# sourceMappingURL=context-usage-provider-diagnostics.js.map