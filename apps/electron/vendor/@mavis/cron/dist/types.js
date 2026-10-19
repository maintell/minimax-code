/**
 * Cron config schemas + types — canonical location.
 *
 * Schemas live in agent-core so cron orchestration logic can validate
 * inputs without crossing the package boundary. Daemon's
 * `store/types.ts` re-exports these names for backward compatibility
 * with API schemas, store impls, and existing tests.
 */
import { z } from 'zod';
export const ActiveHoursSchema = z.object({
    start: z.string().regex(/^\d{2}:\d{2}$/, 'Must be HH:MM format'),
    end: z.string().regex(/^\d{2}:\d{2}$/, 'Must be HH:MM format'),
});
/**
 * Canonical session config schema for **input surfaces** (HTTP API request
 * bodies, CLI parsing). The legacy 'main' alias is rejected here per
 * session-rename narrowing — clients must send 'root'.
 *
 * For reading legacy on-disk cron `.md` files written before the rename,
 * use `StoredSessionConfigSchema` below, which still accepts 'main' and
 * normalizes it to 'root'.
 */
export const SessionConfigSchema = z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('root') }),
    z.object({ mode: z.literal('sessionId'), sessionId: z.string().min(1) }),
    z.object({
        mode: z.literal('new'),
        /**
         * How many completed sessions to keep visible per cron task.
         * - undefined (omitted): use default (3)
         * - null: keep all sessions (no archiving)
         * - number >= 1: keep N most recent sessions, archive older ones
         */
        keepSessions: z.number().int().min(1).nullable().optional(),
    }),
]);
/**
 * Storage-side schema: same as input, but additionally accepts the legacy
 * `mode: 'main'` alias and normalizes it to `mode: 'root'` after parse.
 * Used only for reading legacy on-disk cron `.md` files written before the
 * session-rename. Writers always emit canonical `mode: 'root'`.
 */
export const StoredSessionConfigSchema = z
    .discriminatedUnion('mode', [
    z.object({ mode: z.literal('root') }),
    z.object({ mode: z.literal('main') }), // legacy on-disk alias, normalized below
    z.object({ mode: z.literal('sessionId'), sessionId: z.string().min(1) }),
    z.object({
        mode: z.literal('new'),
        keepSessions: z.number().int().min(1).nullable().optional(),
    }),
])
    .transform((parsed) => {
    if (parsed.mode === 'main') {
        return { mode: 'root' };
    }
    return parsed;
});
export const DeliveryConfigSchema = z
    .object({
    /** Channel client name to deliver to (e.g., 'my-feishu-bot'). */
    channel: z.string().min(1),
    /** Target chat ID within the channel. */
    chatId: z.string().min(1),
})
    .optional();
/**
 * Frontmatter-only schema for the new `.md` cron format.
 * The `prompt` field lives in the markdown body, not in frontmatter.
 *
 * Uses `StoredSessionConfigSchema` so that legacy on-disk files written
 * with `session.mode: 'main'` still parse — the schema transforms 'main'
 * to canonical 'root' at parse time. Writers always emit canonical 'root'.
 */
export const CronFrontmatterSchema = z.object({
    name: z.string().optional(),
    disabled: z.boolean().default(false),
    schedule: z.string().min(1),
    scheduleType: z.enum(['cron', 'once']).default('cron'),
    runAtMs: z.number().int().positive().optional(),
    deleteAfterRun: z.boolean().optional(),
    timezone: z.string().optional(),
    activeHours: ActiveHoursSchema.optional(),
    session: StoredSessionConfigSchema.default({ mode: 'new' }),
    /** @deprecated Legacy IM auto-delivery preference; never writes to Root. */
    report_to_root: z.boolean().optional(),
    /** @deprecated Legacy IM auto-delivery preference; never writes to Root. */
    report_to_main: z.boolean().optional(),
});
export const CronConfigSchema = z.object({
    disabled: z.boolean().default(false),
    schedule: z.string().min(1),
    scheduleType: z.enum(['cron', 'once']).default('cron'),
    runAtMs: z.number().int().positive().optional(),
    deleteAfterRun: z.boolean().optional(),
    timezone: z.string().optional(),
    activeHours: ActiveHoursSchema.optional(),
    prompt: z.string().min(1),
    session: StoredSessionConfigSchema.default({ mode: 'new' }),
    delivery: DeliveryConfigSchema,
    /** @deprecated Legacy IM auto-delivery preference; never writes to Root. */
    report_to_root: z.boolean().optional(),
    /** @deprecated Legacy IM auto-delivery preference; never writes to Root. */
    report_to_main: z.boolean().optional(),
});
/**
 * Normalize a SessionConfig.
 *
 * Post session-rename narrowing: this is an identity function. Both
 * `SessionConfigSchema` (input) and `StoredSessionConfigSchema` (storage,
 * via `.transform()`) already produce a `SessionConfig` whose `mode` is
 * never 'main'. Kept as a thin helper for callers that want a clear
 * "I assume this is normalized" assertion site.
 */
export function normalizeSessionConfig(cfg) {
    return cfg;
}
/**
 * Read the retired root-report flag from legacy config. The executor uses it
 * only to preserve existing bound-channel auto-delivery opt-in/opt-out state.
 */
export function resolveReportToRoot(cfg) {
    if (cfg.report_to_root !== undefined)
        return cfg.report_to_root;
    return cfg.report_to_main;
}
//# sourceMappingURL=types.js.map