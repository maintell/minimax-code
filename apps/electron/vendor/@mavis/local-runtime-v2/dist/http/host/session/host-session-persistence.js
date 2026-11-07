import { initSessionFilesService } from '../../../infra/legacy-db/session-assets-session-files-service.js';
import { initSessionInputSummaryService } from '../../../infra/legacy-db/session-navigation-service.js';
import { InMemoryLocalSessionStore, LocalSessionController, LocalPiHistoryStore, toAgentMessages, } from '../../../service/session-system/index.js';
import { FileSessionLedgerStore } from '../../../infra/file/session-ledger.js';
import { SqliteLocalSessionProjectionStore } from '../../../infra/file/session-projection.js';
import { FileSessionSnapshotStore } from '../../../infra/file/session-snapshot.js';
import { LedgerBackedLocalSessionStore, LiveSessionWriter, } from '../../../infra/file/session-writer.js';
import { LegacyOpencodeStore } from '../../../infra/legacy-db/legacy-opencode-store.js';
import { LegacyOpencodeMigrator } from '../../../infra/legacy-db/legacy-opencode-migrator.js';
import { SqliteLegacyMigrationStore } from '../../../infra/legacy-db/legacy-migration-store.js';
export function initializeHostSessionProjections(input) {
    initSessionFilesService({
        dataDir: input.dataDir,
        hasMessageStore: input.hasMessageStore,
        ensureLegacyMessagesMigrated: input.ensureLegacyMessagesMigrated,
        getDisplayMessages: async (sessionId) => {
            const page = await input.conversation().query.listMessages(sessionId, { limit: 10_000 });
            return toAgentMessages(page.messages);
        },
    });
    initSessionInputSummaryService({
        dataDir: input.dataDir,
        ensureLegacyMessagesMigrated: input.ensureLegacyMessagesMigrated,
        metricsClient: input.metricsClient,
    });
}
/** Host 的历史存储只装配一次，所有读投影和迁移复用同一个 writer。 */
export function createHostSessionPersistence(input) {
    const { options, dataDir, nowMs } = input;
    const storeOptions = { nowMs, metricsClient: options.metricsClient };
    const ledgerStore = options.ledgerStore === false
        ? undefined
        : (options.ledgerStore ?? new FileSessionLedgerStore(dataDir, storeOptions));
    const hasMessageHistory = ledgerStore && options.messageStore;
    const projectionStore = options.projectionStore ??
        (hasMessageHistory
            ? new SqliteLocalSessionProjectionStore(dataDir)
            : undefined);
    const snapshotStore = options.snapshotStore ??
        (hasMessageHistory
            ? new FileSessionSnapshotStore(dataDir, storeOptions)
            : undefined);
    const sessionWriter = options.sessionWriter ??
        new LiveSessionWriter({
            ledgerStore,
            messageStore: options.messageStore,
            projectionStore,
            snapshotStore,
        });
    const controller = options.controller ??
        new LocalSessionController({
            store: new LedgerBackedLocalSessionStore({
                delegate: new InMemoryLocalSessionStore(),
                writer: sessionWriter,
            }),
            nowMs,
            assertSessionMutationAllowed: input.assertSessionMutationAllowed,
        });
    return { ledgerStore, snapshotStore, sessionWriter, controller };
}
export function createHostSessionHistory(input) {
    const { options, persistence, configGetter, nowMs } = input;
    const legacyMigrator = input.runtimeMode === 'clean' && !options.runtimeConversation
        ? new LegacyOpencodeMigrator({
            legacyStore: new LegacyOpencodeStore({ dataDir: configGetter().dataDir, nowMs }),
            migrationStore: new SqliteLegacyMigrationStore(configGetter().dataDir),
            controller: persistence.controller,
            messageStore: options.messageStore,
            sessionWriter: persistence.sessionWriter,
            primaryAgentName: input.primaryAgentName,
            defaultWorkspaceDir: input.defaultWorkspaceDir,
            dataDir: () => configGetter().dataDir,
            nowMs,
            metrics: options.metricsReporter,
        })
        : undefined;
    const piHistoryStore = new LocalPiHistoryStore({
        ledgerStore: persistence.ledgerStore,
        snapshotStore: persistence.snapshotStore,
        messageStore: options.messageStore,
        sessionWriter: persistence.sessionWriter,
        tokenUsageStore: input.tokenUsageStore,
        legacyMigrator,
        nowMs,
        piHistory: new Map(),
    });
    return { legacyMigrator, piHistoryStore };
}
//# sourceMappingURL=host-session-persistence.js.map