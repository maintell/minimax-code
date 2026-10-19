import { and, eq, isNull, ne, or } from 'drizzle-orm';
import { MsgType, Role } from '@mavis/agent-core/protocol';
import { classifySessionClioSource, EvalCaptureOrigin } from '@mavis/shared/session-clio';
import { messageRows } from '../../infra/db/schema/messages.js';
import { queueItems } from '../../infra/db/schema/queue.js';
import { turnIngress } from '../../infra/db/schema/turn.js';
import { sessionClioQueuedQueryId } from './query-identity.js';
/**
 * Resolves the capture identity.
 *
 * The identity key is a raw string, never a parsed number, because archon user
 * ids are i64 snowflakes that do not survive a JS number. Capture is skipped
 * entirely while no identity is bound, so a record can never be produced without
 * an owner and later attributed to whoever happens to be signed in.
 */
export function createSessionClioIdentityPort(options) {
    return {
        current: () => {
            let context;
            try {
                context = options.authContext();
            }
            catch {
                return undefined;
            }
            const userId = context?.realUserID?.trim();
            const email = context?.userEmail?.trim().toLowerCase();
            let identityKey;
            if (userId)
                identityKey = `uid:${userId}`;
            else if (email)
                identityKey = `email:${email}`;
            if (!identityKey)
                return undefined;
            return { identityKey, userId: 0, bizId: options.bizId?.() ?? '' };
        },
    };
}
/**
 * Checks durable genuine Query history, including inputs never dispatched.
 *
 * The probe deliberately reads durable rows rather than an in-memory projection:
 * the answer decides a one-shot, permanent enrolment, so it must survive a
 * restart that happened between the Session's earlier turns and this one.
 */
export function createSessionClioEligibilityPort(db) {
    return {
        hasHistoryBefore: (input) => {
            const turnId = input.turnId;
            const messageSources = db
                .selectDistinct({ source: messageRows.source })
                .from(messageRows)
                .where(and(eq(messageRows.sessionId, input.sessionId), or(eq(messageRows.role, Role.User), isNull(messageRows.role)), turnId ? or(isNull(messageRows.turnId), ne(messageRows.turnId, turnId)) : undefined))
                .all();
            // Missing legacy provenance cannot attest that capture started at Query 1.
            if (messageSources.some((row) => hasPotentialQuerySource(row.source))) {
                return Promise.resolve(true);
            }
            const queuePrefix = sessionClioQueuedQueryId('');
            const currentItemId = input.queryId.startsWith(queuePrefix)
                ? input.queryId.slice(queuePrefix.length)
                : undefined;
            const queueSources = db
                .selectDistinct({ source: queueItems.source })
                .from(queueItems)
                .where(and(eq(queueItems.sessionId, input.sessionId), currentItemId ? ne(queueItems.itemId, currentItemId) : undefined))
                .all();
            if (queueSources.some((row) => hasPotentialQuerySource(row.source))) {
                return Promise.resolve(true);
            }
            const previousTurns = db
                .selectDistinct({
                metadata: turnIngress.inputMetadataJson,
                source: turnIngress.claimSource,
            })
                .from(turnIngress)
                .where(and(eq(turnIngress.sessionId, input.sessionId), ne(turnIngress.busyReason, 'compaction'), turnId ? ne(turnIngress.turnId, turnId) : undefined))
                .all();
            return Promise.resolve(previousTurns.some(hasPotentialTurnQuery));
        },
    };
}
function hasPotentialQuerySource(source) {
    return (typeof source !== 'string' || !source.trim() || classifySessionClioSource(source) !== 'internal');
}
function hasPotentialTurnQuery(turn) {
    const metadata = JSON.parse(turn.metadata);
    if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) {
        throw new Error('Unverifiable Clio turn admission metadata');
    }
    if (Reflect.get(metadata, 'hasContent') === false)
        return false;
    return hasPotentialQuerySource(Reflect.get(metadata, 'source') ?? turn.source);
}
/**
 * Reads a finished turn's retained, safety-approved, user-visible answer.
 *
 * Durable Message rows are the only safety-approved surface: a frame reaches
 * them exclusively through the output-safety writer. Rows stamped
 * `safety_review_unknown` never completed review and are therefore excluded, and
 * the Stop-hook `lastAssistantMessage` — raw pre-safety text — is never a source.
 *
 * The answer is the trailing run of approved assistant rows that issued no tool
 * calls: everything the agent said after its last tool interaction, and nothing
 * from mid-turn narration. Product metadata rows are stepped over rather than
 * treated as that boundary — a turn routinely closes with one, because plugin
 * Stop-hook runtime warnings are committed after the model's last text — and
 * they never join the answer either, whatever role they carry.
 */
export function createSessionClioFinalAnswerPort(options) {
    return {
        read: async (input) => {
            const rows = await options.messages.listTurn(input.sessionId, input.turnId);
            const answer = [];
            for (let index = rows.length - 1; index >= 0; index -= 1) {
                const row = rows[index];
                if (!row)
                    break;
                // `MsgType.SystemEvent` is the protocol's own marker for a row the
                // product renders as its own surface. It is the only class stepped
                // over: a tool call, a user message, or a row whose review never
                // completed is a real boundary and still ends the walk.
                if (Reflect.get(row, 'msg_type') === MsgType.SystemEvent)
                    continue;
                if (!isApprovedAssistantAnswer(row))
                    break;
                answer.unshift(row);
            }
            return {
                text: answer.map(assistantBody).join('\n\n'),
                messageIds: answer.flatMap((row) => (typeof row.msg_id === 'string' ? [row.msg_id] : [])),
            };
        },
    };
}
function isApprovedAssistantAnswer(row) {
    if (row.role !== Role.Assistant)
        return false;
    if (row.kind !== undefined)
        return false;
    if (Reflect.get(row, 'safety_review_unknown') === true)
        return false;
    const toolCalls = Reflect.get(row, 'tool_calls');
    if (Array.isArray(toolCalls) && toolCalls.length > 0)
        return false;
    return assistantBody(row).trim().length > 0;
}
function assistantBody(row) {
    const body = row.msg_content ?? row.msgContent ?? row.content;
    return typeof body === 'string' ? body : '';
}
export const DESKTOP_CLIO_CAPTURE_ORIGIN = EvalCaptureOrigin.LocalPi;
//# sourceMappingURL=adapters.js.map