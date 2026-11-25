// ── Bunny beta switch (config.yaml `bunny`) ──────────────────────
export function parseBunnyConfig(raw) {
    const value = raw.bunny;
    const record = value != null && typeof value === 'object' && !Array.isArray(value)
        ? value
        : {};
    const memory = record.memory;
    const memoryRecord = memory != null && typeof memory === 'object' && !Array.isArray(memory)
        ? memory
        : {};
    // "Never chose" stays distinct from an explicit `false`, as for prompt
    // suggestion: the effective default depends on the remote policy.
    return {
        ...(typeof record.enabled === 'boolean' ? { enabled: record.enabled } : {}),
        // Only an explicit `true` turns Bunny memory on; a missing or malformed value reads as off.
        ...(typeof memoryRecord.enabled === 'boolean'
            ? { memory: { enabled: memoryRecord.enabled } }
            : {}),
        ...(typeof record.helperAgents === 'boolean' ? { helperAgents: record.helperAgents } : {}),
        ...(typeof record.verdictGate === 'boolean' ? { verdictGate: record.verdictGate } : {}),
    };
}
//# sourceMappingURL=bunny-local-config.js.map