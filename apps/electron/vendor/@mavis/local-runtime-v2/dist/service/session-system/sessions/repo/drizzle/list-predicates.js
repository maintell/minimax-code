import { and, eq, inArray, isNotNull, isNull, ne, notInArray, or, sql, } from 'drizzle-orm';
import { projects } from '../../../../../infra/db/schema/projects.js';
import { sessions } from '../../../../../infra/db/schema/sessions.js';
import { normalizeAbsolutePath } from '../../../shared/path-normalization.js';
import { sessionAgentNamePredicate } from '../agent-name-predicate.js';
export function sessionListPredicate(options) {
    return and(eq(sessions.columnarVersion, 3), listAgentPredicate(options), listRuntimePredicate(options), workspacePredicate(options.workspaceDir), workspaceDirsPredicate(options.workspaceDirs), projectKeysPredicate(options.projectKeys), requiredWorkspacePredicate(options.requireWorkspaceDir), listOriginPredicate(options), listParentPredicate(options), archivedPredicate(options.archived), listTypePredicate(options), listVisibilityPredicate(options), includedKindsPredicate(options.includeSessionKinds), excludedKindsPredicate(options.excludeSessionKinds), startsWithPredicate(options.includePurposePrefix), notStartsWithPredicate(options.excludePurposePrefix), listSearchPredicate(options));
}
function listAgentPredicate(options) {
    return sessionAgentNamePredicate(options.agentName);
}
function listRuntimePredicate(options) {
    return 'runtime' in options && options.runtime
        ? eq(sessions.runtime, options.runtime)
        : undefined;
}
function workspacePredicate(workspaceDir) {
    if (workspaceDir === undefined)
        return undefined;
    const normalized = normalizeAbsolutePath(workspaceDir);
    if (!normalized)
        return sql `0`;
    return /^[A-Za-z]:[\\/]|^\\\\/u.test(normalized)
        ? eq(sql `lower(${sessions.workspaceDir})`, normalized.toLocaleLowerCase())
        : eq(sessions.workspaceDir, normalized);
}
/** 落在其中任一工作目录；每个目录按 `workspaceDir` 同样的规则比较。空列表不限。 */
export function workspaceDirsPredicate(workspaceDirs) {
    return workspaceDirs?.length ? or(...workspaceDirs.map(workspacePredicate)) : undefined;
}
/**
 * 属于其中任一项目的 Session。项目 key 和侧栏、项目接口一致：默认项目是 `default`，工作区项目是
 * `workspace:<项目目录>`（worktree 已归到主仓库）。Session 和项目的对应关系是 `project_id`。
 */
export function projectKeysPredicate(projectKeys) {
    if (!projectKeys?.length)
        return undefined;
    // 一元加号让它不参与选索引：从项目索引反查会话的话，最近更新顺序得临时排序。
    return sql `+${sessions.projectId} IN (SELECT ${projects.projectId} FROM ${projects}
    WHERE ${projectKeySql()} IN (SELECT value FROM json_each(${JSON.stringify(projectKeys)})))`;
}
/** 项目行的 key：`default` 或 `workspace:<项目目录>`。 */
export function projectKeySql() {
    return sql `CASE WHEN ${projects.projectKind} = 'default' THEN 'default'
    ELSE 'workspace:' || ${projects.workspaceDir} END`;
}
function requiredWorkspacePredicate(required) {
    return required ? isNotNull(sessions.workspaceDir) : undefined;
}
function listParentPredicate(options) {
    if (!('parentSessionId' in options) || options.parentSessionId === undefined)
        return undefined;
    return options.parentSessionId === null
        ? isNull(sessions.parentSessionId)
        : eq(sessions.parentSessionId, options.parentSessionId);
}
function listOriginPredicate(options) {
    if (!('originCronId' in options) || options.originCronId === undefined)
        return undefined;
    if (options.originCronId === null)
        return isNull(sessions.originCronId);
    return options.originCronId ? eq(sessions.originCronId, options.originCronId) : undefined;
}
function archivedPredicate(archived) {
    return archived === undefined ? undefined : eq(sessions.archived, archived ? 1 : 0);
}
function listTypePredicate(options) {
    return options.sessionType ? eq(sessions.sessionType, options.sessionType) : undefined;
}
function listVisibilityPredicate(options) {
    return options.includeHidden === false ? ne(sessions.visibility, 'hidden') : undefined;
}
function includedKindsPredicate(kinds) {
    return kinds?.length ? inArray(sessions.sessionKind, [...kinds]) : undefined;
}
function excludedKindsPredicate(kinds) {
    return kinds?.length ? notInArray(sessions.sessionKind, [...kinds]) : undefined;
}
function listSearchPredicate(options) {
    const search = 'search' in options ? options.search?.trim().toLocaleLowerCase() : undefined;
    return search ? sessionSubstringPredicate(search) : undefined;
}
function startsWithPredicate(prefix) {
    return prefix ? sql `substr(${sessions.purpose}, 1, ${prefix.length}) = ${prefix}` : undefined;
}
function notStartsWithPredicate(prefix) {
    return prefix
        ? or(isNull(sessions.purpose), sql `substr(${sessions.purpose}, 1, ${prefix.length}) <> ${prefix}`)
        : undefined;
}
function sessionSubstringPredicate(search) {
    const value = `%${search}%`;
    return sql `(
    lower(${sessions.sessionId}) LIKE ${value}
    OR lower(coalesce(${sessions.agentName}, '')) LIKE ${value}
    OR lower(coalesce(${sessions.title}, '')) LIKE ${value}
    OR lower(coalesce(${sessions.workspaceDir}, '')) LIKE ${value}
    OR lower(coalesce(${sessions.purpose}, '')) LIKE ${value}
    OR lower(coalesce(${sessions.status}, '')) LIKE ${value}
    OR lower(coalesce(${sessions.sessionType}, '')) LIKE ${value}
  )`;
}
//# sourceMappingURL=list-predicates.js.map