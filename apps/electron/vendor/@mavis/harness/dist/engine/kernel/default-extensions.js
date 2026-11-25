import { outputLimitRecoveryExtension, } from '@mavis/agent-extension/output-limit-recovery';
import { requestMediaExtension } from '@mavis/agent-extension/request-media';
import { toolOutputBudgetExtension, } from '@mavis/agent-extension/tool-output-budget';
import { TOOL_RESULT_COMPACTION_DEFAULTS } from '@mavis/config';
const DEFAULT_MAX_INLINE_BYTES = TOOL_RESULT_COMPACTION_DEFAULTS.maxInlineKiB * 1_024;
const FALLBACK_PREVIEW_BYTES = 2 * 1_024;
/**
 * The Host's normal-turn extensions followed by the harness defaults: output-limit
 * recovery, request media and the tool-output budget. The defaults observe every Host
 * after_tool_call rewrite and establish terminal postconditions, so a Host extension
 * with a default's id is dropped instead of replacing it.
 */
export function withDefaultExtensions(hostExtensions, dependencies, runs) {
    const logger = dependencies.observability?.logger;
    const defaults = [
        createOutputLimitRecovery(logger),
        requestMediaExtension({ getImageEncoding: dependencies.policy.getImageEncoding }),
        createToolOutputBudget(dependencies, runs, logger),
    ];
    const defaultIds = new Set(defaults.map((extension) => extension.id));
    return [...hostExtensions.filter((extension) => !defaultIds.has(extension.id)), ...defaults];
}
function createOutputLimitRecovery(logger) {
    const log = (outcome) => (observation) => {
        logger?.[outcome === 'exhausted' ? 'error' : 'info']?.({
            event: 'output_limit_recovery',
            outcome,
            session_id: observation.sessionId,
            turn_id: observation.turnId,
            attempts: observation.attempts,
            ...(observation.truncatedToolCall === undefined
                ? {}
                : { truncated_tool_call: observation.truncatedToolCall }),
            ...(observation.model === undefined ? {} : { model: observation.model }),
        }, '[harness] Output limit recovery');
    };
    return outputLimitRecoveryExtension({
        onRetry: log('retry'),
        onRecovered: log('recovered'),
        onExhausted: log('exhausted'),
    });
}
/** Artifacts come from the scope of the run owning the Turn; without one the preview stays. */
function createToolOutputBudget(dependencies, runs, logger) {
    const maxInlineBytes = () => readMaxInlineBytes(dependencies.compaction.toolResults);
    return toolOutputBudgetExtension({
        maxInlineBytes: DEFAULT_MAX_INLINE_BYTES,
        getMaxInlineBytes: () => dependencies.compaction.toolResults()?.maxInlineBytes,
        fallbackPreviewBytes: FALLBACK_PREVIEW_BYTES,
        writeArtifact: async (input) => {
            const scope = runs.scope(input);
            if (!scope)
                throw new Error(`No active run owns Turn ${input.turnId}.`);
            const artifact = await scope.artifacts.write(input);
            logToolOutputBudgetDecision(logger, {
                input,
                maxInlineBytes: maxInlineBytes(),
                outcome: 'externalized',
                artifactReadFormat: artifact.metadata?.read_format,
            });
            return artifact;
        },
        onArtifactError: (error, input) => logToolOutputBudgetDecision(logger, {
            input,
            maxInlineBytes: maxInlineBytes(),
            outcome: 'fallback',
            reason: safeErrorReason(error),
        }),
    });
}
function readMaxInlineBytes(getConfig) {
    try {
        const value = getConfig()?.maxInlineBytes;
        return value !== undefined && Number.isSafeInteger(value) && value > 0
            ? value
            : DEFAULT_MAX_INLINE_BYTES;
    }
    catch {
        return DEFAULT_MAX_INLINE_BYTES;
    }
}
function logToolOutputBudgetDecision(logger, decision) {
    try {
        const { input, maxInlineBytes, outcome, artifactReadFormat, reason } = decision;
        const fields = {
            event: 'tool_output_budget_decision',
            session_id: input.sessionId,
            turn_id: input.turnId,
            tool_name: input.toolName,
            outcome,
            original_bytes: input.originalBytes,
            max_inline_bytes: maxInlineBytes,
            ...(typeof artifactReadFormat === 'string' && artifactReadFormat.trim()
                ? { artifact_read_format: artifactReadFormat.trim() }
                : {}),
            ...(reason ? { reason } : {}),
        };
        logger?.[outcome === 'fallback' ? 'error' : 'info']?.(fields, '[harness] Tool output budget');
    }
    catch {
        // Diagnostics must not change the ToolResult returned to History.
    }
}
function safeErrorReason(error) {
    if (isRecord(error) && typeof error.code === 'string' && error.code.trim()) {
        return error.code.trim();
    }
    return error instanceof Error && error.name.trim() ? error.name.trim() : 'unknown_error';
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=default-extensions.js.map