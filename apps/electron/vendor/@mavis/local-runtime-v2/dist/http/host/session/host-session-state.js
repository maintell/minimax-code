import { attachMigrationMetadataToSerializedTree } from './host-legacy-helpers.js';
import { normalizeCleanLocalSession as normalizeCleanLocalSessionRecord, serializeMigrationMetadata, } from '../host-support.js';
import { serializeLocalSession, serializeLocalSessionTree, } from '../../../service/session-system/index.js';
export async function hostSerializeSession(host, session) {
    const serialized = await serializeLocalSession({
        session,
        dataDir: host.configGetter().dataDir,
        getSessionById: (sessionId) => host.getSessionById(sessionId),
    });
    serialized.pinned = (await host.readSessionPinned?.(session.sessionId)) ?? false;
    const migration = await host.legacyMigrator?.getMigrationRecordForLocalSession(session.sessionId);
    if (!migration)
        return serialized;
    return { ...serialized, migration: serializeMigrationMetadata(migration) };
}
export function hostSerializeSessions(host, sessions) {
    return Promise.all(sessions.map((session) => hostSerializeSession(host, session)));
}
export async function hostSerializeSessionTree(host, sessions, options) {
    const tree = await serializeLocalSessionTree({
        sessions,
        url: options.url,
        agentName: options.agentName,
        ...(options.agentNames ? { agentNames: options.agentNames } : {}),
        dataDir: host.configGetter().dataDir,
        getSessionById: options.getSessionById ?? ((sessionId) => host.getSessionById(sessionId)),
    });
    return attachMigrationMetadataToSerializedTree(host.legacyMigrator, tree);
}
export async function hostNormalizeCleanLocalSession(host, session) {
    return normalizeCleanLocalSessionRecord({
        session,
        legacyMigrator: host.legacyMigrator,
        normalizeStalePiSession: async (record) => record,
    });
}
//# sourceMappingURL=host-session-state.js.map