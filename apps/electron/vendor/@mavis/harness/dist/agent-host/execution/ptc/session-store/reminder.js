/** Longest description shown in the reminder; the rest is cut with an ellipsis. */
const REMINDER_DESC_CHARS = 100;
/**
 * The `PTC stored values:` block the compaction reminder carries: one line per
 * key with its JSON type, encoded size and description, so a compacted
 * conversation still knows what it can `load`. Undefined when the Session
 * stored nothing, so the reminder is left exactly as it was.
 */
export function ptcStoredValuesBlock(entries) {
    if (entries.length === 0)
        return undefined;
    return [
        'PTC stored values:',
        ...entries.map((entry) => `- ${entry.key}: ${entry.type}, ${formatBytes(entry.bytes)}${entry.desc === undefined ? '' : `, ${truncateDesc(entry.desc)}`}`),
    ].join('\n');
}
function truncateDesc(desc) {
    const flat = desc.replace(/[\u0000-\u001f\u2028\u2029]/g, ' ').trim();
    return flat.length > REMINDER_DESC_CHARS
        ? `${Array.from(flat).slice(0, REMINDER_DESC_CHARS).join('')}…`
        : flat;
}
function formatBytes(bytes) {
    const mib = bytes / (1024 * 1024);
    if (mib >= 1)
        return `${round(mib)} MiB`;
    const kib = bytes / 1024;
    return kib >= 1 ? `${round(kib)} KiB` : `${bytes} B`;
}
function round(value) {
    return value >= 10 ? String(Math.round(value)) : String(Math.round(value * 10) / 10);
}
//# sourceMappingURL=reminder.js.map