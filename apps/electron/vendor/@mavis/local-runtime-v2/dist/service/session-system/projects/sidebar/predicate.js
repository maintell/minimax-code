import { projectConversationRootPredicate } from '../../sessions/repo/filters.js';
import { and, eq, exists as sqlExists, isNull, ne, notInArray, or, sql, } from 'drizzle-orm';
import { explicitWorkspaceProjectPredicate } from '../repo/activity.js';
import { sessions as s, sessionAgentState as a } from '../../../../infra/db/schema/sessions.js';
import { projects as p } from '../../../../infra/db/schema/projects.js';
import { turnIngress as t } from '../../../../infra/db/schema/turn.js';
import { sessionAfterProjectRemoval } from '../../shared/project-removal.js';
export const TRUSTED_IM_MARKER = '[mavis:trusted-legacy-im-root]';
export const ordinarySidebarSession = or(isNull(s.purpose), ne(s.purpose, 'miniapp-authoring'));
const trustedImRoot = and(eq(s.sessionType, 'root'), eq(s.sessionKind, 'conversation'), or(eq(s.purpose, TRUSTED_IM_MARKER), sql `substr(${s.purpose}, -${TRUSTED_IM_MARKER.length + 1}) = ${`\n${TRUSTED_IM_MARKER}`}`));
export const canonicalOwner = sql `CASE WHEN ${s.agentName} IN ('main','mavis') THEN 'mavis' ELSE ${s.agentName} END`;
export const isDone = sql `(${s.status} = 'idle' AND EXISTS (
  SELECT 1 FROM ${a} WHERE ${a.sessionId} = ${s.sessionId} AND ${a.terminalOutcome} = 'completed'
) AND NOT EXISTS (SELECT 1 FROM ${t} WHERE ${t.sessionId} = ${s.sessionId} AND ${t.status} = 'accepted'))`;
function membership(column, values, negate = false) {
    return negate
        ? sql `${column} NOT IN (SELECT value FROM json_each(${JSON.stringify(values)}))`
        : sql `${column} IN (SELECT value FROM json_each(${JSON.stringify(values)}))`;
}
export function eligible(includeHiddenProject = false, internalRootIds = [], includeArchived = false, bunny) {
    return and(eq(s.columnarVersion, 3), includeArchived ? undefined : eq(s.archived, 0), isNull(s.parentSessionId), includeHiddenProject ? undefined : eq(p.hidden, 0), sessionAfterProjectRemoval(), membership(s.sessionId, internalRootIds, true), bunny && !bunny.showBunnyCreatedSessions && bunny.bunnyCreatedIds.length
        ? membership(s.sessionId, bunny.bunnyCreatedIds, true)
        : undefined, or(bunny?.showBunnyCreatedSessions && bunny.bunnyCreatedIds.length
        ? and(eq(s.sessionKind, 'conversation'), membership(s.sessionId, bunny.bunnyCreatedIds))
        : undefined, and(eq(s.sessionType, 'branch'), ne(s.visibility, 'hidden'), notInArray(s.sessionKind, ['peek', 'task', 'channel'])), and(eq(s.sessionType, 'branch'), eq(s.sessionKind, 'channel')), and(ne(s.visibility, 'hidden'), projectConversationRootPredicate())));
}
/**
 * Whether a Project is in the sidebar list. A workspace project stays listed after all of its
 * conversations are archived; only an explicit removal (hidden) takes it out of the sidebar. The
 * default "no project" bucket still needs an active conversation, and a project the user created
 * is listed before its first conversation. Existence includes pinned sessions but never internal
 * ones. The sidebar query and the Session repository (which lists a returning project first)
 * share it; `excludedSessionId` asks how it stood before that Session was created.
 */
export function listedProjectPredicate(db, { internalRootIds, query, excludedSessionId, }) {
    const hasEligibleSession = (includeArchived) => sqlExists(db
        .select({ id: s.sessionId })
        .from(s)
        .where(and(eq(s.projectId, p.projectId), excludedSessionId === undefined ? undefined : ne(s.sessionId, excludedSessionId), eligible(false, internalRootIds, includeArchived, query), ordinarySidebarSession))
        .limit(1));
    return or(hasEligibleSession(false), and(eq(p.projectKind, 'workspace'), hasEligibleSession(true)), explicitWorkspaceProjectPredicate);
}
export function sidebarProjectPredicate(q) {
    return and(eq(p.hidden, 0), eq(p.pinned, 0), membership(p.projectId, q.excludedProjectIds, true));
}
export function sidebarPredicate(q) {
    const typeConditions = {
        chat: eq(p.projectKind, 'default'),
        task: eq(p.projectKind, 'workspace'),
        cron: or(eq(s.sessionKind, 'cron'), membership(s.sessionId, q.cronTargetIds)),
        im: or(eq(s.sessionKind, 'channel'), membership(s.sessionId, q.bindingIds), trustedImRoot),
    };
    const statusConditions = {
        working: eq(s.status, 'started'),
        done: isDone,
        unread: membership(s.sessionId, q.unreadIds),
    };
    return and(eligible(false, q.internalRootIds, false, q), ordinarySidebarSession, sidebarProjectPredicate(q), membership(s.sessionId, q.excludedIds, true), q.types.length ? or(...q.types.map((v) => typeConditions[v])) : undefined, q.statuses.length ? or(...q.statuses.map((v) => statusConditions[v])) : undefined, q.agentNames.length ? membership(canonicalOwner, q.agentNames) : undefined, q.activityDays ? sql `${s.updatedAtMs} >= ${q.nowMs - q.activityDays * 86400000}` : undefined);
}
export function tupleAfter(columns, values, descending) {
    if (!values)
        return undefined;
    return or(...columns.map((column, i) => and(...columns.slice(0, i).map((c, j) => sql `${c} = ${values[j]}`), descending[i] ? sql `${column} < ${values[i]}` : sql `${column} > ${values[i]}`)));
}
//# sourceMappingURL=predicate.js.map