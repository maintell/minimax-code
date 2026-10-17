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