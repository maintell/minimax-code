import { asArray, asObject, encodeSegment, mapOptionalQueuedMessageItemView, mapQueuedMessageItemView, toQueueMessageBody, } from './desktop-session-mappers.js';
export async function listLocalQueueMessages(localApiJson, req) {
    const body = asObject(await localApiJson(`session/${encodeSegment(req.id)}/queue`));
    const items = asArray(body.items).map(mapQueuedMessageItemView);
    const pendingCount = body.pendingCount ?? body.pending_count;
    return {
        items,
        paused: body.paused === true,
        pendingCount: typeof pendingCount === 'number' ? pendingCount : items.length,
    };
}
export async function getLocalQueueItem(localApiJson, req) {
    const body = await localApiJson(`session/${encodeSegment(req.id)}/queue/${encodeSegment(req.itemId)}`);
    return { item: mapOptionalQueuedMessageItemView(body.item) };
}
export function enqueueLocalMessage(localApiJson, req) {
    return localApiJson(`session/${encodeSegment(req.id)}/queue`, {
        method: 'POST',
        body: toQueueMessageBody(req),
    });
}
export async function updateLocalQueueItem(localApiJson, req) {
    const body = await localApiJson(`session/${encodeSegment(req.id)}/queue/${encodeSegment(req.itemId)}`, {
        method: 'PATCH',
        body: toQueueMessageBody(req),
    });
    return { item: mapOptionalQueuedMessageItemView(body.item) };
}
export async function reorderLocalQueue(localApiJson, req) {
    const body = await localApiJson(`session/${encodeSegment(req.id)}/queue/reorder`, {
        method: 'POST',
        body: { itemIds: req.itemIds, item_ids: req.itemIds },
    });
    return { items: asArray(body.items).map(mapQueuedMessageItemView) };
}
export async function deleteLocalQueueItem(localApiJson, req) {
    const body = await localApiJson(`session/${encodeSegment(req.id)}/queue/${encodeSegment(req.itemId)}`, { method: 'DELETE' });
    return { item: mapOptionalQueuedMessageItemView(body.item) };
}
//# sourceMappingURL=desktop-session-queue.js.map