import { sessions } from '../../../infra/db/schema/sessions.js';
import { asc, desc, inArray, eq } from 'drizzle-orm';
import { isBunnyAgentName } from '@mavis/shared/agent-avatar';
import { bunnyTaskTelemetry } from '../../../infra/db/schema/bunny-store.js';
import { incrementMetric, } from '@mavis/shared/local-runtime-logging/metrics';
import { bunnyTaskHistoryMetrics } from './assignment-metrics.js';
const CLOSE_STATES = new Set(['completed', 'cancelled', 'taken_over']);
const REASONS = new Set(['review_passed', 'user_marked', 'cancelled', 'error']);
/** Original persisted history identity and time; never renderer state or replay time. */
function taskTelemetryRow(fact) {
    if (!isBunnyAgentName(fact.assignerAgentName))
        return;
    if (fact.type !== 'task.opened' && fact.type !== 'task.closed')
        return;
    const params = {
        task_session_id: fact.sessionId,
        assigner_session_id: fact.assignerSessionId,
        assigner_agent_name: fact.assignerAgentName,
    };
    if (fact.type === 'task.closed') {
        const close = closedTaskParams(fact.payload);
        if (!close)
            return;
        Object.assign(params, close);
    }
    return {
        eventId: `${fact.taskId}:${fact.type}:${fact.seq}:${fact.createdAtMs}`,
        event: fact.type === 'task.opened' ? 'bunny_task_create' : 'bunny_task_close',
        sessionId: fact.sessionId,
        seq: fact.seq,
        occurredAtMs: fact.createdAtMs,
        params,
    };
}
function closedTaskParams(p) {
    const params = {};
    if (!CLOSE_STATES.has(String(p.state)))
        return;
    params.state = String(p.state);
    params.by = p.by === 'assigner' ? 'bunny' : 'user';
    if (REASONS.has(String(p.reason)))
        params.reason = String(p.reason);
    for (const [field, key] of Object.entries({
        user_turns: 'userTurns',
        user_message_count: 'userMessages',
        duration_ms: 'durationMs',
    })) {
        if (typeof p[key] === 'number' && Number.isFinite(p[key]) && p[key] >= 0)
            params[field] = String(p[key]);
    }
    if (typeof p.userTookOver === 'boolean')
        params.user_took_over = String(p.userTookOver);
    return params;
}
/** Same transaction as the task history. Failed analytics must not fail the task mutation. */
export function bunnyTaskHistoryObserver(ownerKind, metrics, sessionDb) {
    const count = bunnyTaskHistoryMetrics(metrics);
    return (tx, events) => {
        count(tx, events);
        if (ownerKind !== 'electron')
            return;
        try {
            const rows = events.flatMap((event) => taskTelemetryRow(event) ?? []);
            if (!rows.length)
                return;
            for (const row of rows)
                row.params.agent_name =
                    sessionDb
                        ?.select({ name: sessions.agentName })
                        .from(sessions)
                        .where(eq(sessions.sessionId, row.sessionId))
                        .get()?.name ?? 'default';
            tx.insert(bunnyTaskTelemetry).values(rows).onConflictDoNothing().run();
            const overflow = tx
                .select({ id: bunnyTaskTelemetry.eventId })
                .from(bunnyTaskTelemetry)
                .orderBy(desc(bunnyTaskTelemetry.occurredAtMs), desc(bunnyTaskTelemetry.seq))
                .limit(200)
                .offset(10_000)
                .all();
            const dropped = overflow;
            if (dropped.length) {
                tx.delete(bunnyTaskTelemetry)
                    .where(inArray(bunnyTaskTelemetry.eventId, dropped.map((row) => row.id)))
                    .run();
                incrementMetric(metrics, 'bunny_telemetry_dropped_total', dropped.length, {
                    reason: 'outbox_full',
                });
            }
        }
        catch {
            try {
                incrementMetric(metrics, 'bunny_telemetry_dropped_total', 1, { reason: 'write_failed' });
            }
            catch {
                /* Fail open. */
            }
        }
    };
}
/** Exact acknowledgements cannot delete a newer event after reset or a concurrent drain. */
export class BunnyTaskTelemetry {
    store;
    constructor(store) {
        this.store = store;
    }
    pending(limit = 100) {
        if (!this.store.hasData())
            return [];
        return this.store.db
            .select()
            .from(bunnyTaskTelemetry)
            .orderBy(asc(bunnyTaskTelemetry.occurredAtMs), asc(bunnyTaskTelemetry.seq))
            .limit(Math.min(200, limit))
            .all();
    }
    acknowledge(eventIds) {
        if (!eventIds.length || !this.store.hasData())
            return;
        this.store.db
            .delete(bunnyTaskTelemetry)
            .where(inArray(bunnyTaskTelemetry.eventId, [...eventIds]))
            .run();
    }
}
/** Headless hosts neither produce nor expose Desktop business analytics. */
export function createBunnyTaskTelemetry(ownerKind, store) {
    return ownerKind === 'electron' ? new BunnyTaskTelemetry(store) : undefined;
}
//# sourceMappingURL=task-telemetry.js.map