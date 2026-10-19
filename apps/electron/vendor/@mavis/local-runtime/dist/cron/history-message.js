/** Convert a cron trigger into the display-message metadata stored with its session turn. */
export function buildCronHistoryMessage(msg) {
    const rawMeta = readCronRawMeta(msg.inboundContext);
    return {
        content: msg.content,
        ...(msg.source ? { source: msg.source } : {}),
        ...(rawMeta ? { origin: { rawMeta } } : {}),
    };
}
function readCronRawMeta(inboundContext) {
    if (!inboundContext || typeof inboundContext !== 'object')
        return undefined;
    const ctx = inboundContext;
    const rawMeta = {};
    if (typeof ctx.cronName === 'string' && ctx.cronName.length > 0) {
        rawMeta.cronName = ctx.cronName;
    }
    if (typeof ctx.cronSchedule === 'string' && ctx.cronSchedule.length > 0) {
        rawMeta.cronSchedule = ctx.cronSchedule;
    }
    return Object.keys(rawMeta).length > 0 ? rawMeta : undefined;
}
//# sourceMappingURL=history-message.js.map