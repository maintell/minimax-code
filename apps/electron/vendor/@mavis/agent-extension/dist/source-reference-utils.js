export function readRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? value
        : undefined;
}
export function readNonEmptyString(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
export function safeHttpUrl(value) {
    if (!value)
        return undefined;
    try {
        const url = new URL(value);
        return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : undefined;
    }
    catch {
        return undefined;
    }
}
export function escapeMarkdownLabel(value) {
    return value.replaceAll('\\', '\\\\').replaceAll('[', '\\[').replaceAll(']', '\\]');
}
export function invokedToolName(args) {
    const record = readRecord(args);
    return (readNonEmptyString(record?.tool) ??
        readNonEmptyString(record?.tool_name) ??
        readNonEmptyString(record?.toolName));
}
export function normalizeToolName(value) {
    return value
        .trim()
        .toLowerCase()
        .replace(/[\s-]+/gu, '_');
}
export function parseMcpToolName(value) {
    const match = /^mcp__(.+?)__(.+)$/u.exec(value.trim());
    const server = match?.[1]?.trim();
    const tool = match?.[2]?.trim();
    return server && tool ? { server, tool } : undefined;
}
//# sourceMappingURL=source-reference-utils.js.map