import { LocalTurnDiffCapability, LocalTurnDiffRewindCapability } from '../../service/turn-system/index.js';
import { registerLocalAsset, registerSessionLocalAsset, resolveSessionLocalAsset } from '../../infra/file/assets-store.js';
import { SqliteSessionAssetStore } from '../../infra/legacy-db/session-assets-session-asset-store.js';
import { SqliteLocalCommunicationMessageStore, SqliteLocalTurnDiffStore } from '../../infra/legacy-db/sqlite-persistence.js';
import { readPreviewTrainPinnedItemsOrderPreference } from '../../infra/legacy-db/pin-legacy-preferences.js';
import { managedBackendRoutingHeaders } from '../../infra/config/routing-headers.js';
/** Constructs historical stores once and exposes only Session-owner-shaped capabilities. */
export function createV1SessionCompatibility(host) {
    const api = host.apiHost;
    const diffStore = new SqliteLocalTurnDiffStore(host.dataDir);
    const communicationStore = new SqliteLocalCommunicationMessageStore(host.dataDir);
    const sessionAssets = new SqliteSessionAssetStore(host.dataDir);
    const diffCapability = new LocalTurnDiffCapability(diffStore, api.nowMs);
    const diffRewind = new LocalTurnDiffRewindCapability(diffStore);
    return {
        legacyMigration: {
            primaryAgentName: api.agentName,
            assets: {
                register: (input) => registerLocalAsset({ ...input, dataDir: host.dataDir }),
            },
            readPinnedItemsOrder: () => readPreviewTrainPinnedItemsOrderPreference(host.dataDir),
        },
        bindSessionPinReader: (reader) => {
            api.readSessionPinned = reader;
        },
        canvasAssets: {
            importDeliverable: async ({ sessionId, path }) => {
                if (!(await isRegisteredDeliverablePath(sessionAssets, sessionId, path)))
                    return undefined;
                return toSessionAssetResolution(await registerSessionLocalAsset({
                    dataDir: host.dataDir,
                    sessionId,
                    sourcePath: path,
                    generatedBy: 'canvas',
                }));
            },
            importExternal: async ({ sessionId, path }) => {
                try {
                    return toSessionAssetResolution(await registerSessionLocalAsset({
                        dataDir: host.dataDir,
                        sessionId,
                        sourcePath: path,
                        generatedBy: 'canvas-external-file',
                    }));
                }
                catch {
                    return undefined;
                }
            },
            resolve: async ({ sessionId, assetId }) => {
                const record = await resolveSessionLocalAsset({ dataDir: host.dataDir, sessionId, assetId });
                return record ? toSessionAssetResolution(record) : undefined;
            },
            importGenerated: async ({ sessionId, path, fileName, mimeType, generatedBy }) => toSessionAssetResolution(await registerSessionLocalAsset({
                dataDir: host.dataDir,
                sessionId,
                sourcePath: path,
                fileName,
                mimeType,
                kind: 'image',
                generatedBy,
            })),
        },
        diff: {
            capability: diffCapability,
            rewind: diffRewind,
            inputNavigation: { listSessionDiffs: (sessionId) => diffStore.listFilePathsBySession(sessionId) },
            pruneExpired: async (cutoffMs, batchSize) => { await diffStore.pruneExpired(cutoffMs, batchSize); },
            deleteSession: (sessionId) => diffStore.deleteSession(sessionId),
        },
        communication: { deleteSession: (sessionId) => communicationStore.deleteSession(sessionId) },
        channelBindings: {
            listSessionIds: () => api.listChannelSessionIds(),
            deleteSession: async (sessionId) => { await api.deleteChannelBindingsForSession(sessionId); },
        },
        questionnaires: {
            copyPendingForFork: (input) => api.copyPendingQuestionnaireForFork(input),
            reopenAfterSafetyRecall: (input) => api.reopenQuestionnaireAfterSafetyRecall(input),
            deleteSession: async (sessionId) => { await api.deleteQuestionnairesForSession(sessionId); },
        },
        permissions: {
            copyForFork: (input) => api.copyPermissionStateForFork(input),
            deleteSession: (sessionId) => api.deletePermissionStateForSession(sessionId),
        },
        workspace: { defaultDirectory: () => api.resolveDefaultWorkspaceDir() },
        mediaIdentityCloud: {
            authContextGetter: () => api.authContextGetter?.(),
            routingHeadersGetter: () => managedBackendRoutingHeaders(api.routingContextGetter?.()),
            fetchImpl: api.fetchImpl ?? globalThis.fetch,
        },
    };
}
async function isRegisteredDeliverablePath(store, sessionId, path) {
    const expectedPath = path.trim();
    if (!expectedPath)
        return false;
    await store.ensureIndexed(sessionId);
    let cursor;
    do {
        const page = await store.listAssets(sessionId, { limit: 1000, cursor });
        if (page.assets.some((asset) => asset.path.trim() === expectedPath))
            return true;
        cursor = page.nextCursor;
    } while (cursor);
    return false;
}
function toSessionAssetResolution(input) {
    return {
        assetId: input.assetId,
        fileName: input.fileName,
        mimeType: input.mimeType,
        bytes: input.bytes,
        sha256: input.sha256,
        absolutePath: input.absolutePath,
    };
}
//# sourceMappingURL=session-capabilities.js.map