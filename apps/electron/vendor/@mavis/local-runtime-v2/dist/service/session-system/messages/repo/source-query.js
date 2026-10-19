import { and, asc, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import { messageRows } from '../../../../infra/db/schema/messages.js';
import { sessionResources, sessionTurnResources, } from '../../../../infra/db/schema/session-resources.js';
export function createSessionSourceProjectionRepository(options) {
    return new DrizzleSessionSourceProjectionRepository(options.db);
}
class DrizzleSessionSourceProjectionRepository {
    db;
    constructor(db) {
        this.db = db;
    }
    async list(input) {
        const aggregate = this.db
            .select({
            sourcedTurnCount: sql `count(distinct ${sessionTurnResources.turnId})`,
            sourceCount: sql `count(*)`,
        })
            .from(sessionTurnResources)
            .where(eq(sessionTurnResources.sessionId, input.sessionId))
            .get();
        const turnRows = this.db
            .select({
            turnId: sessionTurnResources.turnId,
            sourceStartedAtMs: sql `min(${sessionTurnResources.createdAtMs})`,
            cursorRowId: sql `max(${messageRows.id})`,
        })
            .from(sessionTurnResources)
            .innerJoin(messageRows, and(eq(messageRows.sessionId, sessionTurnResources.sessionId), eq(messageRows.messageId, sessionTurnResources.messageId)))
            .where(eq(sessionTurnResources.sessionId, input.sessionId))
            .groupBy(sessionTurnResources.turnId)
            .having(input.beforeRowId === undefined
            ? undefined
            : lt(sql `max(${messageRows.id})`, input.beforeRowId))
            .orderBy(desc(sql `max(${messageRows.id})`))
            .limit(input.limit + 1)
            .all();
        const hasMore = turnRows.length > input.limit;
        const selectedTurnRows = hasMore ? turnRows.slice(0, input.limit) : turnRows;
        const turnIds = selectedTurnRows.map((turn) => turn.turnId);
        const sourceRows = turnIds.length === 0
            ? []
            : this.db
                .select(sourceSelection())
                .from(sessionTurnResources)
                .innerJoin(messageRows, and(eq(messageRows.sessionId, sessionTurnResources.sessionId), eq(messageRows.messageId, sessionTurnResources.messageId)))
                .innerJoin(sessionResources, and(eq(sessionResources.sessionId, sessionTurnResources.sessionId), eq(sessionResources.resourceIndex, sessionTurnResources.resourceIndex)))
                .where(and(eq(sessionTurnResources.sessionId, input.sessionId), inArray(sessionTurnResources.turnId, turnIds)))
                .orderBy(asc(sessionTurnResources.resourceOrdinal), asc(messageRows.id))
                .all();
        const sourcesByTurnId = new Map();
        for (const row of sourceRows) {
            if (!row.toolCallId)
                continue;
            const sources = sourcesByTurnId.get(row.turnId) ?? [];
            sources.push(toSourceRecord(row));
            sourcesByTurnId.set(row.turnId, sources);
        }
        const recentSources = this.db
            .select(sourceSelection())
            .from(sessionTurnResources)
            .innerJoin(messageRows, and(eq(messageRows.sessionId, sessionTurnResources.sessionId), eq(messageRows.messageId, sessionTurnResources.messageId)))
            .innerJoin(sessionResources, and(eq(sessionResources.sessionId, sessionTurnResources.sessionId), eq(sessionResources.resourceIndex, sessionTurnResources.resourceIndex)))
            .where(and(eq(sessionTurnResources.sessionId, input.sessionId), sql `${sessionTurnResources.toolCallId} is not null`))
            .orderBy(desc(messageRows.id), desc(sessionTurnResources.resourceOrdinal))
            .limit(4)
            .all()
            .map(toSourceRecord);
        const turns = selectedTurnRows.flatMap((turn) => {
            const sources = sourcesByTurnId.get(turn.turnId) ?? [];
            return sources.length > 0 ? [{ ...turn, sources }] : [];
        });
        return {
            sourcedTurnCount: aggregate?.sourcedTurnCount ?? 0,
            sourceCount: aggregate?.sourceCount ?? 0,
            recentSources,
            turns,
            hasMore,
        };
    }
    async hasOccurrence(sessionId, messageId, toolCallId) {
        return Boolean(this.db
            .select({ messageId: sessionTurnResources.messageId })
            .from(sessionTurnResources)
            .where(and(eq(sessionTurnResources.sessionId, sessionId), eq(sessionTurnResources.messageId, messageId), eq(sessionTurnResources.toolCallId, toolCallId)))
            .limit(1)
            .get());
    }
}
function sourceSelection() {
    return {
        turnId: sessionTurnResources.turnId,
        messageId: sessionTurnResources.messageId,
        toolCallId: sessionTurnResources.toolCallId,
        resourceOrdinal: sessionTurnResources.resourceOrdinal,
        createdAtMs: sessionTurnResources.createdAtMs,
        sourceId: sessionResources.sourceId,
        resourceType: sessionResources.resourceType,
        resourceDataJson: sessionResources.resourceDataJson,
        resourceDataVersion: sessionResources.resourceDataVersion,
    };
}
function toSourceRecord(row) {
    return {
        sourceId: row.sourceId,
        resourceType: row.resourceType,
        resourceDataJson: row.resourceDataJson,
        resourceDataVersion: row.resourceDataVersion,
        messageId: row.messageId,
        toolCallId: row.toolCallId ?? '',
        resourceOrdinal: row.resourceOrdinal,
        createdAtMs: row.createdAtMs,
    };
}
//# sourceMappingURL=source-query.js.map