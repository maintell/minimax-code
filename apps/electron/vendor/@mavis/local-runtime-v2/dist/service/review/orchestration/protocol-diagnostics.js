import { createHash } from 'node:crypto';
export function inspectReviewProtocolOutput(input) {
    const text = input.message.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('');
    if (!text)
        return undefined;
    const markerPatterns = [
        ['annotation-result', /<annotation-result\b/iu],
        ['review-candidate-corrections', /<review-candidate-corrections\b/iu],
        ['review-candidates', /<review-candidates\b/iu],
    ];
    const markers = markerPatterns
        .filter(([, pattern]) => pattern.test(text))
        .map(([marker]) => marker);
    return markers.length > 0 ? { text, markers } : undefined;
}
export function recordReviewProjectionBypass(input) {
    const prepared = input.state?.prepared;
    const responseLimit = 1024 * 1024;
    const responseText = input.protocolOutput.text.slice(0, responseLimit);
    input.logger.warn({
        event: 'code_review_projection_bypassed',
        reason_code: input.reasonCode,
        session_id: input.identity.sessionId,
        turn_id: input.identity.turnId,
        ...(input.state ? { phase: input.state.phase } : {}),
        ...(prepared
            ? {
                review_run_id: prepared.context.reviewRunId,
                trigger: prepared.trigger,
                mode: prepared.mode,
            }
            : {}),
        protocol_markers: input.protocolOutput.markers,
        response_length: input.protocolOutput.text.length,
        response_sha256: createHash('sha256').update(input.protocolOutput.text).digest('hex'),
        response_text: responseText,
        response_truncated: responseText.length !== input.protocolOutput.text.length,
        ...(input.model ? { model: input.model } : {}),
    }, 'Code review protocol output bypassed projection');
}
//# sourceMappingURL=protocol-diagnostics.js.map