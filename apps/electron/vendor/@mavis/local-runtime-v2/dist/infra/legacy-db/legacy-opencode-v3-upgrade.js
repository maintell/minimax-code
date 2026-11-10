export function detectPostPiCompactionReplacement(rows, legacyRowsNow) {
    if (legacyRowsNow === 0)
        return 'all-rows-after-watermark';
    const first = rows[0];
    if (!first)
        return undefined;
    if (hasArchonCompactionMarker(first))
        return 'archon-compaction-marker';
    if (hasLegacyCompactionSummary(first))
        return 'legacy-compaction-summary';
    return undefined;
}
function hasArchonCompactionMarker(message) {
    const marker = message.archonCompaction;
    if (!marker || typeof marker !== 'object')
        return false;
    const summary = marker.summary;
    return typeof summary === 'string';
}
function hasLegacyCompactionSummary(message) {
    const candidate = message;
    return candidate.role === 'compactionSummary' && typeof candidate.summary === 'string';
}
//# sourceMappingURL=legacy-opencode-v3-upgrade.js.map