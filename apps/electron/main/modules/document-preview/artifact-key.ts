import { createHash } from "node:crypto";
/**
 * Cache identity is a pure value decision.  Keeping it outside the Electron
 * artifact store lets the domain orchestrator remain usable in workers/tests
 * without loading Electron's app module.
 */
export function buildArtifactCacheKey(input) {
    if (!input || input.backendId === 'system-open') {
        throw new TypeError('system-open cannot produce a persisted artifact');
    }
    const material = [
        input.contentSha256,
        input.backendId,
        input.backendVersion,
        input.processorVersion,
    ].join('\u0000');
    return `cache_${createHash('sha256').update(material, 'utf8').digest('hex')}`;
}
