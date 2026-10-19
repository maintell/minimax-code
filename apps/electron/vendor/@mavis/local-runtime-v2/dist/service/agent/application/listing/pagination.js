/** Applies offset/limit after failed profile renders have been removed. */
export function paginateSettledViews(details, rawOffset, limit) {
    let offset = Math.max(0, rawOffset ?? 0);
    const views = [];
    for (const detail of details) {
        if (detail.status === 'rejected')
            continue;
        if (offset > 0) {
            offset -= 1;
            continue;
        }
        views.push(detail.value);
        if (limit !== undefined && views.length >= limit)
            break;
    }
    return views;
}
//# sourceMappingURL=pagination.js.map