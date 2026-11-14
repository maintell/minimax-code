import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
/**
 * One pending "continue after the Token Plan quota resets" plan per Session.
 *
 * The row is the whole waiting state: no Turn stays open while the account is
 * rate limited. `turn_id` is the failed Turn the plan continues, so a Session
 * the user took over (a newer Turn) can be recognized at fire time.
 * `model_name` is kept so a repeat limit can be re-planned against the same
 * model's window without re-resolving the Session's model.
 */
export const sessionAutoResume = sqliteTable('local_runtime_v2_session_auto_resume', {
    sessionId: text('session_id').primaryKey(),
    turnId: text('turn_id').notNull(),
    resumeAtMs: integer('resume_at_ms').notNull(),
    interruptedAtMs: integer('interrupted_at_ms').notNull(),
    autoRetryCount: integer('auto_retry_count').notNull().default(0),
    modelName: text('model_name').notNull(),
    updatedAtMs: integer('updated_at_ms').notNull(),
});
//# sourceMappingURL=session-auto-resume.js.map