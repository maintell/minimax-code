import { createDesktopPtcResultProjection, projectDesktopPtcEvidenceInput } from '@mavis/agent-tools';
import { redactSecretText } from '@mavis/shared/logging/redact-log-secret';
import { sanitizeObservabilityText } from '@mavis/shared/local-runtime-diagnostics/redaction';
/**
 * Desktop run_code child projection: builtin evidence fields, source-owned
 * Bash output references and the facts the Turn collector retained.
 */
export const createNativePtcResultProjection = (collector) => createDesktopPtcResultProjection({
    projectInput: projectDesktopPtcEvidenceInput,
    projectResultRef: projectNativePtcResultRef,
    projectRetainedFacts: (projection) => collector.read(projection.childToolCallId),
});
function projectNativePtcResultRef(input) {
    if (input.source !== 'builtin' || input.toolName !== 'bash')
        return undefined;
    const details = recordValue(recordValue(input.result)?.details);
    if (!details)
        return undefined;
    const processOutput = recordValue(details.processOutput);
    // A plain LocalBashTool error may have extracted fullOutputPath from text.
    // Its source-owned process/exit facts must exist before that field is trusted.
    let path = processOutput?.rawOutputPath;
    if (typeof path !== 'string' && hasStructuredBashExit(details, processOutput)) {
        path = details.fullOutputPath;
    }
    if (typeof path !== 'string' || !path.trim())
        return undefined;
    return sanitizeObservabilityText(redactSecretText(path));
}
function hasStructuredBashExit(details, processOutput) {
    const execution = recordValue(details.execution);
    return (details.exitCode === null ||
        Number.isSafeInteger(details.exitCode) ||
        processOutput?.exitCode === null ||
        Number.isSafeInteger(processOutput?.exitCode) ||
        execution?.exitCode === null ||
        Number.isSafeInteger(execution?.exitCode));
}
function recordValue(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value
        : undefined;
}
//# sourceMappingURL=ptc-result-projection.js.map