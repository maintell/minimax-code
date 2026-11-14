export const migration = {
    version: 63,
    name: 'hidden_session_purpose_index',
    up: `CREATE INDEX idx_local_runtime_sessions_hidden_purpose_v3
    ON local_runtime_sessions(purpose)
    WHERE columnar_version = 3 AND archived = 0 AND visibility = 'hidden';`,
};
//# sourceMappingURL=migration-0063-hidden-session-purpose-index.js.map