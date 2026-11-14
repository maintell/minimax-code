import { and, eq, lte } from 'drizzle-orm';
import { bunnyDeliveryBaseline } from '../../../infra/db/schema/bunny-store.js';
/** The reserved row that says a Session has a baseline at all; without it the next block is full. */
const DELIVERY_BASELINE_MARKER = 'baseline';
/**
 * What each delta block delivered to Bunny's main conversation (spec 9.4), one
 * row per task, ledger entry, space context.md and the UI space. Persisted, so a
 * restart compares against it instead of starting over.
 */
export class DeliveryBaselineRepository {
    db;
    constructor(db) {
        this.db = db;
    }
    /** The delivered states by entry key, or undefined when the Session has no baseline. */
    read(sessionId) {
        const rows = this.db
            .select({ key: bunnyDeliveryBaseline.entryKey, state: bunnyDeliveryBaseline.deliveredState })
            .from(bunnyDeliveryBaseline)
            .where(eq(bunnyDeliveryBaseline.sessionId, sessionId))
            .all();
        if (!rows.some((row) => row.key === DELIVERY_BASELINE_MARKER))
            return undefined;
        return new Map(rows.filter((row) => row.key !== DELIVERY_BASELINE_MARKER).map((row) => [row.key, row.state]));
    }
    /**
     * Records one delta block once it is in history. An entry recorded after the
     * block was assembled (a write Bunny made itself meanwhile) is newer and kept.
     * A delta block assembled against a baseline that has since been cleared is
     * not recorded: the next block sends the full state.
     */
    advance(sessionId, input) {
        return this.db.transaction((tx) => {
            if (!input.full && !hasMarker(tx, sessionId))
                return false;
            upsert(tx, {
                sessionId,
                entryKey: DELIVERY_BASELINE_MARKER,
                state: 'v1',
                nowMs: input.nowMs,
            });
            for (const [key, state] of input.updates) {
                const stillCurrent = and(eq(bunnyDeliveryBaseline.sessionId, sessionId), eq(bunnyDeliveryBaseline.entryKey, key), lte(bunnyDeliveryBaseline.updatedAtMs, input.preparedAtMs));
                if (state === null) {
                    tx.delete(bunnyDeliveryBaseline).where(stillCurrent).run();
                    continue;
                }
                tx.insert(bunnyDeliveryBaseline)
                    .values({ sessionId, entryKey: key, deliveredState: state, updatedAtMs: input.nowMs })
                    .onConflictDoUpdate({
                    target: [bunnyDeliveryBaseline.sessionId, bunnyDeliveryBaseline.entryKey],
                    set: { deliveredState: state, updatedAtMs: input.nowMs },
                    setWhere: lte(bunnyDeliveryBaseline.updatedAtMs, input.preparedAtMs),
                })
                    .run();
            }
            return true;
        });
    }
    /**
     * Records a change Bunny or the system made itself, which is already known and
     * must not come back as news. A Session without a baseline is left alone.
     */
    absorb(sessionId, key, change, nowMs) {
        this.db.transaction((tx) => {
            if (!hasMarker(tx, sessionId))
                return;
            const state = typeof change === 'function' ? change(readEntry(tx, sessionId, key)) : change;
            if (state === undefined)
                return;
            if (state === null) {
                tx.delete(bunnyDeliveryBaseline)
                    .where(and(eq(bunnyDeliveryBaseline.sessionId, sessionId), eq(bunnyDeliveryBaseline.entryKey, key)))
                    .run();
                return;
            }
            upsert(tx, { sessionId, entryKey: key, state, nowMs });
        });
    }
    /** A segment rebuild or a rewind: the next delta block sends the full state. */
    clear(sessionId) {
        this.db
            .delete(bunnyDeliveryBaseline)
            .where(eq(bunnyDeliveryBaseline.sessionId, sessionId))
            .run();
    }
}
/** Bunny initialization clears every baseline in its cleanup transaction (spec 2.3). */
export function clearDeliveryBaselines(tx) {
    tx.delete(bunnyDeliveryBaseline).run();
}
/** Every baseline row, for the Bunny initialization backup. */
export function exportDeliveryBaselines(db) {
    return db.select().from(bunnyDeliveryBaseline).all();
}
function readEntry(db, sessionId, key) {
    return db
        .select({ state: bunnyDeliveryBaseline.deliveredState })
        .from(bunnyDeliveryBaseline)
        .where(and(eq(bunnyDeliveryBaseline.sessionId, sessionId), eq(bunnyDeliveryBaseline.entryKey, key)))
        .get()?.state;
}
function hasMarker(db, sessionId) {
    return (db
        .select({ key: bunnyDeliveryBaseline.entryKey })
        .from(bunnyDeliveryBaseline)
        .where(and(eq(bunnyDeliveryBaseline.sessionId, sessionId), eq(bunnyDeliveryBaseline.entryKey, DELIVERY_BASELINE_MARKER)))
        .get() !== undefined);
}
function upsert(db, { sessionId, entryKey, state, nowMs }) {
    db.insert(bunnyDeliveryBaseline)
        .values({ sessionId, entryKey, deliveredState: state, updatedAtMs: nowMs })
        .onConflictDoUpdate({
        target: [bunnyDeliveryBaseline.sessionId, bunnyDeliveryBaseline.entryKey],
        set: { deliveredState: state, updatedAtMs: nowMs },
    })
        .run();
}
//# sourceMappingURL=delivery-baseline.repository.js.map