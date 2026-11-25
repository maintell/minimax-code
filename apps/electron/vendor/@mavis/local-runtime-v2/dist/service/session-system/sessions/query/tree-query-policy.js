import { sessionKindForLegacyPurposePrefix } from '../repo/drizzle/normalization.js';
export function sessionTreeFilterFromRequest(request, includeHidden) {
    const includeKind = mapPurposePrefix(request.includePurposePrefix);
    const excludeKind = mapPurposePrefix(request.excludePurposePrefix);
    const excluded = excludedKinds(request, includeHidden, excludeKind);
    return {
        archived: archiveFilter(request),
        includeHidden,
        excludeInternalTreeSessions: !includeHidden,
        ...optionalKind('includeSessionKinds', includeKind),
        ...optionalKinds('excludeSessionKinds', excluded),
        ...literalPurposeFilters(request, includeKind, excludeKind),
    };
}
/**
 * The Session filter every project surface uses: the sidebar's project list, the
 * sidebar's own archive and the `project_archive_sessions` Agent tool.
 *
 * Projects include Cron roots because they are user-visible tasks associated
 * with a workspace. Ordinary conversation lists still exclude Cron's internal
 * execution tree through their default Session filter.
 *
 * It lives beside `sessionTreeFilterFromRequest` rather than in the Project
 * Application so the sidebar tools service can select the same chats without
 * reaching up into `application/`.
 */
export function projectSessionFilter(request) {
    const { excludeSessionKinds, ...filter } = sessionTreeFilterFromRequest(request, false);
    const excluded = excludeSessionKinds?.filter((kind) => kind !== 'cron');
    return {
        ...filter,
        excludeInternalTreeSessions: false,
        ...(excluded?.length ? { excludeSessionKinds: excluded } : {}),
    };
}
function mapPurposePrefix(prefix) {
    return prefix ? sessionKindForLegacyPurposePrefix(prefix) : undefined;
}
function archiveFilter(request) {
    if (request.onlyArchived === true || request.onlyCompressed === true)
        return true;
    return request.includeArchived === true ? undefined : false;
}
function excludedKinds(request, includeHidden, excludeKind) {
    const defaults = includeHidden || request.includePurposePrefix ? [] : ['cron'];
    return excludeKind ? [...new Set([...defaults, excludeKind])] : defaults;
}
function optionalKind(_key, kind) {
    return kind ? { includeSessionKinds: [kind] } : {};
}
function optionalKinds(_key, kinds) {
    return kinds.length > 0 ? { excludeSessionKinds: kinds } : {};
}
function literalPurposeFilters(request, includeKind, excludeKind) {
    return {
        ...(request.includePurposePrefix && !includeKind
            ? { includePurposePrefix: request.includePurposePrefix }
            : {}),
        ...(request.excludePurposePrefix && !excludeKind
            ? { excludePurposePrefix: request.excludePurposePrefix }
            : {}),
    };
}
//# sourceMappingURL=tree-query-policy.js.map