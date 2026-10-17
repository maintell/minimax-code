import { publishedChannelSessionsMigration } from './migration-0028-surface-channel-sessions.js';
/**
 * Some published PreviewTrain profiles recorded version 28 for an unrelated
 * Session history repair. Reapply the immutable Channel surface migration
 * under a new marker so those profiles converge without rewriting history.
 */
export const migration = {
    version: 33,
    name: 'converge_channel_session_project_schema_version_collision',
    up(database) {
        if (typeof publishedChannelSessionsMigration.up === 'string') {
            database.exec(publishedChannelSessionsMigration.up);
        }
        else {
            publishedChannelSessionsMigration.up(database);
        }
    },
};
//# sourceMappingURL=migration-0033-converge-channel-session-project-schema.js.map