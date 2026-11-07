import { isSelfReminderId } from '@mavis/shared/cron-purpose';
const OWNER_PAGE_LIMIT = 200;
/** True iff an enabled Cron definition targets the exact existing Session. */
export function hasActiveCronSessionOwner(service, sessionId) {
    let cursor;
    let hasMore = true;
    while (hasMore) {
        const page = service.listDefinitions({
            limit: OWNER_PAGE_LIMIT,
            ...(cursor ? { cursor } : {}),
        });
        if (page.items.some((definition) => !isSelfReminderId(definition.cronId) &&
            definition.enabled &&
            definition.sessionTarget.mode === 'sessionId' &&
            definition.sessionTarget.sessionId === sessionId)) {
            return true;
        }
        hasMore = page.hasMore;
        if (!hasMore)
            return false;
        if (!page.nextCursor)
            throw new Error('Cron owner lookup returned an incomplete page cursor');
        cursor = page.nextCursor;
    }
    return false;
}
//# sourceMappingURL=automation-owner.js.map