import { dialogReviewBlocks } from '@mavis/shared/local-runtime-safety';
import { createHash } from 'node:crypto';
/** Any review without a pass blocks, an unavailable review included. */
export function inputReviewDisposition(result) {
    if (result.action === 'replace' && result.suggestion?.trim()) {
        return { kind: 'replace', replacement: result.suggestion };
    }
    if (result.action === 'guide') {
        const guidance = result.guide_prompt?.trim();
        return guidance ? { kind: 'proceed', guidance } : { kind: 'proceed' };
    }
    return dialogReviewBlocks(result) ? { kind: 'block' } : { kind: 'proceed' };
}
/** Review can be regenerated and a valid fixed answer can be delivered without the model. */
export function reviewBlocksInput(result) {
    return inputReviewDisposition(result).kind === 'block';
}
export function digestSafetyInput(input) {
    const serialized = JSON.stringify(canonicalValue(input)) ?? 'undefined';
    return `sha256:${createHash('sha256').update(serialized).digest('hex')}`;
}
export function isInputSafetyDecision(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return false;
    const decision = value;
    return (typeof decision.inputDigest === 'string' &&
        /^sha256:[a-f0-9]{64}$/.test(decision.inputDigest) &&
        (decision.outcome === 'approved' || decision.outcome === 'degraded') &&
        Object.keys(decision).every((key) => key === 'inputDigest' || key === 'outcome'));
}
export function isInputSafetyDecisionFor(decision, inputDigest) {
    return isInputSafetyDecision(decision) && decision.inputDigest === inputDigest;
}
function canonicalValue(value) {
    if (Array.isArray(value))
        return value.map(canonicalValue);
    if (!value || typeof value !== 'object')
        return value;
    return Object.fromEntries(Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalValue(entry)]));
}
//# sourceMappingURL=input-safety.js.map