import { eq } from 'drizzle-orm';
import { sessionAutoResume } from '../../infra/db/schema/session-auto-resume.js';
/** Durable owner of the plan rows; the timers only mirror what is stored here. */
export class QuotaAutoResumePlanStore {
    db;
    constructor(db) {
        this.db = db;
    }
    list() {
        return this.db.select().from(sessionAutoResume).all().map(toPlan);
    }
    get(sessionId) {
        const row = this.db
            .select()
            .from(sessionAutoResume)
            .where(eq(sessionAutoResume.sessionId, sessionId))
            .get();
        return row ? toPlan(row) : undefined;
    }
    upsert(plan) {
        this.db
            .insert(sessionAutoResume)
            .values({
            sessionId: plan.sessionId,
            turnId: plan.turnId,
            resumeAtMs: plan.resumeAtMs,
            interruptedAtMs: plan.interruptedAtMs,
            autoRetryCount: plan.autoRetryCount,
            modelName: plan.modelName,
            updatedAtMs: plan.updatedAtMs,
        })
            .onConflictDoUpdate({
            target: sessionAutoResume.sessionId,
            set: {
                turnId: plan.turnId,
                resumeAtMs: plan.resumeAtMs,
                interruptedAtMs: plan.interruptedAtMs,
                autoRetryCount: plan.autoRetryCount,
                modelName: plan.modelName,
                updatedAtMs: plan.updatedAtMs,
            },
        })
            .run();
    }
    delete(sessionId) {
        this.db.delete(sessionAutoResume).where(eq(sessionAutoResume.sessionId, sessionId)).run();
    }
    deleteAll() {
        this.db.delete(sessionAutoResume).run();
    }
}
function toPlan(row) {
    return {
        sessionId: row.sessionId,
        turnId: row.turnId,
        resumeAtMs: row.resumeAtMs,
        interruptedAtMs: row.interruptedAtMs,
        autoRetryCount: row.autoRetryCount,
        modelName: row.modelName,
        updatedAtMs: row.updatedAtMs,
    };
}
//# sourceMappingURL=plan-store.js.map