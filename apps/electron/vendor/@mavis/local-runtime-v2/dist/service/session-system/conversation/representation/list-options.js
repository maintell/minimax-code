export { applyLocalSessionListOptions } from '../../../../infra/conversation/record-list-options.js';
export function readLocalSessionListOptions(url, opts) {
    const archivedOnly = readBooleanParam(url, 'onlyCompressed', 'only_archived');
    const includeArchived = archivedOnly || readBooleanParam(url, 'includeCompressed', 'include_archived');
    const excludePurposePrefix = readOptionalSearchParam(url, 'excludePurposePrefix');
    const includePurposePrefix = readOptionalSearchParam(url, 'includePurposePrefix');
    const search = readFirstSearchParam(url, ['keyword', 'query', 'q']);
    const cursor = readOptionalSearchParam(url, 'cursor');
    const limit = readOptionalPositiveInt(url.searchParams.get('limit'));
    const offset = readOptionalNonNegativeInt(url.searchParams.get('offset'));
    return {
        ...(opts?.agentName ? { agentName: opts.agentName } : {}),
        ...archiveOptions(archivedOnly, includeArchived),
        includeHidden: url.searchParams.get('includeHidden') === 'true' ||
            url.searchParams.get('include_hidden') === 'true',
        ...(excludePurposePrefix ? { excludePurposePrefix } : {}),
        ...(includePurposePrefix ? { includePurposePrefix } : {}),
        ...(search ? { search } : {}),
        ...(cursor ? { cursor } : {}),
        ...(limit !== undefined ? { limit } : {}),
        ...(offset !== undefined ? { offset } : {}),
    };
}
export function withoutLocalSessionPagination(options) {
    if (!options)
        return undefined;
    const rest = { ...options };
    delete rest.cursor;
    delete rest.limit;
    delete rest.offset;
    return Object.keys(rest).length > 0 ? rest : undefined;
}
function readBooleanParam(url, ...keys) {
    return keys.some((key) => url.searchParams.get(key) === 'true');
}
function readFirstSearchParam(url, keys) {
    for (const key of keys) {
        const value = readOptionalSearchParam(url, key);
        if (value)
            return value;
    }
    return undefined;
}
function archiveOptions(archivedOnly, includeArchived) {
    if (archivedOnly)
        return { archived: true };
    if (!includeArchived)
        return { archived: false };
    return {};
}
function readOptionalSearchParam(url, key) {
    const value = url.searchParams.get(key)?.trim();
    return value || undefined;
}
function readOptionalPositiveInt(value) {
    const parsed = Number.parseInt(value ?? '', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}
function readOptionalNonNegativeInt(value) {
    const parsed = Number.parseInt(value ?? '', 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}
//# sourceMappingURL=list-options.js.map