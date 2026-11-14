import { CONTEXT_USAGE_COMPONENT_KINDS, } from '@mavis/agent-core/protocol';
/** Reads the local estimate a committed compaction reports, or nothing when it is malformed. */
export function readPostCompactionContextUsage(value) {
    if (!isRecord(value))
        return undefined;
    const contextWindowTokens = readNonNegativeNumber(value.contextWindowTokens);
    const usedTokens = readNonNegativeNumber(value.usedTokens);
    if (contextWindowTokens === undefined ||
        usedTokens === undefined ||
        value.totalCountSource !== 'LOCAL_ESTIMATE') {
        return undefined;
    }
    const components = readContextUsageComponents(value.components);
    if (!components)
        return undefined;
    return {
        contextWindowTokens,
        usedTokens,
        totalCountSource: 'LOCAL_ESTIMATE',
        components,
    };
}
function readContextUsageComponents(value) {
    if (!Array.isArray(value) || value.length !== CONTEXT_USAGE_COMPONENT_KINDS.length) {
        return undefined;
    }
    const components = value.flatMap((component) => {
        if (!isRecord(component) || !isContextUsageComponentKind(component.kind))
            return [];
        const tokens = readNonNegativeNumber(component.tokens);
        return tokens === undefined ? [] : [{ kind: component.kind, tokens }];
    });
    return components.length === CONTEXT_USAGE_COMPONENT_KINDS.length &&
        new Set(components.map((component) => component.kind)).size ===
            CONTEXT_USAGE_COMPONENT_KINDS.length
        ? components
        : undefined;
}
function readNonNegativeNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}
function isContextUsageComponentKind(value) {
    return CONTEXT_USAGE_COMPONENT_KINDS.some((kind) => kind === value);
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=compaction-context-usage.js.map