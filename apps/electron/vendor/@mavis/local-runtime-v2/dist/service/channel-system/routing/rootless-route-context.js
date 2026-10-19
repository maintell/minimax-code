/**
 * Migration copy (MR1) of v1 `channels/rootless-route-context.ts`.
 */
import { createHash } from 'node:crypto';
export function buildScopeKey(preview, ctx) {
    return stableDigest([
        preview.exactOwnerName,
        preview.ownerInstanceId ?? '',
        preview.projectKey,
        preview.routingMode,
        ctx.platform,
        ctx.clientName,
        semanticScope(preview.routingMode, ctx, preview.sessionTitle),
    ]);
}
export function buildSessionPurpose(input) {
    return `channel:v2:${stableDigest([
        input.exactOwnerName,
        input.ownerInstanceId ?? '',
        input.projectKey,
        input.routingMode,
        input.ctx.platform,
        input.ctx.clientName,
        semanticScope(input.routingMode, input.ctx, input.sessionTitle),
        String(input.generation),
    ])}`;
}
export function buildSessionTitle(ctx, strategy) {
    if (strategy === 'per-sender')
        return `${ctx.platform}-sender`;
    if (strategy === 'per-chat')
        return `${ctx.platform}-chat`;
    return `${ctx.platform}-channel`;
}
export function contextForBinding(binding) {
    return {
        platform: binding.platform,
        chatType: '*',
        chatId: binding.chatId,
        senderId: binding.senderId,
        clientName: binding.clientName,
        ...(binding.threadId ? { threadId: binding.threadId } : {}),
        lane: binding.lane,
    };
}
export function strategyForRoutingMode(mode) {
    return mode === 'project-main' ? 'root' : mode;
}
function semanticScope(routingMode, ctx, sessionTitle) {
    if (routingMode === 'per-sender')
        return ctx.senderId;
    if (routingMode === 'per-chat')
        return ctx.chatId;
    if (routingMode === 'project-main')
        return 'project-main';
    return sessionTitle || ctx.chatId;
}
function stableDigest(parts) {
    return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}
//# sourceMappingURL=rootless-route-context.js.map