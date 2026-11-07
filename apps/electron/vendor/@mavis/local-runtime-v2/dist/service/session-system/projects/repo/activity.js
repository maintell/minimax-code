import { sql } from 'drizzle-orm';
import { projects } from '../../../../infra/db/schema/projects.js';
import { sessions } from '../../../../infra/db/schema/sessions.js';
// The published v5 triggers own aggregates excluding Channel Sessions. Add Channel
// activity at read time so older builds can keep writing the same shared database.
// Keep the partial-index predicate explicit so SQLite can use the v6 project indexes.
export const channelProjectPredicate = sql `${sessions.projectId} = ${projects.projectId}
  AND ${sessions.columnarVersion} = 3 AND ${sessions.archived} = 0
  AND ${sessions.visibility} <> 'hidden' AND ${sessions.sessionKind} NOT IN ('peek', 'cron')
  AND ${sessions.sessionKind} = 'channel'`;
export const projectActivityExpression = sql `MAX(${projects.latestActivityAtMs}, COALESCE(
  (SELECT MAX(${sessions.updatedAtMs}) FROM ${sessions} WHERE ${channelProjectPredicate}), 0))`;
/**
 * Project list sort key. A project the user created explicitly may have no
 * conversation yet; it ranks by its creation time until it has activity.
 */
export const projectListActivityExpression = sql `MAX(${projectActivityExpression}, ${projects.createdAtMs})`;
/**
 * A visible workspace Project with stored folders stays listed without
 * conversations. Rows created implicitly by a conversation still need one.
 */
export const explicitWorkspaceProjectPredicate = sql `(${projects.projectKind} = 'workspace'
  AND ${projects.hidden} = 0
  AND CASE WHEN json_valid(${projects.extraDataJson})
    THEN json_type(${projects.extraDataJson}, '$.workspaceRoots') IS NOT NULL
    ELSE 0 END)`;
//# sourceMappingURL=activity.js.map