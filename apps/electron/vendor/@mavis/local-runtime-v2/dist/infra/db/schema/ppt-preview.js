import { integer, sqliteTable, text, primaryKey, index } from 'drizzle-orm/sqlite-core';
import { sessions } from './sessions.js';
export const pptPreviewArtifacts = sqliteTable('local_runtime_ppt_preview_artifacts', {
    artifactId: text('artifact_id').primaryKey(),
    sessionId: text('session_id')
        .notNull()
        .references(() => sessions.sessionId, { onDelete: 'cascade' }),
    artifactKey: text('artifact_key').notNull(),
    stateJson: text('state_json').notNull(),
    updatedAtMs: integer('updated_at_ms').notNull(),
}, (t) => [index('idx_ppt_preview_session').on(t.sessionId)]);
export const pptPreviewRequests = sqliteTable('local_runtime_ppt_preview_requests', {
    sessionId: text('session_id')
        .notNull()
        .references(() => sessions.sessionId, { onDelete: 'cascade' }),
    requestId: text('request_id').notNull(),
    fingerprint: text('fingerprint').notNull(),
    resultJson: text('result_json').notNull(),
    createdAtMs: integer('created_at_ms').notNull(),
}, (t) => [primaryKey({ columns: [t.sessionId, t.requestId] })]);
export const pptPreviewEvents = sqliteTable('local_runtime_ppt_preview_events', {
    cursor: integer('cursor').primaryKey({ autoIncrement: true }),
    sessionId: text('session_id')
        .notNull()
        .references(() => sessions.sessionId, { onDelete: 'cascade' }),
    artifactId: text('artifact_id').notNull(),
    eventJson: text('event_json').notNull(),
    createdAtMs: integer('created_at_ms').notNull(),
}, (t) => [index('idx_ppt_preview_events_session').on(t.sessionId, t.cursor)]);
//# sourceMappingURL=ppt-preview.js.map