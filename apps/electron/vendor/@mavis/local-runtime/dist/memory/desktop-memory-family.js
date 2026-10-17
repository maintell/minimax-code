import { LocalMemoryError } from './types.js';
import { emitResourceAmbiguityTelemetry, } from '../agent/subagent-telemetry.js';
export function selectMainMemoryResource(candidates, canonicalName, telemetryHost) {
    const canonical = candidates.find(({ sourceAgent }) => sourceAgent === canonicalName);
    const canonicalHasContent = canonical?.value.content.trim().length;
    if (canonical && canonicalHasContent)
        return canonical;
    const compatibleWithContent = candidates.filter(({ sourceAgent, value }) => sourceAgent !== canonicalName && value.content.trim().length > 0);
    const soleCompatibleWithContent = compatibleWithContent[0];
    if (compatibleWithContent.length === 1 && soleCompatibleWithContent) {
        return soleCompatibleWithContent;
    }
    if (compatibleWithContent.length > 1) {
        throwAmbiguousMemory('main', compatibleWithContent.map(({ sourceAgent }) => sourceAgent), telemetryHost);
    }
    if (canonical?.value.updatedAt !== undefined)
        return canonical;
    const existing = candidates.find(({ value }) => value.updatedAt !== undefined);
    if (existing)
        return existing;
    if (canonical)
        return canonical;
    if (candidates[0])
        return candidates[0];
    throw new LocalMemoryError('MEMORY_SOURCE_UNAVAILABLE', 'memory source unavailable');
}
export class AmbiguousAgentMemoryError extends LocalMemoryError {
    resource;
    sourceNames;
    constructor(resource, sourceNames) {
        super('AMBIGUOUS_AGENT_RESOURCE', `Memory ${resource} is ambiguous across sources: ${sourceNames.join(', ')}`);
        this.resource = resource;
        this.sourceNames = sourceNames;
    }
}
export function readMemorySources(sourceNames, read) {
    return Promise.all(sourceNames.map(async (sourceAgent) => ({
        sourceAgent,
        value: await read(sourceAgent),
    })));
}
export function selectMemorySource(candidates, canonicalName, resource, telemetryHost) {
    const canonical = candidates.find(({ sourceAgent }) => sourceAgent === canonicalName);
    if (canonical)
        return canonical;
    if (candidates.length <= 1)
        return candidates[0];
    throwAmbiguousMemory(resource, candidates.map(({ sourceAgent }) => sourceAgent), telemetryHost);
}
export function mergeMemorySources(candidates, canonicalName, keyOf, resource, telemetryHost) {
    const merged = new Map();
    for (const candidate of candidates) {
        const key = keyOf(candidate.value);
        const current = merged.get(key);
        if (!current) {
            merged.set(key, candidate);
            continue;
        }
        if (current.sourceAgent === candidate.sourceAgent)
            continue;
        if (current.sourceAgent === canonicalName)
            continue;
        if (candidate.sourceAgent === canonicalName) {
            merged.set(key, candidate);
            continue;
        }
        throwAmbiguousMemory(`${resource}:${key}`, [current.sourceAgent, candidate.sourceAgent], telemetryHost);
    }
    return [...merged.values()];
}
export function throwAmbiguousMemory(resource, sourceNames, telemetryHost) {
    emitResourceAmbiguityTelemetry(telemetryHost, 'memory', new Set(sourceNames).size);
    throw new AmbiguousAgentMemoryError(resource, [...new Set(sourceNames)]);
}
export function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=desktop-memory-family.js.map