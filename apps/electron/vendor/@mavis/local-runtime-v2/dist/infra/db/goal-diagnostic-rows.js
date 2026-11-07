import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { desc, gte, inArray, or } from 'drizzle-orm';
import { DatabaseClient } from './client.js';
import { localRuntimeV2GoalRequests, localRuntimeV2Goals, } from './schema/goal.js';
const GOAL_TABLE = 'local_runtime_v2_goals';
const REQUEST_TABLE = 'local_runtime_v2_goal_requests';
/**
 * Read recent Goal evidence for a consent-gated diagnostic bundle through an
 * independent read-only connection. Evidence is chosen by activity time: a
 * request or receipt in the window brings its Goal in even when the Goal row
 * itself last changed earlier. The runtime does not need to be running; a
 * missing database or a profile that predates the tables yields nothing.
 * Nothing here writes.
 */
export function readGoalDiagnosticRows(dataDir, input) {
    if (!existsSync(join(dataDir, 'v2', 'sqlite', 'runtime-state.sqlite'))) {
        return { goals: [], requests: [] };
    }
    const client = new DatabaseClient({ dataDir, readonly: true });
    try {
        if (!tableExists(client, GOAL_TABLE))
            return { goals: [], requests: [] };
        const requests = tableExists(client, REQUEST_TABLE)
            ? client.db
                .select()
                .from(localRuntimeV2GoalRequests)
                .where(gte(localRuntimeV2GoalRequests.updatedAtMs, input.sinceMs))
                .orderBy(desc(localRuntimeV2GoalRequests.updatedAtMs), desc(localRuntimeV2GoalRequests.requestId))
                .limit(input.requestLimit ?? 0)
                .all()
            : [];
        const activeGoalIds = [...new Set(requests.map((request) => request.goalId))];
        const goals = client.db
            .select()
            .from(localRuntimeV2Goals)
            .where(activeGoalIds.length > 0
            ? or(gte(localRuntimeV2Goals.updatedAtMs, input.sinceMs), inArray(localRuntimeV2Goals.goalId, activeGoalIds))
            : gte(localRuntimeV2Goals.updatedAtMs, input.sinceMs))
            .orderBy(desc(localRuntimeV2Goals.updatedAtMs), desc(localRuntimeV2Goals.goalId))
            .limit(input.limit)
            .all();
        return { goals, requests };
    }
    finally {
        client.close();
    }
}
function tableExists(client, name) {
    const table = client.rawDb
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(name);
    return table?.name === name;
}
//# sourceMappingURL=goal-diagnostic-rows.js.map