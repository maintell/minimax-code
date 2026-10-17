import { LocalTurnDiffCapability, LocalTurnDiffRewindCapability, registerLocalAsset, registerSessionLocalAsset, resolveSessionLocalAsset, SqliteSessionAssetStore, SqliteLocalCommunicationMessageStore, SqliteLocalTurnDiffStore, readPreviewTrainPinnedItemsOrderPreference, } from '@mavis/local-runtime';
/** Constructs concrete v1 stores once and exposes only Session-owner-shaped capabilities. */
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
                const record = await resolveSessionLocalAsset({
                    dataDir: host.dataDir,
                    sessionId,
                    assetId,
                });
                return record ? toSessionAssetResolution(record) : undefined;
            },
        },
        diff: {
            capability: diffCapability,
            rewind: diffRewind,
            inputNavigation: {
                listSessionDiffs: (sessionId) => diffStore.listFilePathsBySession(sessionId),
            },
            pruneExpired: async (cutoffMs, batchSize) => {
                await diffStore.pruneExpired(cutoffMs, batchSize);
            },
            deleteSession: (sessionId) => diffStore.deleteSession(sessionId),
        },
        communication: {
            deleteSession: (sessionId) => communicationStore.deleteSession(sessionId),
        },
        channelBindings: {
            listSessionIds: () => api.listChannelSessionIds(),
            deleteSession: async (sessionId) => {
                await api.deleteChannelBindingsForSession(sessionId);
            },
        },
        questionnaires: {
            copyPendingForFork: (input) => api.copyPendingQuestionnaireForFork(input),
            deleteSession: async (sessionId) => {
                await api.deleteQuestionnairesForSession(sessionId);
            },
        },
        permissions: {
            copyForFork: (input) => api.copyPermissionStateForFork(input),
            deleteSession: (sessionId) => api.deletePermissionStateForSession(sessionId),
        },
        goals: {
            deleteSession: async (sessionId) => {
                await api.deleteThreadGoalForSession(sessionId);
            },
            getBySession: async (sessionId) => {
                const goal = await api.threadGoal.store.getBySession(sessionId);
                return goal ? { goalId: goal.goalId, status: goal.status } : undefined;
            },
            classifyQueuedItem: (item, hasPendingPlan) => api.classifyThreadGoalQueuedItem(item, hasPendingPlan),
            prepareTurnAdmission: (input) => api.prepareThreadGoalTurnAdmission(input),
            pauseActiveForAbort: (sessionId) => api.threadGoal.pauseActiveGoalForAbort(sessionId),
            bindAutomationOwnerConflictReader: (reader) => api.bindThreadGoalAutomationOwnerConflictReader(reader),
            bindVerifier: (verifier, transcriptWindowReader) => api.bindThreadGoalVerifier(verifier, transcriptWindowReader),
            createSubagentExecution: (registry) => api.createThreadGoalVerifierExecution(registry),
        },
        workspace: {
            defaultDirectory: () => api.resolveDefaultWorkspaceDir(),
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
//# sourceMappingURL=session.js.map