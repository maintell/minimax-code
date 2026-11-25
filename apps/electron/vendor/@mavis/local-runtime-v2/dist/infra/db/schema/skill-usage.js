import { sql } from 'drizzle-orm';
import { check, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
/**
 * One row per Skill the catalog has listed or the model has loaded, keyed by the
 * normalized Skill name. `use_count` / `last_used_at_ms` rank descriptions when the
 * catalog budget is short; `first_seen_at_ms` is when the catalog first listed it.
 */
export const skillUsage = sqliteTable('local_runtime_skill_usage', {
    skillKey: text('skill_key').primaryKey(),
    useCount: integer('use_count').notNull().default(0),
    lastUsedAtMs: integer('last_used_at_ms').notNull().default(0),
    firstSeenAtMs: integer('first_seen_at_ms').notNull(),
}, (table) => [check('local_runtime_skill_usage_use_count', sql `${table.useCount} >= 0`)]);
//# sourceMappingURL=skill-usage.js.map