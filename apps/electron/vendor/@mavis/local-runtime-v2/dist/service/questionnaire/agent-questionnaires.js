import { eq, inArray, or } from 'drizzle-orm';
import { questionnaireRequests } from '../../infra/db/schema/questionnaire.js';
import { sqliteTableExists } from '../../infra/db/sqlite-table-exists.js';
const QUESTIONNAIRE_TABLE = 'questionnaire_requests';
export function createAgentQuestionnaires(agentName) {
    const targets = (db, sessionIds) => {
        const owners = [...new Set(sessionIds)];
        const byAgent = eq(questionnaireRequests.agentName, agentName);
        return db
            .select({ id: questionnaireRequests.requestId })
            .from(questionnaireRequests)
            .where(owners.length ? or(byAgent, inArray(questionnaireRequests.sessionId, owners)) : byAgent)
            .all()
            .map((row) => row.id);
    };
    return {
        count: (db, sessionIds) => sqliteTableExists(db, QUESTIONNAIRE_TABLE) ? targets(db, sessionIds).length : null,
        clear: (tx, sessionIds) => {
            if (!sqliteTableExists(tx, QUESTIONNAIRE_TABLE))
                return null;
            let deleted = 0;
            for (const id of targets(tx, sessionIds))
                deleted += tx
                    .delete(questionnaireRequests)
                    .where(eq(questionnaireRequests.requestId, id))
                    .run().changes;
            return deleted;
        },
    };
}
//# sourceMappingURL=agent-questionnaires.js.map