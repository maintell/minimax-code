import { reviewBlocks } from '@mavis/shared/local-runtime-safety';
import { createHash } from 'node:crypto';
import {} from './contracts.js';
/**
 * Shared safety policy service. Business owners decide when a review is
 * required; the v2 initializer owns the transport and borrowed legacy ports.
 */
export class ContentSafetyService {
    options;
    closed = false;
    closePromise;
    close() {
        this.closed = true;
        this.closePromise ??= this.options.close?.() ?? Promise.resolve();
        return this.closePromise;
    }
    constructor(options) {
        this.options = options;
    }
    review = async (content, scene) => {
        if (this.closed)
            return { pass: false, errorKind: 'local_error' };
        try {
            return await this.options.review(content, scene);
        }
        catch {
            return { pass: false, errorKind: 'local_error' };
        }
    };
    async blocks(content, scene) {
        if (!content.trim())
            return false;
        return reviewBlocks(await this.review(content, scene));
    }
}
export { reviewBlocks } from '@mavis/shared/local-runtime-safety';
/** Review can be regenerated and a valid fixed answer can be delivered without the model. */
export function reviewBlocksInput(result) {
    if (result.action === 'guide')
        return false;
    if (result.action === 'replace' && result.suggestion?.trim())
        return false;
    return reviewBlocks(result);
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
//# sourceMappingURL=content-safety.service.js.map